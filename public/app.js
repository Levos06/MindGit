const historyEl = document.getElementById('history');
const chatStream = document.getElementById('chat-stream');
const form = document.getElementById('chat-form');
const textarea = document.getElementById('chat-textarea');
const newChatBtn = document.getElementById('new-chat');
const sendBtn = document.getElementById('send-button');
const deepDiveBtn = document.getElementById('deep-dive');

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
    isExpanded: true
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

// --- UI Logic ---

const textareaAutoResize = () => {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
};
textarea.addEventListener('input', textareaAutoResize);

newChatBtn.addEventListener('click', async () => {
  activeConversation = createEmptyConversation();
  conversations = [activeConversation, ...conversations];
  // Don't save to disk yet, only in memory
  updateHistory();
  renderConversation();
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
  
  // If this was a freshly created session in memory, we need to reload/resync or just proceed.
  // The simplest is to keep in-memory sync.
  updateHistory(); // refresh titles

  const payload = [...activeConversation.messages];

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payload })
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
  // We need to render the tree recursively.
  // First, find roots (items with no parentId)
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
  
  // Click on row activates chat
  row.addEventListener('click', (e) => {
    // If we clicked toggle, don't activate
    if (e.target.closest('.toggle-btn')) return;
    
    activeConversation = conversation;
    updateHistory();
    renderConversation();
  });

  // Find children
  const children = conversations.filter(c => c.parentId === conversation.id);
  const hasChildren = children.length > 0;

  if (hasChildren) {
    const toggle = document.createElement('button');
    toggle.className = 'toggle-btn' + (conversation.isExpanded ? '' : ' is-collapsed');
    toggle.innerHTML = '▼'; // Could use SVG chevron
    toggle.onclick = async (e) => {
      e.stopPropagation();
      conversation.isExpanded = !conversation.isExpanded;
      await saveSession(conversation); // persist expansion state
      updateHistory();
    };
    row.appendChild(toggle);
  } else {
    const spacer = document.createElement('div');
    spacer.className = 'toggle-spacer';
    row.appendChild(spacer);
  }

  // Icon could go here (folder/chat icon)
  // const icon = document.createElement('span'); ...

  const title = document.createElement('span');
  title.className = 'history-item-title';
  title.textContent = conversation.title;
  row.appendChild(title);
  
  group.appendChild(row);

  if (hasChildren) {
    const childrenContainer = document.createElement('div');
    childrenContainer.className = 'history-children' + (conversation.isExpanded ? '' : ' is-hidden');
    
    // Recursive call for children
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

  // Save highlight
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
    isExpanded: true,
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
  
  // Save parent update
  await saveSession(activeConversation);
  
  // Save all children
  await Promise.all(newConversations.map(saveSession));
  
  // Update local state
  conversations = [...conversations, ...newConversations];

  updateHistory();
  activeConversation = newConversations[0];
  renderConversation();
}
