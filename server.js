import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.join(__dirname, 'sessions');

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn('Warning: OPENROUTER_API_KEY is not set. API requests will fail.');
}

// Ensure sessions directory exists
try {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
} catch (err) {
  console.error('Failed to create sessions directory:', err);
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// --- Session Management API ---

async function findSessionPath(sessionId, currentDir = SESSIONS_DIR) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === sessionId) {
        return path.join(currentDir, sessionId);
      }
      // Recursive search in subdirectories
      const subDirPath = path.join(currentDir, entry.name);
      const found = await findSessionPath(sessionId, subDirPath);
      if (found) return found;
    }
  }
  return null;
}

async function getAllSessions(dir = SESSIONS_DIR) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionPath = path.join(dir, entry.name);
      const jsonPath = path.join(sessionPath, 'session.json');
      
      try {
        const content = await fs.readFile(jsonPath, 'utf-8');
        const session = JSON.parse(content);
        
        sessions.push(session);
        
        // Recursively get children
        const children = await getAllSessions(sessionPath);
        sessions.push(...children);
        
      } catch (err) {
        // Skip invalid folders
      }
    }
  }
  return sessions;
}

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await getAllSessions();
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { id, title, parentId, messages, pendingFragments, isExpanded, summary, originTerm, originHighlightId, lastSummarizedMessageCount } = req.body;
    const sessionId = id;
    
    let targetDir = SESSIONS_DIR;
    if (parentId) {
      const parentPath = await findSessionPath(parentId);
      if (!parentPath) {
        return res.status(404).json({ error: 'Parent session not found' });
      }
      targetDir = parentPath;
    }

    const sessionDir = path.join(targetDir, sessionId);
    try {
      await fs.access(sessionDir);
    } catch {
      await fs.mkdir(sessionDir, { recursive: true });
    }
    
    const sessionData = { 
      id, title, parentId, messages, pendingFragments, 
      isExpanded, summary, originTerm, originHighlightId, lastSummarizedMessageCount 
    };
    await fs.writeFile(
      path.join(sessionDir, 'session.json'), 
      JSON.stringify(sessionData, null, 2)
    );

    res.json({ success: true, path: sessionDir });
  } catch (error) {
    console.error('Error saving session:', error);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const sessionPath = await findSessionPath(req.params.id);
    if (!sessionPath) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await fs.rm(sessionPath, { recursive: true, force: true });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

app.post('/api/sessions/:id/summarize', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const sessionPath = await findSessionPath(sessionId);
    
    if (!sessionPath) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const jsonPath = path.join(sessionPath, 'session.json');
    const content = await fs.readFile(jsonPath, 'utf-8');
    const session = JSON.parse(content);

    if (!session.messages || session.messages.length === 0) {
      return res.json({ summary: '', messageCount: 0, skipped: true });
    }

    // Check if summary is already up to date
    const lastCount = session.lastSummarizedMessageCount || 0;
    if (session.messages.length <= lastCount) {
      console.log(`Summary already up to date for session ${sessionId} (${session.messages.length} <= ${lastCount})`);
      return res.json({ 
        summary: session.summary || '', 
        messageCount: session.messages.length,
        skipped: true 
      });
    }

    // Prepare messages for summarization
    const textToSummarize = session.messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://example.com',
        'X-Title': 'Minimalist Chatbot'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [
          {
            role: "user",
            content: `Summarize the following conversation briefly in three or four sentences (in Russian if the content is Russian):\n\n${textToSummarize}`
          }
        ],
        temperature: 0.5,
        max_tokens: 256
      })
    });

    if (!response.ok) {
      throw new Error('OpenRouter request failed during summarization');
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content || '';

    // Update session with summary and message count
    session.summary = summary;
    session.lastSummarizedMessageCount = session.messages.length;
    await fs.writeFile(jsonPath, JSON.stringify(session, null, 2));

    res.json({ 
      success: true, 
      summary,
      messageCount: session.messages.length,
      skipped: false
    });

  } catch (error) {
    console.error('Error summarizing session:', error);
    res.status(500).json({ error: 'Failed to summarize session' });
  }
});

// --- Helper: Build context chain from parent sessions ---

async function buildContextChain(sessionId) {
  const chain = [];
  let currentId = sessionId;
  
  while (currentId) {
    const sessionPath = await findSessionPath(currentId);
    if (!sessionPath) break;
    
    const jsonPath = path.join(sessionPath, 'session.json');
    try {
      const content = await fs.readFile(jsonPath, 'utf-8');
      const session = JSON.parse(content);
      
      chain.unshift({
        title: session.title || 'Без названия',
        summary: session.summary || '',
        originTerm: session.originTerm || null
      });
      
      currentId = session.parentId;
    } catch (err) {
      console.error(`Failed to read session ${currentId}:`, err);
      break;
    }
  }
  
  return chain;
}

// --- Chat Proxy ---

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, sessionId, stream = true } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required.' });
    }

    // Build context chain if sessionId provided
    let contextMessage = null;
    if (sessionId) {
      const contextChain = await buildContextChain(sessionId);
      
      // Only add context if there are parent sessions (chain length > 1)
      if (contextChain.length > 1) {
        let contextText = "Контекст беседы (путь углубления в тему):\n\n";
        
        contextChain.forEach((item, index) => {
          // Show term that led to this topic (from previous item)
          if (index > 0 && item.originTerm) {
            contextText += `→ Пользователь углубился в термин: "${item.originTerm}"\n\n`;
          }
          
          contextText += `${index + 1}. Тема: "${item.title}"\n`;
          if (item.summary) {
            contextText += `   Краткое содержание: ${item.summary}\n\n`;
          } else if (index < contextChain.length - 1) {
            // If not the last (current) item and no summary yet
            contextText += `   (ещё не завершено)\n\n`;
          }
        });
        
        contextMessage = {
          role: "system",
          content: contextText
        };
      }
    }

    // Combine context with user messages
    const apiMessages = contextMessage 
      ? [contextMessage, ...messages]
      : messages;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://example.com',
        'X-Title': 'Minimalist Chatbot'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: apiMessages,
        temperature: 0.8,
        max_tokens: 4096,
        stream: stream
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter error:', errorText);
      return res.status(response.status).json({ error: 'OpenRouter request failed.' });
    }

    // If not streaming, return JSON response
    if (!stream) {
      const data = await response.json();
      return res.json(data);
    }

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

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
              res.write(`data: [DONE]\n\n`);
              res.end();
              return;
            }
            try {
              const parsed = JSON.parse(data);
              res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } catch (error) {
      console.error('Streaming error:', error);
      res.write(`data: ${JSON.stringify({ error: 'Streaming error' })}\n\n`);
      res.end();
    }
  } catch (error) {
    console.error('Server error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Unexpected server error.' });
    }
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`Sessions stored in ${SESSIONS_DIR}`);
});
