import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import createError from 'http-errors';
import path from 'node:path';
import fs from 'node:fs/promises';

import config from './config.js';
import { createDataStore } from './services/data-store.js';
import { createSessionService } from './services/session-service.js';
import { createChatService } from './services/chat-service.js';
import { createAiResponder } from './services/ai-responder.js';
import { createDictionaryService } from './services/dictionary-service.js';
import { createAdminService } from './services/admin-service.js';
import { createAdminRouter } from './routes/admin.js';

const app = express();

const corsOptions = {
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS not allowed for this origin'));
  },
  credentials: !config.allowedOrigins.includes('*')
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const CHAT_AVATAR_FILE = 'chatgpt.png';
await fs.mkdir(PUBLIC_DIR, { recursive: true });
const publicAvatarPath = path.join(PUBLIC_DIR, CHAT_AVATAR_FILE);
try {
  await fs.access(publicAvatarPath);
} catch (error) {
  const candidates = [
    path.resolve(process.cwd(), CHAT_AVATAR_FILE),
    path.resolve(process.cwd(), '..', CHAT_AVATAR_FILE)
  ];
  for (const candidate of candidates) {
    try {
      await fs.copyFile(candidate, publicAvatarPath);
      break;
    } catch (copyError) {
      if (copyError.code !== 'ENOENT') {
        console.warn('Failed to copy chat avatar image:', copyError.message || copyError);
        break;
      }
    }
  }
}

const dataStore = await createDataStore(config);
const aiResponder = createAiResponder(config);
const adminService = createAdminService({ config, dataStore, aiResponder });
await adminService.initialize();
const sessionService = createSessionService(dataStore);
const chatService = createChatService(dataStore, aiResponder);
const dictionaryService = createDictionaryService(config);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();
  const provided = req.header('x-api-key');
  if (provided && provided === config.apiKey) return next();
  res.status(401).json({ error: 'API key is missing or invalid.' });
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'writingresearch-backend',
    time: new Date().toISOString()
  });
});

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/public-settings') return next();
  if (req.path.startsWith('/admin')) return next();
  return requireApiKey(req, res, next);
});

app.use('/api/admin', createAdminRouter({ adminService, sessionService, chatService }));

app.get('/api/public-settings', async (req, res, next) => {
  try {
    const settings = await sessionService.getPublicSettings();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

app.get('/api/server/diag', async (req, res, next) => {
  try {
    const diag = await sessionService.getServerDiag();
    res.json(diag);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/start', async (req, res, next) => {
  try {
    const session = await sessionService.startSession(req.body || {});
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

app.get('/api/session/:sessionKey', async (req, res, next) => {
  try {
    const session = await sessionService.getSessionState(req.params.sessionKey);
    res.json(session);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/prewriting', async (req, res, next) => {
  try {
    const updated = await sessionService.submitPrewriting(req.params.sessionKey, req.body?.text);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/draft', async (req, res, next) => {
  try {
    const updated = await sessionService.saveDraft(req.params.sessionKey, req.body?.text);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/notes', async (req, res, next) => {
  try {
    const updated = await sessionService.savePeerNotes(req.params.sessionKey, req.body?.text);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/final', async (req, res, next) => {
  try {
    const updated = await sessionService.submitFinalWriting(req.params.sessionKey, req.body?.text);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/advance', async (req, res, next) => {
  try {
    const updated = await sessionService.advanceToPeerStage(req.params.sessionKey);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/advance-final', async (req, res, next) => {
  try {
    const updated = await sessionService.advanceToFinalStage(req.params.sessionKey);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/regress', async (req, res, next) => {
  try {
    const updated = await sessionService.regressStage(req.params.sessionKey);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/presence/touch', async (req, res, next) => {
  try {
    const updated = await sessionService.touchPresence(req.params.sessionKey);
    res.json({ ok: true, updatedAt: updated.updatedAt });
  } catch (error) {
    next(error);
  }
});

app.post('/api/session/:sessionKey/presence/leave', async (req, res, next) => {
  try {
    await sessionService.postPresenceLeave(req.params.sessionKey, req.body?.userId, req.body?.userName);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chat/:channel/messages', async (req, res, next) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) throw createError(400, 'sessionId 요구됨');
    const list = await chatService.getMessages(sessionId, req.query.since, req.params.channel);
    res.json(list);
  } catch (error) {
    next(error);
  }
});

app.post('/api/chat/:channel/send', async (req, res, next) => {
  try {
    const { sessionId, group, userId, userName, role, text, metadata } = req.body || {};
    const message = await chatService.postMessage(sessionId, group, userId, userName, role, text, {
      ...(metadata || {}),
      channel: req.params.channel
    });
    res.status(201).json(message);
  } catch (error) {
    next(error);
  }
});

app.post('/api/chat/ai/respond', async (req, res, next) => {
  try {
    const { sessionId, group, userMessage, context, metadata } = req.body || {};
    const result = await chatService.requestAiIfNeeded(sessionId, group, userMessage, context, metadata);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/dictionary', async (req, res, next) => {
  try {
    const query = req.query.q || req.query.query;
    const result = await dictionaryService.lookup(query);
    res.json({ ok: true, data: result });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use((req, res, next) => {
  next(createError(404, '요청하신 경로를 찾을 수 없습니다.'));
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = {
    error: err.message || '서버 오류가 발생했습니다.',
    status
  };
  if (process.env.NODE_ENV !== 'production') {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
});

app.listen(config.port, () => {
  console.log(`WritingResearch backend listening on port ${config.port}`);
});

