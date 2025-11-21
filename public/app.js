const historyEl = document.getElementById('history');
const chatStream = document.getElementById('chat-stream');
const form = document.getElementById('chat-form');
const textarea = document.getElementById('chat-textarea');
const newChatBtn = document.getElementById('new-chat');
const sendBtn = document.getElementById('send-button');
const deepDiveBtn = document.getElementById('deep-dive');
const parentChatBtn = document.getElementById('parent-chat-btn');
const contextToast = document.getElementById('context-toast');
const graphCurtain = document.getElementById('graph-curtain');
const graphToggle = document.getElementById('graph-toggle');
const graphSvg = document.getElementById('graph-svg');
const graphContainer = document.getElementById('graph-container');

// State
let conversations = [];
let activeConversation = null;
const GRAPH_MARGIN = 60;
const WHEEL_DEADZONE = 1.5;
let graphPan = { x: 0, y: 0 };
let graphPanInitialized = false;
let graphDragInitialized = false;
let graphPanLimits = {
  minX: 0,
  maxX: 0,
  minY: 0,
  maxY: 0
};
const markdownParser = window.marked || null;
if (markdownParser?.setOptions) {
  markdownParser.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false
  });
}
  const htmlSanitizer = window.DOMPurify || null;
  const MARKDOWN_SANITIZE_CONFIG = {
    ADD_ATTR: ['data-highlight-id', 'title', 'class', 'style'],
    ADD_TAGS: ['mark', 'button']
  };

// --- Initialization ---
(async () => {
  // Clear local storage as requested
  localStorage.removeItem('deepminimal-history');
  
  // Load from server
  await loadSessions();
  
  if (conversations.length === 0) {
    activeConversation = createEmptyConversation();
    conversations = [activeConversation];
    // We don't save immediately to avoid cluttering disk with empty chats until used
  } else {
    // Find a suitable active conversation or default to first root
    // Currently just picking first loaded one, usually a root
    activeConversation = conversations[0];
  }
  
  updateHistory();
  renderConversation();
  updateParentChatButton();
})();

// --- Data Helpers ---

function createEmptyConversation() {
  return {
    id: crypto.randomUUID(),
    title: 'Новый чат',
    messages: [],
    pendingFragments: [],
    parentId: null,
    isExpanded: true,
    summary: '',
    originTerm: null,
    lastSummarizedMessageCount: 0
  };
}

// --- API Calls ---

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (res.ok) {
      conversations = await res.json();
    }
  } catch (err) {
    console.error('Failed to load sessions', err);
  }
}

async function saveSession(session) {
  try {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(session)
    });
  } catch (err) {
    console.error('Failed to save session', err);
  }
}

async function triggerSummarization(sessionId) {
  const session = conversations.find(c => c.id === sessionId);
  if (!session || session.messages.length === 0) return;
  
  // Check if summary is already up to date
  if (session.messages.length <= (session.lastSummarizedMessageCount || 0)) {
    console.log('Summary already up to date, skipping...');
    return;
  }

  try {
    showContextToast(true);
    const res = await fetch(`/api/sessions/${sessionId}/summarize`, {
      method: 'POST'
    });
    
    if (res.ok) {
      const data = await res.json();
      if (!data.skipped) {
        session.summary = data.summary;
        session.lastSummarizedMessageCount = session.messages.length;
        // Save updated session
        await saveSession(session);
      }
    }
  } catch (err) {
    console.error('Failed to summarize session', err);
  } finally {
    showContextToast(false);
  }
}

// --- UI Logic ---

function showContextToast(show) {
  if (show) {
    contextToast.hidden = false;
  } else {
    // Small delay for smooth UX
    setTimeout(() => {
      contextToast.hidden = true;
    }, 300);
  }
}

async function switchConversation(newConversation) {
  // Only trigger summarization if we're actually switching AND there are new messages
  if (activeConversation && 
      activeConversation.id !== newConversation.id && 
      activeConversation.messages.length > 0 &&
      activeConversation.messages.length > (activeConversation.lastSummarizedMessageCount || 0)) {
    // Trigger summary for the OLD conversation (only if new messages exist)
    // Don't await it, let it run in background
    triggerSummarization(activeConversation.id);
  }

  activeConversation = newConversation;
  updateHistory();
  renderConversation();
  updateParentChatButton();
}

const textareaAutoResize = () => {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
};
textarea.addEventListener('input', textareaAutoResize);

newChatBtn.addEventListener('click', async () => {
  const newChat = createEmptyConversation();
  conversations = [newChat, ...conversations];
  await switchConversation(newChat);
  textarea.focus();
});

parentChatBtn.addEventListener('click', () => {
  if (activeConversation?.parentId) {
    const parentConversation = conversations.find(c => c.id === activeConversation.parentId);
    if (parentConversation) {
      switchConversation(parentConversation);
    }
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = textarea.value.trim();
  if (!content) return;

  // If this is a new chat (not saved yet), save it now
  const isNew = !conversations.find(c => c.id === activeConversation.id && c.messages.length > 0);
  
  appendMessage({ role: 'user', content });
  textarea.value = '';
  textareaAutoResize();
  setLoading(true);

  // Update title if first message
  if (activeConversation.messages.length === 1 && activeConversation.title === 'Новый чат') {
    activeConversation.title = content.slice(0, 32);
  }
  
  // Save state to disk
  await saveSession(activeConversation);
  updateHistory(); // refresh titles

  const payload = [...activeConversation.messages];

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        messages: payload,
        sessionId: activeConversation.id
      })
    });

    if (!response.ok) {
      throw new Error('Сервер недоступен');
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message?.content || 'Нет ответа';
    appendMessage({ role: 'assistant', content: message });
    
    // Save assistant reply
    await saveSession(activeConversation);
  } catch (error) {
    appendMessage({ role: 'assistant', content: '⚠️ Ошибка: ' + error.message });
  } finally {
    setLoading(false);
  }
});

textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

chatStream.addEventListener('mouseup', handleSelection);
chatStream.addEventListener('click', handleHighlightClick);
deepDiveBtn.addEventListener('click', handleDeepDive);
deepDiveBtn.addEventListener('click', handleDeepDive);
deepDiveBtn.addEventListener('click', handleDeepDive);

function appendMessage(message) {
  const messageEntry = {
    id: message.id ?? crypto.randomUUID(),
    role: message.role,
    content: message.content,
    highlights: message.highlights ?? []
  };
  activeConversation.messages.push(messageEntry);
  renderConversation();
  scrollToBottom();
}

function renderConversation() {
  chatStream.replaceChildren(
    ...activeConversation.messages.map((message) => {
      const bubble = document.createElement('div');
      bubble.className = `message message--${message.role === 'user' ? 'user' : 'bot'}`;
      bubble.dataset.messageId = message.id;
      const html = renderMessageHtml(message);
      const body = document.createElement('div');
      body.className = 'message__body';
      if (html !== null) {
        body.innerHTML = html;
        renderMathIfAvailable(body);
        if (message.role === 'assistant') {
          applyHighlightsToElement(body, message);
        }
      } else {
        body.textContent = message.content;
      }
      bubble.appendChild(body);
      return bubble;
    })
  );
  toggleDeepDiveButton();
}

function updateHistory() {
  const roots = conversations.filter(c => !c.parentId);
  
  const treeContainer = document.createElement('div');
  treeContainer.className = 'history-tree';

  roots.forEach(root => {
    treeContainer.appendChild(renderTreeItem(root));
  });

  historyEl.replaceChildren(treeContainer);
}

function renderTreeItem(conversation) {
  const group = document.createElement('div');
  group.className = 'history-group';
  
  const row = document.createElement('div');
  row.className = 'history-row' + (conversation.id === activeConversation.id ? ' is-active' : '');
  
  row.addEventListener('click', (e) => {
    if (e.target.closest('.toggle-btn')) return;
    switchConversation(conversation);
  });

  const children = conversations.filter(c => c.parentId === conversation.id);
  const hasChildren = children.length > 0;

  if (hasChildren) {
    const toggle = document.createElement('button');
    toggle.className = 'toggle-btn' + (conversation.isExpanded ? '' : ' is-collapsed');
    toggle.innerHTML = '▼'; 
    toggle.onclick = async (e) => {
      e.stopPropagation();
      conversation.isExpanded = !conversation.isExpanded;
      await saveSession(conversation); 
      updateHistory();
    };
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('div');
    spacer.className = 'toggle-spacer';
    row.appendChild(spacer);
  }

  const title = document.createElement('span');
  title.className = 'history-item-title';
  title.textContent = conversation.title;
  row.appendChild(title);
  
  group.appendChild(row);

  if (hasChildren) {
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'history-children' + (conversation.isExpanded ? '' : ' is-hidden');
    
    children.forEach(child => {
      childrenContainer.appendChild(renderTreeItem(child));
    });
    
    group.appendChild(childrenContainer);
  }

  return group;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    chatStream.scrollTop = chatStream.scrollHeight;
  });
}

function setLoading(state) {
  sendBtn.disabled = state;
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const bubble = ancestor instanceof Element
    ? ancestor.closest('.message--bot')
    : ancestor?.parentElement?.closest('.message--bot');

  if (!bubble || !bubble.dataset.messageId) {
    selection.removeAllRanges();
    return;
  }

  if (!bubble.contains(range.startContainer) || !bubble.contains(range.endContainer)) {
    selection.removeAllRanges();
    return;
  }

  const message = activeConversation.messages.find((msg) => msg.id === bubble.dataset.messageId);
  if (!message) {
    selection.removeAllRanges();
    return;
  }

  if (message.role !== 'assistant') {
    selection.removeAllRanges();
    return;
  }

  const offsets = getDisplayOffsets(range, bubble);
  if (!offsets) {
    selection.removeAllRanges();
    return;
  }

  if (message.highlights?.some((highlight) => highlight.start === offsets.start && highlight.end === offsets.end)) {
    selection.removeAllRanges();
    return;
  }

  const fragmentText = selection.toString().trim();
  if (!fragmentText) {
    selection.removeAllRanges();
    return;
  }

  message.highlights = message.highlights || [];
  const highlightId = crypto.randomUUID();
  message.highlights.push({
    id: highlightId,
    start: offsets.start,
    end: offsets.end,
    displayStart: offsets.start,
    displayEnd: offsets.end,
    text: fragmentText
  });

  activeConversation.pendingFragments = activeConversation.pendingFragments || [];
  activeConversation.pendingFragments.push({
    id: highlightId,
    messageId: message.id,
    text: fragmentText
  });

  saveSession(activeConversation);

  renderConversation();
  selection.removeAllRanges();
}

function handleHighlightClick(e) {
  // Handle remove button click
  const removeBtn = e.target.closest('.highlight-remove-btn');
  if (removeBtn) {
    e.preventDefault();
    e.stopPropagation();
    
    const highlightId = removeBtn.dataset.highlightId;
    if (!highlightId) return;
    
    const bubble = removeBtn.closest('.message--bot');
    if (!bubble || !bubble.dataset.messageId) return;
    
    const message = activeConversation.messages.find(msg => msg.id === bubble.dataset.messageId);
    if (!message) return;
    
    // Remove highlight from message
    message.highlights = message.highlights?.filter(h => h.id !== highlightId) || [];
    
    // Remove from pending fragments
    activeConversation.pendingFragments = activeConversation.pendingFragments?.filter(f => f.id !== highlightId) || [];
    
    saveSession(activeConversation);
    renderConversation();
    return;
  }
  
  // Handle click on highlighted text
  const mark = e.target.closest('mark[data-highlight-id]');
  if (!mark) return;
  
  const highlightId = mark.dataset.highlightId;
  if (!highlightId) return;
  
  const bubble = mark.closest('.message--bot');
  if (!bubble || !bubble.dataset.messageId) return;
  
  const message = activeConversation.messages.find(msg => msg.id === bubble.dataset.messageId);
  if (!message) return;
  
  // Find the highlight to get the text
  const highlight = message.highlights?.find(h => h.id === highlightId);
  if (!highlight) return;
  const highlightText = highlight.text ||
    message.content.slice(
      Math.max(0, highlight.start || 0),
      Math.max(0, highlight.end || 0)
    ).trim();
  
  // Find child conversation with matching originTerm
  const childConversation = conversations.find(c => 
    c.parentId === activeConversation.id && 
    c.originTerm === highlightText
  );
  
  if (childConversation) {
    e.preventDefault();
    mark.style.cursor = 'pointer';
    switchConversation(childConversation);
  }
}

function getDisplayOffsets(range, container) {
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let cursor = 0;
  let start = null;
  let end = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('.highlight-remove-btn')) {
      continue; // ignore text inside control buttons
    }
    const length = node.textContent.length;
    if (node === range.startContainer) {
      start = cursor + range.startOffset;
    }
    if (node === range.endContainer) {
      end = cursor + range.endOffset;
    }
    cursor += length;
  }

  if (start === null || end === null) return null;
  const normalizedStart = Math.min(start, end);
  const normalizedEnd = Math.max(start, end);
  if (normalizedStart === normalizedEnd) return null;
  return { start: normalizedStart, end: normalizedEnd };
}

function renderMessageHtml(message) {
  const parser = markdownParser;
  const purifier = htmlSanitizer;
  const supportsMarkdown = Boolean(parser && purifier);
  const baseText = message.content || '';
  
  const needsLegacyHighlighting = message.role === 'assistant' &&
    message.highlights?.some(h => h.displayStart == null);
  
  if (supportsMarkdown) {
    let markdownSource = baseText;
    if (needsLegacyHighlighting) {
      markdownSource = buildHighlightedMarkdown(baseText, message.highlights);
    }
    const rawHtml = parser.parse(markdownSource);
    return purifier.sanitize(rawHtml, MARKDOWN_SANITIZE_CONFIG);
  }
  
  if (needsLegacyHighlighting) {
    return renderLegacyHighlightedText(baseText, message.highlights);
  }
  
  return escapeHtml(baseText).replace(/\n/g, '<br>');
}

function buildHighlightedMarkdown(text, highlights) {
  text = text ?? '';
  const legacy = (highlights || []).filter(h => h.displayStart == null && Number.isFinite(h.start) && Number.isFinite(h.end));
  if (!legacy.length) return text;
  const safeHighlights = [...legacy].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let result = '';
  const pendingSet = new Set((activeConversation.pendingFragments || []).map(f => f.id));

  safeHighlights.forEach((highlight) => {
    const start = Math.max(0, Math.min(highlight.start, text.length));
    const end = Math.max(start, Math.min(highlight.end, text.length));
    const fragment = text.slice(start, end);
    const trimmed = fragment.trim();
    
    const hasChildChat = conversations.some(c =>
      c.parentId === activeConversation.id &&
      c.originTerm === trimmed
    );
    const isPending = pendingSet.has(highlight.id);
    const clickableClass = hasChildChat ? ' highlight-clickable' : '';
    const pendingClass = isPending ? ' highlight--pending' : '';
    const title = hasChildChat ? 'Перейти в дочерний чат' : '';
    
    result += text.slice(cursor, start);
    result += `<mark data-highlight-id="${highlight.id}" class="highlight${clickableClass}${pendingClass}" title="${title}">${fragment}`;
    if (isPending) {
      result += `<button class="highlight-remove-btn" data-highlight-id="${highlight.id}" title="Отменить выделение">×</button>`;
    }
    result += `</mark>`;
    cursor = end;
  });

  result += text.slice(cursor);
  return result;
}

function renderLegacyHighlightedText(text, highlights) {
  text = text ?? '';
  const safeHighlights = [...highlights].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = '';

  safeHighlights.forEach((highlight) => {
    const start = Math.max(0, Math.min(highlight.start, text.length));
    const end = Math.max(start, Math.min(highlight.end, text.length));
    const highlightText = text.slice(start, end).trim();
    
    const hasChildChat = conversations.some(c => 
      c.parentId === activeConversation.id && 
      c.originTerm === highlightText
    );
    const isPending = activeConversation.pendingFragments?.some(f => f.id === highlight.id);
    
    const clickableClass = hasChildChat ? ' highlight-clickable' : '';
    const pendingClass = isPending ? ' highlight--pending' : '';
    const title = hasChildChat ? 'Перейти в дочерний чат' : '';
    
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark data-highlight-id="${highlight.id}" class="highlight${clickableClass}${pendingClass}" title="${title}">${escapeHtml(text.slice(start, end))}`;
    if (isPending) {
      html += `<button class="highlight-remove-btn" data-highlight-id="${highlight.id}" title="Отменить выделение">×</button>`;
    }
    html += `</mark>`;
    cursor = end;
  });

  html += escapeHtml(text.slice(cursor));
  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toggleDeepDiveButton() {
  // Removed logic as deepDiveBtn is now part of layout and handled by HTML/CSS visibility
  const count = activeConversation.pendingFragments?.length || 0;
  if (deepDiveBtn) {
    if (count > 0) {
      deepDiveBtn.hidden = false;
      deepDiveBtn.textContent = `Углубиться в термины (${count})`;
    } else {
      deepDiveBtn.hidden = true;
    }
  }
}

function updateParentChatButton() {
  if (!parentChatBtn || !activeConversation) return;
  
  if (activeConversation.parentId) {
    parentChatBtn.hidden = false;
  } else {
    parentChatBtn.hidden = true;
  }
}

async function handleDeepDive() {
  const fragments = activeConversation.pendingFragments || [];
  if (!fragments.length) return;

  const newConversations = fragments.map((fragment) => ({
    id: crypto.randomUUID(),
    title: fragment.text.slice(0, 32) || 'Термин',
    pendingFragments: [],
    parentId: activeConversation.id,
    originTerm: fragment.text,
    isExpanded: true,
    summary: '',
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `${fragment.text}: Вам не понятен термин целиком или есть конкретный вопрос по этому фрагменту?`,
        highlights: []
      }
    ]
  }));

  activeConversation.pendingFragments = [];
  activeConversation.isExpanded = true; 
  
  await saveSession(activeConversation);
  await Promise.all(newConversations.map(saveSession));
  
  conversations = [...conversations, ...newConversations];

  // Trigger summary for parent before switching to child
  // Only if parent has NEW messages since last summarization
  if (activeConversation.messages.length > 0 &&
      activeConversation.messages.length > (activeConversation.lastSummarizedMessageCount || 0)) {
    triggerSummarization(activeConversation.id);
  }

  updateHistory();
  activeConversation = newConversations[0];
  renderConversation();
  updateParentChatButton();
}

// --- Graph Visualization ---

graphToggle.addEventListener('click', () => {
  graphCurtain.classList.toggle('is-open');
  if (graphCurtain.classList.contains('is-open')) {
    renderGraph();
    enableGraphDragging();
  }
});

function renderGraph() {
  if (!graphContainer) return;
  const containerWidth = graphContainer.clientWidth;
  const containerHeight = graphContainer.clientHeight;
  
  // Clear existing content
  graphSvg.innerHTML = '';
  
  // Build tree structure
  const roots = conversations.filter(c => !c.parentId);
  if (roots.length === 0) return;
  
  // Layout configuration
  const nodeWidth = 140;
  const nodeHeight = 60;
  const levelHeight = 100;
  const minDistance = nodeWidth + 20; // distance between centers
  
  // Calculate positions for all nodes
  const nodePositions = new Map();
  const levelNodes = new Map(); // Track nodes by level
  
  // Phase 1: Initial layout relative to parents
  function layoutTreeRelative(node, level, parentX) {
    if (!levelNodes.has(level)) {
      levelNodes.set(level, []);
    }
    
    const children = conversations.filter(c => c.parentId === node.id);
    const childCount = children.length;
    const y = 60 + level * levelHeight;
    
    // Position this node under parent (or at center for root)
    const x = parentX !== undefined ? parentX : containerWidth / 2;
    
    const nodeData = { node, x, y, children, level };
    nodePositions.set(node.id, nodeData);
    levelNodes.get(level).push(nodeData);
    
    // Layout children relative to this node
    if (childCount === 0) {
      // No children, nothing to do
    } else if (childCount === 1) {
      // Single child directly under parent
      layoutTreeRelative(children[0], level + 1, x);
    } else {
      // Multiple children - distribute evenly around parent center
      const childSpacing = nodeWidth + 20;
      const totalWidth = (childCount - 1) * childSpacing;
      const startX = x - totalWidth / 2;
      
      children.forEach((child, idx) => {
        const childX = startX + idx * childSpacing;
        layoutTreeRelative(child, level + 1, childX);
      });
    }
  }
  
  // Layout all roots
  if (roots.length === 1) {
    layoutTreeRelative(roots[0], 0, containerWidth / 2);
  } else {
    const rootSpacing = nodeWidth + 40;
    const totalWidth = (roots.length - 1) * rootSpacing;
    const startX = (containerWidth - totalWidth) / 2;
    roots.forEach((root, idx) => {
      layoutTreeRelative(root, 0, startX + idx * rootSpacing);
    });
  }
  
  // Helper to shift entire subtree recursively
  function shiftSubtree(nodeId, deltaX) {
    const data = nodePositions.get(nodeId);
    if (!data) return;
    
    data.children.forEach(child => {
      const childData = nodePositions.get(child.id);
      if (childData) {
        childData.x += deltaX;
        shiftSubtree(child.id, deltaX);
      }
    });
  }

  // Phase 2: Check for collisions and redistribute if needed
  levelNodes.forEach((nodes, level) => {
    if (nodes.length < 2) return;
    
    // Check if any pair is too close
    let hasCollision = false;
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dist = Math.abs(nodes[i].x - nodes[j].x);
        if (dist < minDistance) {
          hasCollision = true;
          break;
        }
      }
      if (hasCollision) break;
    }
    
    // If collision detected, redistribute all nodes on this level evenly
    if (hasCollision) {
      // Calculate center of current positions
      const currentCenterX = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length;
      
      const nodeSpacing = Math.max(minDistance, nodeWidth + 20);
      const totalWidth = (nodes.length - 1) * nodeSpacing;
      const startX = currentCenterX - totalWidth / 2;
      
      nodes.sort((a, b) => a.x - b.x); // Sort by current x position
      nodes.forEach((nodeData, idx) => {
        const newX = startX + idx * nodeSpacing;
        const deltaX = newX - nodeData.x;
        
        nodeData.x = newX;
        
        // If node moved, shift its entire subtree
        if (Math.abs(deltaX) > 0.1) {
          shiftSubtree(nodeData.node.id, deltaX);
        }
      });
    }
  });
  
  // Calculate actual dimensions needed for SVG
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  nodePositions.forEach(pos => {
    minX = Math.min(minX, pos.x - nodeWidth/2);
    maxX = Math.max(maxX, pos.x + nodeWidth/2);
    maxY = Math.max(maxY, pos.y + nodeHeight/2);
  });
  
  // Shift all nodes if tree goes off-screen to the left
  const padding = 40;
  if (minX < padding) {
    const shiftX = padding - minX;
    nodePositions.forEach(pos => {
      pos.x += shiftX;
    });
    maxX += shiftX;
  }
  
  // Set SVG size
  // Ensure SVG is at least the size of container
  const svgWidth = Math.max(containerWidth, maxX + padding);
  const svgHeight = Math.max(containerHeight, maxY + padding);
  
  graphSvg.setAttribute('width', svgWidth);
  graphSvg.setAttribute('height', svgHeight);
  
  updateGraphPanLimits(containerWidth, containerHeight, svgWidth, svgHeight);
  
  if (!graphPanInitialized) {
    graphPan.x = (containerWidth - svgWidth) / 2;
    graphPan.y = Math.min(GRAPH_MARGIN, (containerHeight - svgHeight) / 2);
    graphPanInitialized = true;
  }
  applyGraphTransform();
  
  // Draw edges first (so they appear behind nodes)
  conversations.forEach(node => {
    if (node.parentId) {
      const parentPos = nodePositions.get(node.parentId);
      const childPos = nodePositions.get(node.id);
      
      if (parentPos && childPos) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        // Connect from bottom-center of parent to top-center of child
        const d = `M ${parentPos.x} ${parentPos.y + nodeHeight/2} 
                   C ${parentPos.x} ${(parentPos.y + childPos.y) / 2}, 
                     ${childPos.x} ${(parentPos.y + childPos.y) / 2}, 
                     ${childPos.x} ${childPos.y - nodeHeight/2}`;
        path.setAttribute('d', d);
        path.setAttribute('class', 'graph-edge');
        graphSvg.appendChild(path);
      }
    }
  });
  
  // Draw nodes
  conversations.forEach(node => {
    const pos = nodePositions.get(node.id);
    if (!pos) return;
    
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', `graph-node-group${node.id === activeConversation.id ? ' active' : ''}`);
    
    // Rect
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', pos.x - nodeWidth/2);
    rect.setAttribute('y', pos.y - nodeHeight/2);
    rect.setAttribute('width', nodeWidth);
    rect.setAttribute('height', nodeHeight);
    rect.setAttribute('rx', 8);
    rect.setAttribute('class', 'graph-node-rect');
    group.appendChild(rect);
    
    // Foreign Object for HTML content
    const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
    fo.setAttribute('x', pos.x - nodeWidth/2);
    fo.setAttribute('y', pos.y - nodeHeight/2);
    fo.setAttribute('width', nodeWidth);
    fo.setAttribute('height', nodeHeight);
    
    const div = document.createElement('div');
    div.className = 'node-label-container';
    
    const textSpan = document.createElement('span');
    textSpan.className = 'node-label-text';
    textSpan.textContent = node.title || 'Новый чат';
    
    div.appendChild(textSpan);
    fo.appendChild(div);
    group.appendChild(fo);
    
    group.addEventListener('click', () => {
      switchConversation(node);
      graphCurtain.classList.remove('is-open');
    });
    
    graphSvg.appendChild(group);
  });
}

function applyGraphTransform() {
  if (!graphSvg) return;
  clampGraphPan();
  graphSvg.style.transform = `translate(${graphPan.x}px, ${graphPan.y}px)`;
}

function clampGraphPan() {
  graphPan.x = Math.min(Math.max(graphPan.x, graphPanLimits.minX), graphPanLimits.maxX);
  graphPan.y = Math.min(Math.max(graphPan.y, graphPanLimits.minY), graphPanLimits.maxY);
}

function renderMathIfAvailable(element) {
  if (window.renderMathInElement) {
    window.renderMathInElement(element, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ],
      throwOnError: false
    });
  }
}

function applyHighlightsToElement(container, message) {
  const highlights = (message.highlights || []).filter(h =>
    Number.isFinite(h.displayStart) && Number.isFinite(h.displayEnd) && h.displayEnd > h.displayStart
  );
  if (!highlights.length) return;

  const pendingIds = new Set((activeConversation.pendingFragments || []).map(f => f.id));
  const sorted = [...highlights].sort((a, b) => b.displayStart - a.displayStart);

  sorted.forEach(highlight => {
    const startPos = findTextPosition(container, highlight.displayStart);
    const endPos = findTextPosition(container, highlight.displayEnd);
    if (!startPos || !endPos) return;

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);

    const mark = document.createElement('mark');
    mark.dataset.highlightId = highlight.id;
    mark.classList.add('highlight');

    const isPending = pendingIds.has(highlight.id);
    if (isPending) {
      mark.classList.add('highlight--pending');
    }

    if (highlightHasChildChat(highlight)) {
      mark.classList.add('highlight-clickable');
      mark.title = 'Перейти в дочерний чат';
    }

    const contents = range.extractContents();
    mark.appendChild(contents);

    if (isPending) {
      const button = document.createElement('button');
      button.className = 'highlight-remove-btn';
      button.dataset.highlightId = highlight.id;
      button.title = 'Отменить выделение';
      button.textContent = '×';
      mark.appendChild(button);
    }

    range.insertNode(mark);
  });
}

function findTextPosition(container, targetIndex) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let cursor = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest('.highlight-remove-btn')) continue;
    const length = node.textContent.length;
    if (targetIndex <= cursor + length) {
      return { node, offset: targetIndex - cursor };
    }
    cursor += length;
  }
  return null;
}

function highlightHasChildChat(highlight) {
  if (!highlight?.text) return false;
  return conversations.some(c =>
    c.parentId === activeConversation?.id &&
    c.originTerm === highlight.text
  );
}

function updateGraphPanLimits(containerWidth, containerHeight, svgWidth, svgHeight) {
  const marginX = Math.max(GRAPH_MARGIN, containerWidth / 2);
  const marginY = Math.max(GRAPH_MARGIN, containerHeight / 2);
  
  if (svgWidth <= containerWidth) {
    const centered = (containerWidth - svgWidth) / 2;
    graphPanLimits.minX = graphPanLimits.maxX = centered;
  } else {
    graphPanLimits.maxX = marginX;
    graphPanLimits.minX = containerWidth - svgWidth - marginX;
  }
  
  if (svgHeight <= containerHeight) {
    const centeredY = (containerHeight - svgHeight) / 2;
    graphPanLimits.minY = graphPanLimits.maxY = centeredY;
  } else {
    graphPanLimits.maxY = marginY;
    graphPanLimits.minY = containerHeight - svgHeight - marginY;
  }
}

function enableGraphDragging() {
  if (graphDragInitialized || !graphContainer) return;
  graphDragInitialized = true;
  
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  
  const onMouseDown = (e) => {
    if (!graphCurtain.classList.contains('is-open')) return;
    if (e.button !== 0) return;
    // allow node clicks to switch chats
    if (e.target.closest('.graph-node-group')) return;
    isDragging = true;
    graphContainer.style.cursor = 'grabbing';
    startX = e.clientX - graphPan.x;
    startY = e.clientY - graphPan.y;
    e.preventDefault();
  };
  
  const endDrag = () => {
    if (!isDragging) return;
    isDragging = false;
    graphContainer.style.cursor = 'grab';
  };
  
  const onMouseMove = (e) => {
    if (!graphCurtain.classList.contains('is-open')) return;
    if (!isDragging) return;
    graphPan.x = e.clientX - startX;
    graphPan.y = e.clientY - startY;
    applyGraphTransform();
  };
  
  const onWheel = (e) => {
    if (!graphCurtain.classList.contains('is-open')) return;
    e.preventDefault();
    const deltaX = e.deltaX;
    const deltaY = e.deltaY;
    if (Math.abs(deltaX) < WHEEL_DEADZONE && Math.abs(deltaY) < WHEEL_DEADZONE) {
      return;
    }
    graphPan.x -= deltaX;
    graphPan.y -= deltaY;
    applyGraphTransform();
  };
  
  graphContainer.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', endDrag);
  graphContainer.addEventListener('mouseleave', endDrag);
  graphContainer.addEventListener('wheel', onWheel, { passive: false });
}
