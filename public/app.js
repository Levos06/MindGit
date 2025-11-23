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
  // Load from server
  await loadSessions();
  
  if (conversations.length === 0) {
    activeConversation = createEmptyConversation();
    conversations = [activeConversation];
    // We don't save immediately to avoid cluttering disk with empty chats until used
  } else {
    // Try to restore last active conversation from localStorage
    const savedActiveId = localStorage.getItem('activeConversationId');
    if (savedActiveId) {
      const savedConversation = conversations.find(c => c.id === savedActiveId);
      if (savedConversation) {
        activeConversation = savedConversation;
      } else {
        // Fallback to first conversation if saved one not found
        activeConversation = conversations[0];
      }
    } else {
      // Default to first root conversation
      activeConversation = conversations[0];
    }
  }
  
updateHistory();
renderConversation();

  // Restore scroll position
  const savedScrollTop = localStorage.getItem(`scrollTop_${activeConversation.id}`);
  if (savedScrollTop) {
    requestAnimationFrame(() => {
      chatStream.scrollTop = parseInt(savedScrollTop, 10);
    });
  } else {
    scrollToBottom();
  }
  
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
  // Save scroll position of current conversation
  if (activeConversation) {
    localStorage.setItem(`scrollTop_${activeConversation.id}`, chatStream.scrollTop.toString());
  }
  
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
  
  // Save active conversation ID
  localStorage.setItem('activeConversationId', activeConversation.id);
  
  updateHistory();
  renderConversation();
  
  // Restore scroll position for new conversation
  const savedScrollTop = localStorage.getItem(`scrollTop_${activeConversation.id}`);
  if (savedScrollTop) {
    requestAnimationFrame(() => {
      chatStream.scrollTop = parseInt(savedScrollTop, 10);
    });
  } else {
    scrollToBottom();
  }
  
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

  // Create assistant message placeholder for streaming
  const assistantMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    highlights: []
  };
  activeConversation.messages.push(assistantMessage);
  renderConversation();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        messages: payload,
        sessionId: activeConversation.id,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error('Сервер недоступен');
    }

    // Mark streaming as active and enable auto-scroll initially
    isStreaming = true;
    shouldAutoScroll = true;
    lastScrollTop = chatStream.scrollTop;
    
    // Stream the response with smooth updates
    await streamChatResponse(response, (content) => {
      assistantMessage.content = content;
      renderConversation();
      // Auto-scroll if user hasn't scrolled up
      if (shouldAutoScroll) {
        scrollToBottom();
      }
    });
    
    // Save assistant reply after streaming completes
    await saveSession(activeConversation);
  } catch (error) {
    assistantMessage.content = '⚠️ Ошибка: ' + error.message;
    renderConversation();
  } finally {
    isStreaming = false;
    shouldAutoScroll = true; // Reset for next message
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

// Smooth streaming with batched updates
async function streamChatResponse(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';
  let lastUpdateTime = performance.now();
  let pendingUpdate = false;
  let animationFrameId = null;
  const UPDATE_INTERVAL = 16; // ~60fps for smooth updates

  // Batch updates using requestAnimationFrame for smooth rendering
  const scheduleUpdate = () => {
    if (!pendingUpdate) {
      pendingUpdate = true;
      animationFrameId = requestAnimationFrame(() => {
        onChunk(fullContent);
        pendingUpdate = false;
        lastUpdateTime = performance.now();
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            // Final update
            if (animationFrameId) {
              cancelAnimationFrame(animationFrameId);
            }
            onChunk(fullContent);
            return fullContent;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              // Schedule update with throttling for smooth rendering
              const now = performance.now();
              if (now - lastUpdateTime >= UPDATE_INTERVAL) {
                scheduleUpdate();
              } else if (!pendingUpdate) {
                scheduleUpdate();
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    // Final update
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
    onChunk(fullContent);
    return fullContent;
  } catch (error) {
    console.error('Streaming error:', error);
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
    throw error;
  }
}

function renderConversation() {
  chatStream.replaceChildren(
    ...activeConversation.messages.map((message) => {
      const bubble = document.createElement('div');
      bubble.className = `message message--${message.role === 'user' ? 'user' : 'bot'}`;
      bubble.dataset.messageId = message.id;
      
      const body = document.createElement('div');
      body.className = 'message__body';
      
      const html = renderMessageHtml(message);
      if (html !== null) {
        body.innerHTML = html;
        renderMathIfAvailable(body);
        // Only apply highlights if highlighting is NOT disabled for this message
        // We default to enabled (undefined or false means enabled, true means disabled)
        if (message.role === 'assistant' && !message.disableHighlighting) {
          applyHighlightsToElement(body, message);
        }
      } else {
        body.textContent = message.content;
      }
      
      bubble.appendChild(body);

      // Add actions footer for all messages
      const actions = document.createElement('div');
      actions.className = 'message__actions';
      
      // Copy button (for all messages)
      const copyBtn = document.createElement('button');
      copyBtn.className = 'action-btn copy-btn';
      copyBtn.title = 'Копировать сообщение';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(message.content).then(() => {
          const originalHtml = copyBtn.innerHTML;
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          setTimeout(() => copyBtn.innerHTML = originalHtml, 2000);
        });
      };
      actions.appendChild(copyBtn);
      
      // Highlight toggle button (only for assistant messages)
      if (message.role === 'assistant') {
        const highlightToggleBtn = document.createElement('button');
        highlightToggleBtn.className = `action-btn highlight-toggle-btn ${message.disableHighlighting ? 'is-disabled' : 'is-active'}`;
        highlightToggleBtn.title = message.disableHighlighting ? 'Включить выделение терминов' : 'Отключить выделение терминов';
        highlightToggleBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>`;
        
        highlightToggleBtn.onclick = async (e) => {
          e.stopPropagation();
          message.disableHighlighting = !message.disableHighlighting;
          
          // Update button state without full re-render
          highlightToggleBtn.className = `action-btn highlight-toggle-btn ${message.disableHighlighting ? 'is-disabled' : 'is-active'}`;
          highlightToggleBtn.title = message.disableHighlighting ? 'Включить выделение терминов' : 'Отключить выделение терминов';
          
          // Update highlights visibility without full re-render
          const body = bubble.querySelector('.message__body');
          if (message.disableHighlighting) {
            // Remove highlights - unwrap mark elements
            body.querySelectorAll('mark[data-highlight-id]').forEach(mark => {
              const parent = mark.parentNode;
              while (mark.firstChild) {
                parent.insertBefore(mark.firstChild, mark);
              }
              parent.removeChild(mark);
              parent.normalize();
            });
          } else {
            // Re-apply highlights
            if (message.role === 'assistant' && message.highlights?.length) {
              applyHighlightsToElement(body, message);
            }
          }
          
          await saveSession(activeConversation); // Save state
        };

        actions.appendChild(highlightToggleBtn);
      }
      
      bubble.appendChild(actions);
      
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

let isStreaming = false;
let shouldAutoScroll = true; // Track if we should auto-scroll during streaming
let lastScrollTop = 0; // Track scroll position to detect upward scrolling

function scrollToBottom() {
  // During streaming, only auto-scroll if user hasn't scrolled up
  if (isStreaming && !shouldAutoScroll) return;
  
  requestAnimationFrame(() => {
    chatStream.scrollTop = chatStream.scrollHeight;
    lastScrollTop = chatStream.scrollTop;
    // Save scroll position
    if (activeConversation) {
      localStorage.setItem(`scrollTop_${activeConversation.id}`, chatStream.scrollTop.toString());
    }
  });
}

// Save scroll position periodically and on scroll
chatStream.addEventListener('scroll', () => {
  const currentScrollTop = chatStream.scrollTop;
  
  // If user scrolls up during streaming (more than 10px to avoid false positives), disable auto-scroll
  if (isStreaming && currentScrollTop < lastScrollTop - 10) {
    shouldAutoScroll = false;
  }
  
  lastScrollTop = currentScrollTop;
  
  // Save scroll position
  if (activeConversation) {
    localStorage.setItem(`scrollTop_${activeConversation.id}`, currentScrollTop.toString());
  }
});

function setLoading(state) {
  sendBtn.disabled = state;
}

function handleSelection() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const bubble = ancestor instanceof Element
    ? ancestor.closest('.message--bot, .message--user')
    : ancestor?.parentElement?.closest('.message--bot, .message--user');

  if (!bubble || !bubble.dataset.messageId) {
    // Allow default selection behavior if not in a message bubble
    return;
  }

  if (!bubble.contains(range.startContainer) || !bubble.contains(range.endContainer)) {
    // Allow default selection behavior if selection spans outside message
    return;
  }

  const message = activeConversation.messages.find((msg) => msg.id === bubble.dataset.messageId);
  if (!message) {
    // Allow default selection behavior if message not found
    return;
  }

  // For user messages, always allow default selection behavior (copying, etc.)
  if (message.role === 'user') {
    return;
  }

  // If highlighting is disabled for assistant message, allow default selection behavior (copying, etc.)
  if (message.disableHighlighting) {
    return;
  }

  // Only process highlighting for assistant messages
  if (message.role !== 'assistant') {
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

  // Check if selection is within a KaTeX element (formula)
  const katexElement = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement?.closest('.katex, .katex-display')
    : range.startContainer.closest('.katex, .katex-display');
  
  let fragmentText = selection.toString().trim();
  let extractedFormulaText = null;
  
  // If selection is within a KaTeX element, extract the real formula text from message.content
  if (katexElement) {
    // Find the formula in message.content that corresponds to this KaTeX element
    // Use the selection offsets to find which formula is at this position
    const selectionStart = offsets.start;
    const selectionEnd = offsets.end;
    
    // Find all formulas with their positions in the original text
    const allFormulas = [];
    
    // Find block math formulas $$...$$
    let blockMathMatch;
    const blockMathRegex = /\$\$[\s\S]*?\$\$/g;
    while ((blockMathMatch = blockMathRegex.exec(message.content)) !== null) {
      const formulaStart = blockMathMatch.index;
      const formulaEnd = formulaStart + blockMathMatch[0].length;
      allFormulas.push({
        start: formulaStart,
        end: formulaEnd,
        full: blockMathMatch[0],
        type: 'block'
      });
    }
    
    // Find LaTeX block math \[...\]
    let latexBlockMatch;
    const latexBlockRegex = /\\\[[\s\S]*?\\\]/g;
    while ((latexBlockMatch = latexBlockRegex.exec(message.content)) !== null) {
      const formulaStart = latexBlockMatch.index;
      const formulaEnd = formulaStart + latexBlockMatch[0].length;
      allFormulas.push({
        start: formulaStart,
        end: formulaEnd,
        full: latexBlockMatch[0],
        type: 'latex-block'
      });
    }
    
    // Find inline math $...$
    let inlineMatch;
    const inlineRegex = /\$[^$\n]+\$/g;
    while ((inlineMatch = inlineRegex.exec(message.content)) !== null) {
      const content = inlineMatch[0].slice(1, -1).trim();
      // Skip if it looks like currency
      if (content.length > 0 && !/^\d/.test(content)) {
        const formulaStart = inlineMatch.index;
        const formulaEnd = formulaStart + inlineMatch[0].length;
        allFormulas.push({
          start: formulaStart,
          end: formulaEnd,
          full: inlineMatch[0],
          type: 'inline'
        });
      }
    }
    
    // Find LaTeX inline math \(...\)
    let latexInlineMatch;
    const latexInlineRegex = /\\\([\s\S]*?\\\)/g;
    while ((latexInlineMatch = latexInlineRegex.exec(message.content)) !== null) {
      const formulaStart = latexInlineMatch.index;
      const formulaEnd = formulaStart + latexInlineMatch[0].length;
      allFormulas.push({
        start: formulaStart,
        end: formulaEnd,
        full: latexInlineMatch[0],
        type: 'latex-inline'
      });
    }
    
    // Find the formula that contains or overlaps with the selection
    const matchingFormula = allFormulas.find(formula => {
      // Check if selection overlaps with formula
      return (selectionStart >= formula.start && selectionStart < formula.end) ||
             (selectionEnd > formula.start && selectionEnd <= formula.end) ||
             (selectionStart <= formula.start && selectionEnd >= formula.end);
    });
    
    if (matchingFormula) {
      // Extract content without delimiters
      if (matchingFormula.type === 'block') {
        extractedFormulaText = matchingFormula.full.replace(/^\$\$|\$\$$/g, '').trim();
      } else if (matchingFormula.type === 'latex-block') {
        extractedFormulaText = matchingFormula.full.replace(/^\\\[|\\\]$/g, '').trim();
      } else if (matchingFormula.type === 'inline') {
        extractedFormulaText = matchingFormula.full.slice(1, -1).trim();
      } else if (matchingFormula.type === 'latex-inline') {
        extractedFormulaText = matchingFormula.full.replace(/^\\\(|\\\)$/g, '').trim();
      }
    }
    
    // Use extracted formula text if found, otherwise use rendered text
    if (extractedFormulaText) {
      fragmentText = extractedFormulaText;
    }
  }
  
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
  
  // Find child conversation - first try by highlight ID (most accurate), then by text
  let childConversation = conversations.find(c => 
    c.parentId === activeConversation.id && 
    c.originHighlightId === highlightId
  );
  
  // Fallback to text matching if ID match not found
  if (!childConversation) {
    childConversation = conversations.find(c => 
      c.parentId === activeConversation.id && 
      c.originTerm === highlightText
    );
  }
  
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
    
    // PROTECT MATH: Replace math blocks with placeholders to prevent Markdown parsing interference
    // This protects $$, $ (if not currency), and \[ \]
    const mathBlocks = [];
    const protectMath = (source) => {
      return source.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\$)\$(?!\$)[^$\n]+(?<!\$)\$(?!\$))/g, (match) => {
        // Skip if it looks like currency (simple heuristic: space after $)
        if (match.startsWith('$ ') || match.startsWith(' $')) return match;
        // Use a placeholder that doesn't trigger markdown formatting (no underscores/asterisks)
        const id = `MATHBLOCK${mathBlocks.length}ENDMATHBLOCK`;
        mathBlocks.push(match);
        return id;
      });
    };

    if (!needsLegacyHighlighting) {
        markdownSource = protectMath(markdownSource);
    } else {
        // If we have legacy highlights, we need to be careful not to break them.
        // But legacy highlighting builds HTML directly into markdown, which is messy.
        // For now, let's assume legacy highlights don't overlap with math complexly.
        // Better to apply highlight-builder first, then protect math? 
        // No, highlights inject <mark>, which math protection might hide if inside.
        // Let's prioritize legacy behavior if present (rare now), or skip math protection for legacy.
        // Or try to protect math inside buildHighlightedMarkdown? Too complex.
        // Let's stick to: build highlights -> then protect math? 
        // If buildHighlightedMarkdown returns markdown with <mark> tags, 
        // protectMath will see <mark> as text. 
        // Let's do: build highlighted -> protect math.
        markdownSource = buildHighlightedMarkdown(baseText, message.highlights);
        markdownSource = protectMath(markdownSource);
    }
    
    const rawHtml = parser.parse(markdownSource);
    let sanitizedHtml = purifier.sanitize(rawHtml, MARKDOWN_SANITIZE_CONFIG);
    
    // RESTORE MATH
    mathBlocks.forEach((block, index) => {
      const id = `MATHBLOCK${index}ENDMATHBLOCK`;
      // Use split/join to replace all instances (though there should be one) safely
      sanitizedHtml = sanitizedHtml.split(id).join(block);
    });
    
    return sanitizedHtml;
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
    
    const hasChildChat = hasChildChatForHighlight(highlight.id, trimmed);
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
    
    const hasChildChat = hasChildChatForHighlight(highlight.id, highlightText);
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
      // Creative formatting for count
      let countText = '';
      if (count === 1) {
        countText = '1 термин';
      } else if (count >= 2 && count <= 4) {
        countText = `${count} термина`;
      } else {
        countText = `${count} терминов`;
      }
      deepDiveBtn.innerHTML = `Углубиться в <span class="dive-count">${countText}</span>`;
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

async function generateChildChatInitialMessage(parentSummary, selectedText, sourceMessageText) {
  const prompt = `Ты помогаешь пользователю углубиться в изучение термина или концепции. 

Контекст родительского чата (краткое саммари):
${parentSummary || 'Контекст недоступен'}

Исходное сообщение, из которого был выделен фрагмент:
${sourceMessageText || 'Контекст недоступен'}

Пользователь выделил следующий фрагмент для углубленного изучения:
${selectedText}

Твоя задача: очень кратко (1-2 предложения) обрисовать этот термин/концепцию/фрагмент и проактивно пригласить пользователя к диалогу. Будь дружелюбным и заинтересованным. Предложи конкретные направления для обсуждения или задай открытый вопрос, который поможет начать диалог. Если в выделенном фрагменте есть формулы - обязательно продублируй их в своем сообщении.`;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        messages: [{ role: 'user', content: prompt }],
        sessionId: null, // No session for this one-off request
        stream: false // No streaming for initial messages
      })
    });

    if (!response.ok) {
      throw new Error('Сервер недоступен');
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || `${selectedText}: Вам не понятен термин целиком или есть конкретный вопрос по этому фрагменту?`;
  } catch (error) {
    console.error('Error generating initial message:', error);
    // Fallback to default message
    return `${selectedText}: Вам не понятен термин целиком или есть конкретный вопрос по этому фрагменту?`;
  }
}

async function handleDeepDive() {
  const fragments = activeConversation.pendingFragments || [];
  if (!fragments.length) return;

  // Get parent summary
  const parentSummary = activeConversation.summary || '';

  // Show loading indicator in center of screen
  const loadingOverlay = document.createElement('div');
  loadingOverlay.className = 'loading-overlay';
  loadingOverlay.innerHTML = '<div class="spinner"></div>';
  document.body.appendChild(loadingOverlay);
  
  // Generate initial messages for all fragments
  setLoading(true);
  const newConversations = await Promise.all(
    fragments.map(async (fragment) => {
      // Find the source message that contains this fragment
      const sourceMessage = activeConversation.messages.find(msg => msg.id === fragment.messageId);
      const sourceMessageText = sourceMessage?.content || '';
      
      const initialMessage = await generateChildChatInitialMessage(
        parentSummary, 
        fragment.text,
        sourceMessageText
      );
      
      return {
        id: crypto.randomUUID(),
        title: fragment.text.slice(0, 32) || 'Термин',
        pendingFragments: [],
        parentId: activeConversation.id,
        originTerm: fragment.text,
        originHighlightId: fragment.id, // Save highlight ID for exact matching
        isExpanded: true,
        summary: '',
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: initialMessage,
            highlights: []
          }
        ]
      };
    })
  );

  setLoading(false);
  
  // Remove loading indicator
  loadingOverlay.remove();

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

graphToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  graphCurtain.classList.toggle('is-open');
  if (graphCurtain.classList.contains('is-open')) {
    renderGraph();
    enableGraphDragging();
  }
});

// Close graph curtain when clicking outside
document.addEventListener('click', (e) => {
  if (graphCurtain && graphCurtain.classList.contains('is-open')) {
    // Check if click is outside the curtain
    if (!graphCurtain.contains(e.target) && !graphToggle.contains(e.target)) {
      graphCurtain.classList.remove('is-open');
    }
  }
});

// Prevent closing when clicking inside the curtain
if (graphCurtain) {
  graphCurtain.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

function renderGraph() {
  if (!graphContainer) return;
  const containerWidth = graphContainer.clientWidth;
  const containerHeight = graphContainer.clientHeight;
  
  // Clear existing content
  graphSvg.innerHTML = '';
  
  if (!activeConversation) return;
  
  // Find the root conversation for the current active conversation
  let rootConversation = activeConversation;
  while (rootConversation.parentId) {
    rootConversation = conversations.find(c => c.id === rootConversation.parentId);
    if (!rootConversation) break;
  }
  
  if (!rootConversation) return;
  
  // Build tree structure - only show the tree for the current root
  const roots = [rootConversation];
  
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
    
    group.addEventListener('click', (e) => {
      e.stopPropagation();
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
      throwOnError: false,
      output: 'html' // Render to HTML+CSS, which is generally safer/faster than MathML in some contexts
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

function hasChildChatForHighlight(highlightId, highlightText) {
  if (!activeConversation) return false;
  
  // First try to find by highlight ID (most accurate)
  const childById = conversations.find(c =>
    c.parentId === activeConversation.id &&
    c.originHighlightId === highlightId
  );
  if (childById) return true;
  
  // Fallback to text matching
  if (highlightText) {
    return conversations.some(c =>
      c.parentId === activeConversation.id &&
      c.originTerm === highlightText
    );
  }
  
  return false;
}

function highlightHasChildChat(highlight) {
  if (!highlight) return false;
  return hasChildChatForHighlight(highlight.id, highlight.text);
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
