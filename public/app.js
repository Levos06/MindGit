const historyEl = document.getElementById('history');
const chatStream = document.getElementById('chat-stream');
const form = document.getElementById('chat-form');
const textarea = document.getElementById('chat-textarea');
const newChatBtn = document.getElementById('new-chat');
const sendBtn = document.getElementById('send-button');
const deepDiveBtn = document.getElementById('deep-dive');
const contextToast = document.getElementById('context-toast');
const graphCurtain = document.getElementById('graph-curtain');
const graphToggle = document.getElementById('graph-toggle');
const graphSvg = document.getElementById('graph-svg');

// State
let conversations = [];
let activeConversation = null;

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

chatStream.addEventListener('mouseup', handleSelection);
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
      if (message.role === 'assistant' && message.highlights?.length) {
        bubble.innerHTML = renderHighlightedText(message.content, message.highlights);
      } else {
        bubble.textContent = message.content;
      }
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

  const offsets = getOffsets(range, bubble);
  if (!offsets) {
    selection.removeAllRanges();
    return;
  }

  if (message.highlights?.some((highlight) => highlight.start === offsets.start && highlight.end === offsets.end)) {
    selection.removeAllRanges();
    return;
  }

  const fragmentText = message.content.slice(offsets.start, offsets.end).trim();
  if (!fragmentText) {
    selection.removeAllRanges();
    return;
  }

  message.highlights = message.highlights || [];
  const highlightId = crypto.randomUUID();
  message.highlights.push({ id: highlightId, start: offsets.start, end: offsets.end });

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

function getOffsets(range, container) {
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let cursor = 0;
  let start = null;
  let end = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
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

function renderHighlightedText(text, highlights) {
  const safeHighlights = [...highlights].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = '';

  safeHighlights.forEach((highlight) => {
    const start = Math.max(0, Math.min(highlight.start, text.length));
    const end = Math.max(start, Math.min(highlight.end, text.length));
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark data-highlight-id=\"${highlight.id}\">${escapeHtml(text.slice(start, end))}</mark>`;
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
  const count = activeConversation.pendingFragments?.length || 0;
  if (count > 0) {
    deepDiveBtn.hidden = false;
    deepDiveBtn.textContent = `Углубиться в термины (${count})`;
  } else {
    deepDiveBtn.hidden = true;
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
}

// --- Graph Visualization ---

graphToggle.addEventListener('click', () => {
  graphCurtain.classList.toggle('is-open');
  if (graphCurtain.classList.contains('is-open')) {
    renderGraph();
  }
});

function renderGraph() {
  const container = document.querySelector('.graph-container');
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  
  // Clear existing content
  graphSvg.innerHTML = '';
  
  // Build tree structure
  const roots = conversations.filter(c => !c.parentId);
  if (roots.length === 0) return;
  
  // Layout configuration
  const nodeRadius = 30;
  const levelHeight = 120;
  const minDistance = nodeRadius * 3; // 1.5 диаметра
  
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
      const childSpacing = 120;
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
    const rootSpacing = 200;
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
      
      const nodeSpacing = Math.max(minDistance, 150);
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
  let maxX = 0, maxY = 0;
  nodePositions.forEach(pos => {
    maxX = Math.max(maxX, pos.x);
    maxY = Math.max(maxY, pos.y);
  });
  
  // Add padding and set SVG size
  const svgWidth = Math.max(containerWidth, maxX + 100);
  const svgHeight = Math.max(containerHeight, maxY + 100);
  graphSvg.setAttribute('width', svgWidth);
  graphSvg.setAttribute('height', svgHeight);
  
  // Draw edges first (so they appear behind nodes)
  conversations.forEach(node => {
    if (node.parentId) {
      const parentPos = nodePositions.get(node.parentId);
      const childPos = nodePositions.get(node.id);
      
      if (parentPos && childPos) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const d = `M ${parentPos.x} ${parentPos.y + nodeRadius} 
                   C ${parentPos.x} ${(parentPos.y + childPos.y) / 2}, 
                     ${childPos.x} ${(parentPos.y + childPos.y) / 2}, 
                     ${childPos.x} ${childPos.y - nodeRadius}`;
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
    group.setAttribute('class', `graph-node${node.id === activeConversation.id ? ' is-active' : ''}`);
    group.style.cursor = 'pointer';
    
    // Circle
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', pos.x);
    circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', nodeRadius);
    group.appendChild(circle);
    
    // Label
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', pos.x);
    text.setAttribute('y', pos.y + nodeRadius + 20);
    text.textContent = node.title.slice(0, 20) + (node.title.length > 20 ? '...' : '');
    group.appendChild(text);
    
    // Click handler
    group.addEventListener('click', () => {
      switchConversation(node);
      graphCurtain.classList.remove('is-open');
    });
    
    graphSvg.appendChild(group);
  });
}
