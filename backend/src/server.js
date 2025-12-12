import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const API_PREFIX = '/api';
const DATA_DIR = path.resolve(
  process.env.LOCAL_DATA_DIR || path.join(__dirname, '..', '..', 'local-data')
);
const PUBLIC_DIR = await resolvePublicDir();
const PRESENCE_TTL_MS = 20_000;

const app = express();

// ----- 초기화: 데이터 디렉터리 -----
await fs.mkdir(DATA_DIR, { recursive: true });

// ----- 스토리지 유틸 -----
class FileStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sessions = [];
    this.messages = [];
    this.matchups = [];
    this.publicSettings = defaultPublicSettings();
  }

  async init() {
    this.sessions = await this.readJson('sessions.json', []);
    this.messages = await this.readJson('messages.json', []);
    this.matchups = await this.readJson('matchups.json', []);
    this.publicSettings = await this.readJson(
      'public-settings.json',
      defaultPublicSettings()
    );
  }

  async readJson(filename, fallback) {
    const filePath = path.join(this.rootDir, filename);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  async writeJson(filename, data) {
    const filePath = path.join(this.rootDir, filename);
    const json = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, json, 'utf8');
  }

  async saveSessions() {
    await this.writeJson('sessions.json', this.sessions);
  }

  async saveMessages() {
    // 메모리/파일 크기 제한(최근 5000개 유지)
    if (this.messages.length > 5000) {
      this.messages = this.messages.slice(-5000);
    }
    await this.writeJson('messages.json', this.messages);
  }
}

const store = new FileStore(DATA_DIR);
await store.init();

// ----- 프레즌스(메모리) -----
const presenceMap = new Map(); // key: roomId|studentId -> timestamp(ms)

function touchPresence(roomId, studentId) {
  if (!roomId || !studentId) return { ok: false };
  const key = `${roomId}|${studentId}`;
  const ts = Date.now();
  presenceMap.set(key, ts);
  return { ok: true, timestamp: ts };
}

function markLeave(roomId, studentId) {
  const key = `${roomId}|${studentId}`;
  presenceMap.delete(key);
  return { ok: true };
}

function readPresence(roomId, studentId) {
  if (!roomId || !studentId) return 0;
  const key = `${roomId}|${studentId}`;
  const val = presenceMap.get(key);
  return val || 0;
}

function buildPresenceSummary(roomId, studentId, partnerStudentId) {
  const now = Date.now();
  const selfTs = readPresence(roomId, studentId);
  const partnerTs = partnerStudentId ? readPresence(roomId, partnerStudentId) : 0;
  const isOnline = (ts) => ts && now - ts < PRESENCE_TTL_MS;
  return {
    self: { lastSeen: selfTs, online: isOnline(selfTs) },
    partner: partnerStudentId
      ? { lastSeen: partnerTs, online: isOnline(partnerTs) }
      : null,
  };
}

// ----- 헬퍼 -----
function defaultPublicSettings() {
  return {
    topLinkUrl: '',
    topLinkText: '',
    aiAvatarUrl: '',
    promptContent: '',
  };
}

function buildSessionKey(group, studentId) {
  const g = String(group || '').toUpperCase();
  const sid = String(studentId || '').trim();
  if (!g || !sid) {
    throw createHttpError(400, '집단과 식별 번호가 필요합니다.');
  }
  return `${g}|${sid}`;
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function makeSoloRoomId(group, studentId) {
  const hash = md5(`${group}|${studentId}`).slice(0, 12);
  return `solo_${hash}`;
}

function makePairRoomId(keyA, keyB) {
  const a = String(keyA || '').trim();
  const b = String(keyB || '').trim();
  const left = a < b ? a : b;
  const right = a < b ? b : a;
  const hash = md5(`${left}|${right}`).slice(0, 12);
  return `r_${hash}`;
}

function createSession(group, studentId, studentName, partnerHint) {
  const now = Date.now();
  const sessionKey = buildSessionKey(group, studentId);
  const upperGroup = String(group || '').toUpperCase();
  let roomId = '';
  let partnerStudentId = '';
  let partnerName = '';

  if (partnerHint) {
    roomId = partnerHint.roomId || makePairRoomId(partnerHint.keyA, partnerHint.keyB);
    partnerStudentId = partnerHint.partnerId || '';
    partnerName = partnerHint.partnerName || '';
  } else {
    roomId = makeSoloRoomId(group, studentId);
  }

  return {
    sessionKey,
    group: upperGroup,
    studentId: String(studentId || '').trim(),
    studentName: String(studentName || '').trim(),
    roomId,
    stage: 1,
    preText: '',
    preSubmittedAt: 0,
    draftText: '',
    draftSavedAt: 0,
    notesText: '',
    notesUpdatedAt: 0,
    finalText: '',
    finalSubmittedAt: 0,
    partnerStudentId,
    partnerName,
    createdAt: now,
    updatedAt: now,
  };
}

function findMatchForStudent(group, studentId, studentName) {
  const upperGroup = String(group || '').toUpperCase();
  const sid = String(studentId || '').trim();
  const sname = String(studentName || '').trim();
  const rows = store.matchups || [];
  for (const row of rows) {
    // row: { roomId?, studentIdA, nameA, studentIdB, nameB, group? }
    if (row.group && String(row.group).toUpperCase() !== upperGroup) continue;
    const aId = String(row.studentIdA || '').trim();
    const bId = String(row.studentIdB || '').trim();
    const aName = String(row.nameA || '').trim();
    const bName = String(row.nameB || '').trim();
    const matches =
      (aId && aId === sid) ||
      (bId && bId === sid) ||
      (aName && aName === sname) ||
      (bName && bName === sname);
    if (!matches) continue;
    const roomId = row.roomId || makePairRoomId(aId || aName, bId || bName);
    const partnerId = aId === sid ? bId : aId;
    const partnerName = aId === sid ? bName : aName;
    return { roomId, partnerId, partnerName, keyA: aId || aName, keyB: bId || bName };
  }
  return null;
}

function findSession(sessionKey) {
  return store.sessions.find((s) => s.sessionKey === sessionKey) || null;
}

function ensureSession(group, studentId, studentName) {
  const sessionKey = buildSessionKey(group, studentId);
  let record = findSession(sessionKey);
  const upperGroup = String(group || '').toUpperCase();
  const partnerHint =
    upperGroup === 'A' || upperGroup === 'B'
      ? findMatchForStudent(group, studentId, studentName)
      : null;

  if (!record) {
    record = createSession(group, studentId, studentName, partnerHint);
    store.sessions.push(record);
  } else {
    record.studentName = String(studentName || record.studentName || '').trim();
    if (!record.roomId) {
      record.roomId = partnerHint
        ? partnerHint.roomId || record.roomId
        : makeSoloRoomId(group, studentId);
    }
    if (partnerHint) {
      record.partnerStudentId = partnerHint.partnerId || record.partnerStudentId || '';
      record.partnerName = partnerHint.partnerName || record.partnerName || '';
    }
    record.updatedAt = Date.now();
  }
  return record;
}

function stepsFromRecord(record) {
  const upperGroup = String(record.group || '').toUpperCase();
  const peerEnabled = upperGroup === 'A' || upperGroup === 'B';
  return {
    prewriting: {
      completed: !!record.preText,
      submittedAt: Number(record.preSubmittedAt || 0),
    },
    draft: {
      saved: !!record.draftText,
      savedAt: Number(record.draftSavedAt || 0),
    },
    peer: {
      enabled: peerEnabled,
      completed: peerEnabled ? Number(record.stage || 1) >= 3 : false,
    },
    final: {
      submitted: !!record.finalText,
      submittedAt: Number(record.finalSubmittedAt || 0),
    },
  };
}

function buildSessionState(record) {
  if (!record) return null;
  const partner =
    record.partnerStudentId &&
    store.sessions.find(
      (s) =>
        s.group === record.group &&
        s.studentId &&
        s.studentId === record.partnerStudentId
    );
  const presence = buildPresenceSummary(
    record.roomId,
    record.studentId,
    record.partnerStudentId
  );
  const upperGroup = String(record.group || '').toUpperCase();
  const peerEnabled = upperGroup === 'A' || upperGroup === 'B';

  return {
    sessionKey: record.sessionKey,
    group: record.group,
    roomId: record.roomId,
    stage: Number(record.stage || 1),
    updatedAt: Number(record.updatedAt || 0),
    prewriting: {
      text: record.preText || '',
      submittedAt: Number(record.preSubmittedAt || 0),
    },
    draft: {
      text: record.draftText || '',
      savedAt: Number(record.draftSavedAt || 0),
    },
    notes: {
      text: record.notesText || '',
      updatedAt: Number(record.notesUpdatedAt || 0),
    },
    final: {
      text: record.finalText || '',
      submittedAt: Number(record.finalSubmittedAt || 0),
    },
    steps: stepsFromRecord(record),
    aiSessionId: `ai:${record.sessionKey}`,
    peerSessionId: peerEnabled && record.roomId ? `peer:${record.roomId}` : '',
    partner: partner
      ? {
          id: partner.studentId,
          name: partner.studentName,
          stage: Number(partner.stage || 1),
          prewriting: {
            text: partner.preText || '',
            submittedAt: Number(partner.preSubmittedAt || 0),
          },
          draft: {
            text: partner.draftText || '',
            savedAt: Number(partner.draftSavedAt || 0),
          },
          notes: {
            text: partner.notesText || '',
            updatedAt: Number(partner.notesUpdatedAt || 0),
          },
          final: {
            text: partner.finalText || '',
            submittedAt: Number(partner.finalSubmittedAt || 0),
          },
          presence: presence.partner || null,
        }
      : null,
    presence,
  };
}

function createHttpError(status, message) {
  const err = new Error(message || '요청 처리 중 오류가 발생했습니다.');
  err.status = status;
  return err;
}

function requireBodyFields(body, fields) {
  for (const field of fields) {
    if (!body || body[field] === undefined || body[field] === null || body[field] === '') {
      throw createHttpError(400, `${field} 값이 필요합니다.`);
    }
  }
}

// ----- AI 호출 -----
async function generateAiFeedback(userMessage, group, contextText, options = {}) {
  const trimmed = String(userMessage || '').trim();
  if (!trimmed) return '질문/메시지가 비어 있습니다.';

  const provider = options.provider || 'openai';
  const stage = Number(options.stage || 1);
  const sessionId = options.sessionId || '';
  const evalPrompt = options.evalPrompt || '';

  // 3-2 차시: gpt-4.1로 평가, 이전 대화 요약 포함
  if (stage >= 3) {
    const transcript = await buildTranscriptText(sessionId);
    const summary =
      transcript.trim() === ''
        ? ''
        : await summarizeTranscript(transcript).catch(() => '');
    const wrapped = `<이전토론대화>${summary || transcript || '대화 없음'}</이전토론대화>`;
    const mergedContext = [contextText || '', wrapped].filter(Boolean).join('\n\n');
    return callOpenAiChat({
      message: trimmed,
      contextText: mergedContext,
      model: 'gpt-4.1',
      systemPrompt: evalPrompt || AI_SYSTEM_PROMPT,
    });
  }

  if (provider === 'perplexity') {
    return callPerplexityChat({ message: trimmed, contextText });
  }
  return callOpenAiChat({ message: trimmed, contextText });
}

async function callOpenAiChat({ message, contextText, model, systemPrompt }) {
  if (!openAiClient) {
    throw createHttpError(500, 'OpenAI 클라이언트가 설정되지 않았습니다.');
  }
  const modelName = model || DEFAULT_OPENAI_MODEL;
  const prompt = typeof systemPrompt === 'string' && systemPrompt.trim()
    ? systemPrompt
    : AI_SYSTEM_PROMPT;
  const messages = [];
  if (prompt) messages.push({ role: 'system', content: prompt });
  if (contextText) {
    messages.push({ role: 'system', content: `[참고]\n${contextText}` });
  }
  messages.push({ role: 'user', content: message });
  const resp = await openAiClient.chat.completions.create({
    model: modelName,
    messages,
    temperature: Number.isFinite(AI_TEMPERATURE) ? AI_TEMPERATURE : 0.6,
  });
  const text = resp?.choices?.[0]?.message?.content || '';
  return text.trim() || '응답을 생성하지 못했습니다.';
}

async function callPerplexityChat({ message, contextText }) {
  if (!PERPLEXITY_API_KEY) {
    throw createHttpError(500, 'Perplexity API 키가 설정되지 않았습니다.');
  }
  const systemPrompt = AI_SYSTEM_PROMPT;
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (contextText) {
    messages.push({ role: 'system', content: `[참고]\n${contextText}` });
  }
  messages.push({ role: 'user', content: message });

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw createHttpError(
      resp.status,
      `Perplexity 요청 실패 (${resp.status}): ${text || '오류'}`
    );
  }
  const data = await resp.json();
  const text =
    data?.choices?.[0]?.message?.content ||
    data?.data?.[0]?.text ||
    '응답을 생성하지 못했습니다.';
  return String(text || '').trim();
}

function buildDictionaryResult(term) {
  const word = String(term || '').trim();
  const hasHangul = /[\u3131-\u318E\uAC00-\uD7A3]/.test(word);
  const direction = hasHangul ? 'ko-en' : 'en-ko';
  return {
    ok: true,
    word,
    pronunciation: hasHangul ? '' : `/${word.slice(0, 3) || 'sample'}/`,
    entries: [
      {
        pos: '명사',
        meanings: hasHangul ? ['sample meaning'] : ['예시 의미'],
      },
    ],
    examples: [
      direction === 'ko-en'
        ? { ko: word, en: 'This is a sample translation.' }
        : { en: `A sentence with ${word}.`, ko: '예시 번역입니다.' },
      direction === 'ko-en'
        ? { ko: `${word}에 대한 두 번째 예시`, en: 'Second example in English.' }
        : { en: 'Another short example.', ko: '또 다른 예시 문장입니다.' },
    ],
  };
}

// ----- Stage 전환 로직 -----
function ensureStage(record, target) {
  record.stage = target;
  record.updatedAt = Date.now();
}

function handleAdvanceToPeer(record) {
  const stage = Number(record.stage || 1);
  const group = String(record.group || '').toUpperCase();
  if (stage === 2) {
    if (!record.draftText) {
      throw createHttpError(400, '2단계 메모를 먼저 저장하세요.');
    }
    if (group === 'C') {
      ensureStage(record, 4);
    } else {
      ensureStage(record, 3);
    }
  } else if (stage === 3) {
    if (!record.notesText) {
      throw createHttpError(400, '3단계 메모를 먼저 저장하세요.');
    }
    ensureStage(record, 4);
  } else if (stage < 2) {
    ensureStage(record, 2);
  }
}

function handleAdvanceToFinal(record) {
  const group = String(record.group || '').toUpperCase();
  const stage = Number(record.stage || 1);
  if ((group === 'A' || group === 'B') && !record.notesText) {
    throw createHttpError(400, '3단계 메모를 먼저 저장하세요.');
  }
  if (group !== 'C' && stage < 3) {
    throw createHttpError(400, '최종 단계로 이동하기 전에 이전 단계를 완료하세요.');
  }
  if (!record.draftText) {
    throw createHttpError(400, '2단계 메모를 먼저 저장하세요.');
  }
  record.finalText = record.finalText || '';
  ensureStage(record, 4);
}

function handleJump(record, desired) {
  const group = String(record.group || '').toUpperCase();
  const currentStage = Number(record.stage || 1);
  if (desired === 3 && !(group === 'A' || group === 'B')) {
    throw createHttpError(400, '해당 집단은 3단계가 없습니다.');
  }
  if (desired === currentStage) return;
  const movingForward = desired > currentStage;
  if (movingForward) {
    if (desired === 2 && !record.preText) {
      throw createHttpError(400, '사전 글쓰기를 먼저 제출하세요.');
    }
    if (desired === 3 && !record.draftText) {
      throw createHttpError(400, '2단계 메모를 먼저 저장하세요.');
    }
    if (desired === 4) {
      if (group === 'A' || group === 'B') {
        if (!record.notesText) throw createHttpError(400, '3단계 메모를 먼저 저장하세요.');
      } else if (group === 'C') {
        if (!record.draftText) throw createHttpError(400, '2단계 메모를 먼저 저장하세요.');
      } else if (!record.finalText && !record.finalSubmittedAt) {
        throw createHttpError(400, '최종 단계로 이동 조건이 충족되지 않았습니다.');
      }
    }
  } else {
    if (desired === 2 && !record.preText) {
      throw createHttpError(400, '사전 글쓰기를 먼저 제출하세요.');
    }
    if (desired === 3 && !record.draftText) {
      throw createHttpError(400, '2단계 메모를 먼저 저장하세요.');
    }
  }
  ensureStage(record, desired);
}

function handleRegress(record) {
  const currentStage = Number(record.stage || 1);
  const group = String(record.group || '').toUpperCase();
  if (currentStage <= 1) return;
  if (currentStage === 2) ensureStage(record, 1);
  else if (currentStage === 3) ensureStage(record, 2);
  else if (currentStage >= 4) ensureStage(record, group === 'C' ? 2 : 3);
}

// ----- AI 클라이언트/설정 -----
const openAiClient =
  process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL
    ? new (OpenAI.default || OpenAI)({
        apiKey: process.env.OPENAI_API_KEY || '',
        baseURL: process.env.OPENAI_BASE_URL || undefined,
        organization: process.env.OPENAI_ORG || undefined,
      })
    : null;

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_MODEL =
  process.env.PERPLEXITY_MODEL || 'llama-3.1-sonar-small-128k-online';
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || '';
const AI_TEMPERATURE =
  typeof process.env.AI_TEMPERATURE !== 'undefined'
    ? Number(process.env.AI_TEMPERATURE)
    : 0.6;

// ----- Express 미들웨어 -----
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(createHttpError(403, 'CORS 차단: 허용되지 않은 Origin'), false);
  },
};
app.use(cors(corsOptions));

// API Key 검증 (선택)
const REQUIRED_API_KEY = process.env.API_KEY || '';
app.use((req, res, next) => {
  if (!REQUIRED_API_KEY || !req.path.startsWith(API_PREFIX)) return next();
  const headerKey = req.headers['x-api-key'] || '';
  if (headerKey === REQUIRED_API_KEY) return next();
  return next(createHttpError(401, 'API 키가 유효하지 않습니다.'));
});

// ----- 라우트 정의 -----
const router = express.Router();

router.get('/server/diag', (_req, res) => {
  res.json({
    ok: true,
    dataDir: DATA_DIR,
    publicDir: PUBLIC_DIR,
    sessions: store.sessions.length,
    messages: store.messages.length,
    time: new Date().toISOString(),
  });
});

router.get('/public-settings', (_req, res) => {
  res.json(store.publicSettings || defaultPublicSettings());
});

router.post('/session/start', async (req, res, next) => {
  try {
    const { group, studentId, studentName } = req.body || {};
    requireBodyFields(req.body, ['group', 'studentId', 'studentName']);
    const record = ensureSession(group, studentId, studentName);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.get('/session/:sessionKey', (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/prewriting', async (req, res, next) => {
  try {
    requireBodyFields(req.body, ['text']);
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    if (record.preText) throw createHttpError(400, '이미 사전 글쓰기가 제출되었습니다.');
    record.preText = String(req.body.text || '').trim();
    record.preSubmittedAt = Date.now();
    if ((record.stage || 1) < 2) ensureStage(record, 2);
    record.updatedAt = Date.now();
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/draft', async (req, res, next) => {
  try {
    requireBodyFields(req.body, ['text']);
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    record.draftText = String(req.body.text || '').trim();
    record.draftSavedAt = Date.now();
    if ((record.stage || 1) < 2) ensureStage(record, 2);
    record.updatedAt = Date.now();
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/notes', async (req, res, next) => {
  try {
    requireBodyFields(req.body, ['text']);
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    record.notesText = String(req.body.text || '').trim();
    record.notesUpdatedAt = Date.now();
    const group = String(record.group || '').toUpperCase();
    if ((record.stage || 1) < 3 && (group === 'A' || group === 'B')) {
      ensureStage(record, 3);
    }
    record.updatedAt = Date.now();
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/final', async (req, res, next) => {
  try {
    requireBodyFields(req.body, ['text']);
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    const text = String(req.body.text || '').trim();
    if (!text) throw createHttpError(400, '최종 제출할 글이 없습니다.');
    record.finalText = text;
    record.finalSubmittedAt = Date.now();
    ensureStage(record, 4);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/advance', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    handleAdvanceToPeer(record);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/advance-final', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    handleAdvanceToFinal(record);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/jump', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    const desired = Math.min(5, Math.max(1, Number(req.body?.stage || 0) || 1));
    handleJump(record, desired);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/regress', async (req, res, next) => {
  try {
    const key = decodeURIComponent(req.params.sessionKey);
    const record = findSession(key);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    handleRegress(record);
    await store.saveSessions();
    res.json(buildSessionState(record));
  } catch (err) {
    next(err);
  }
});

router.post('/session/:sessionKey/presence/touch', (req, res) => {
  const key = decodeURIComponent(req.params.sessionKey);
  const record = findSession(key);
  if (!record) return res.status(404).json({ ok: false, message: '세션을 찾을 수 없습니다.' });
  const result = touchPresence(record.roomId, record.studentId);
  res.json(result);
});

router.post('/session/:sessionKey/presence/leave', (req, res) => {
  const key = decodeURIComponent(req.params.sessionKey);
  const record = findSession(key);
  if (record) {
    markLeave(record.roomId, record.studentId);
  }
  res.json({ ok: true });
});

router.get('/chat/:channel/messages', (req, res, next) => {
  try {
    const { channel } = req.params;
    const sessionId = req.query.sessionId;
    const since = Number(req.query.since || 0) || 0;
    if (!sessionId) throw createHttpError(400, 'sessionId가 필요합니다.');
    const list = store.messages
      .filter((m) => m.channel === channel && m.sessionId === sessionId && Number(m.ts || 0) > since)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

router.post('/chat/:channel/send', async (req, res, next) => {
  try {
    const { channel } = req.params;
    const { sessionId, group, userId, userName, role, text, metadata } = req.body || {};
    requireBodyFields(req.body, ['sessionId', 'text']);
    const ts = Date.now();
    const message = {
      ts,
      sessionId,
      roomId: metadata?.roomId || '',
      channel,
      group: String(group || '').toUpperCase(),
      senderId: userId || '',
      senderName: userName || '',
      role: role || 'user',
      text: String(text || ''),
      ext: metadata || {},
    };
    store.messages.push(message);
    await store.saveMessages();
    res.json({ ok: true, ts });
  } catch (err) {
    next(err);
  }
});

router.post('/chat/ai/respond', async (req, res, next) => {
  try {
    const { sessionId, group, userMessage, context, metadata } = req.body || {};
    requireBodyFields(req.body, ['sessionId', 'userMessage']);
    const sessionInfo = resolveSessionInfo(sessionId, metadata);
    const stage = sessionInfo.stage || 1;
    const effectiveGroup = (sessionInfo.group || group || '').toUpperCase();
    const provider = resolveAiProvider(stage, effectiveGroup);
    const text = await generateAiFeedback(userMessage, effectiveGroup, context, {
      provider,
      stage,
      sessionId,
    });
    const ts = Date.now();
    const message = {
      ts,
      sessionId,
      channel: 'ai-feedback',
      group: effectiveGroup,
      senderId: 'AI',
      senderName: 'AI',
      role: 'ai',
      text,
      ext: { ...(req.body?.metadata || {}), provider, stage },
    };
    store.messages.push(message);
    await store.saveMessages();
    res.json({ ok: true, text, ts });
  } catch (err) {
    next(err);
  }
});

router.get('/dictionary', (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) throw createHttpError(400, '검색어를 입력하세요.');
    res.json(buildDictionaryResult(q));
  } catch (err) {
    next(err);
  }
});

app.use(API_PREFIX, router);

// 정적 파일 서빙(가능한 경우)
if (PUBLIC_DIR) {
  app.use(express.static(PUBLIC_DIR));

  const serveHtml = (file) => (req, res, next) =>
    res.sendFile(path.join(PUBLIC_DIR, file), (err) => {
      if (err) next(err);
    });

  app.get('/admin', serveHtml('admin.html'));
  app.get('/chat', serveHtml('chat.html'));
  app.get('/modal', serveHtml('modal.html'));
}

// 헬스체크
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// 404 핸들링
app.use((req, res, next) => {
  if (req.path.startsWith(API_PREFIX)) {
    return next(createHttpError(404, 'API 경로를 찾을 수 없습니다.'));
  }
  return next();
});

// 에러 핸들러
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const message = err.message || '서버 오류가 발생했습니다.';
  console.error('[ERROR]', status, message);
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[writingresearch] Listening on http://localhost:${PORT}`);
  console.log(`- API: http://localhost:${PORT}${API_PREFIX}`);
  if (PUBLIC_DIR) {
    console.log(`- Static: ${PUBLIC_DIR}`);
  }
});

// ----- 보조 -----
function resolveSessionInfo(sessionId, metadata) {
  const metaKey = metadata?.sessionKey || '';
  const derivedKey =
    typeof sessionId === 'string' && sessionId.startsWith('ai:')
      ? sessionId.slice(3)
      : '';
  const sessionKey = metaKey || derivedKey;
  const record = sessionKey
    ? store.sessions.find((s) => s.sessionKey === sessionKey)
    : null;
  return {
    sessionKey,
    stage: record ? Number(record.stage || 1) : undefined,
    group: record ? record.group : undefined,
  };
}

function resolveAiProvider(stage, group) {
  const s = Number(stage || 1);
  const g = String(group || '').toUpperCase();
  // 2차시(스테이지 1): Perplexity 검색형
  if (s <= 1) return 'perplexity';
  // 3-1차시(스테이지 2): ChatGPT gpt-4.1-mini
  if (s === 2) return 'openai';
  // 3-2차시 이상: ChatGPT gpt-4.1 평가
  return 'openai';
}

function buildTranscriptText(sessionId) {
  if (!sessionId) return '';
  const list = (store.messages || []).filter(
    (m) => m.channel === 'ai-feedback' && m.sessionId === sessionId
  );
  if (!list.length) return '';
  const lines = list
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .map((m) => {
      const role = m.role || m.senderId || '';
      return `${role}: ${m.text || ''}`;
    });
  return lines.join('\n');
}

async function summarizeTranscript(text) {
  if (!text || !text.trim()) return '';
  const systemPrompt =
    '다음은 학생과 AI의 토론 로그입니다. 핵심 주장, 근거, 반론을 짧게 요약하고, 양측 입장을 균형 있게 정리하세요.';
  return callOpenAiChat({
    message: text,
    contextText: '',
    model: 'gpt-4.1',
    systemPrompt,
  });
}

async function resolvePublicDir() {
  const candidates = [
    path.resolve(__dirname, '..', 'public'),
    path.resolve(__dirname, '..', '..'),
  ];
  for (const dir of candidates) {
    try {
      const stat = await awaitStat(dir);
      if (stat?.isDirectory()) {
        return dir;
      }
    } catch (_err) {
      continue;
    }
  }
  return null;
}

async function awaitStat(dir) {
  try {
    return await fs.stat(dir);
  } catch (_err) {
    return null;
  }
}


