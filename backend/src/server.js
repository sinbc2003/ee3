import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import OpenAI from 'openai';
import ExcelJS from 'exceljs';
import { Storage } from '@google-cloud/storage';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;
const API_PREFIX = '/api';
const DATA_DIR = path.resolve(
  process.env.LOCAL_DATA_DIR || path.join(__dirname, '..', '..', 'local-data')
);
const PUBLIC_DIR = await resolvePublicDir();
const PRESENCE_TTL_MS = 20_000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '159753tt!';
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const adminTokens = new Map();
const DATA_BUCKET = process.env.DATA_BUCKET || '';
const DATA_BUCKET_PREFIX = process.env.DATA_BUCKET_PREFIX || 'local-data';
const storageClient = DATA_BUCKET ? new Storage() : null;
const dataBucket = DATA_BUCKET && storageClient ? storageClient.bucket(DATA_BUCKET) : null;

const app = express();

// ----- 초기화: 데이터 디렉터리 -----
await fs.mkdir(DATA_DIR, { recursive: true });

// ----- 스토리지 유틸 -----
class FileStore {
  constructor(rootDir, { bucket = null, bucketPrefix = 'local-data' } = {}) {
    this.rootDir = rootDir;
    this.bucket = bucket;
    this.bucketPrefix = bucketPrefix;
    this.sessions = [];
    this.messages = [];
    this.matchups = [];
    this.publicSettings = defaultPublicSettings();
    this.roster = defaultRoster();
    this.adminOverrides = defaultAdminOverrides();
  }

  async init() {
    this.sessions = await this.readJson('sessions.json', []);
    this.messages = await this.readJson('messages.json', []);
    this.matchups = await this.readJson('matchups.json', []);
    this.publicSettings = await this.readJson(
      'public-settings.json',
      defaultPublicSettings()
    );
    this.publicSettings = sanitizePublicSettings({}, this.publicSettings);
    this.roster = await this.readJson('roster.json', defaultRoster());
    this.adminOverrides = await this.readJson(
      'admin-config.json',
      defaultAdminOverrides()
    );
  }

  async readJson(filename, fallback) {
    if (this.bucket) {
      try {
        const [contents] = await this.bucket
          .file(this.buildBucketPath(filename))
          .download();
        return JSON.parse(contents.toString('utf8'));
      } catch (err) {
        if (err.code !== 404) {
          console.warn('[FileStore] Failed to read from bucket', filename, err.message);
        }
      }
    }
    return this.readJsonFromDisk(filename, fallback);
  }

  async readJsonFromDisk(filename, fallback) {
    const filePath = path.join(this.rootDir, filename);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    } catch (_err) {
      return fallback;
    }
  }

  async writeJson(filename, data) {
    const json = JSON.stringify(data, null, 2);
    if (this.bucket) {
      try {
        await this.bucket
          .file(this.buildBucketPath(filename))
          .save(json, { contentType: 'application/json' });
      } catch (err) {
        console.error('[FileStore] Failed to write to bucket', filename, err.message);
      }
    }
    const filePath = path.join(this.rootDir, filename);
    await fs.writeFile(filePath, json, 'utf8');
  }

  buildBucketPath(filename) {
    return `${this.bucketPrefix}/${filename}`;
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

  async saveMatchups() {
    await this.writeJson('matchups.json', this.matchups);
  }

  async savePublicSettings() {
    await this.writeJson('public-settings.json', this.publicSettings);
  }

  async saveRoster(roster) {
    this.roster = roster;
    await this.writeJson('roster.json', this.roster);
  }

  async saveAdminOverrides(overrides) {
    this.adminOverrides = overrides;
    await this.writeJson('admin-config.json', this.adminOverrides);
  }
}

const store = new FileStore(DATA_DIR, {
  bucket: dataBucket,
  bucketPrefix: DATA_BUCKET_PREFIX,
});
await store.init();

const baseAiConfig = buildBaseAiConfig();
let runtimeOverrides = sanitizeOverrides(store.adminOverrides || defaultAdminOverrides());
let effectiveAiConfig = mergeAiConfig(baseAiConfig, runtimeOverrides);
let openAiClient = null;
let openAiClientSignature = '';

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
    stageLabels: defaultStageLabels(),
    stagePrompts: defaultStagePrompts(),
    stageLabelsTypeB: defaultStageLabelsTypeB(),
    stagePromptsTypeB: defaultStagePromptsTypeB(),
  };
}

function defaultStageLabels() {
  return [
    {
      name: '2차시',
      headline: '논거 점검',
      description: '찬·반 입장으로 질문하며 논거를 점검하세요. 정답 생성 대신 토론 연습에 집중합니다.',
    },
    {
      name: '3차시-1',
      headline: 'ChatGPT 모의 토론 (gpt-4.1-mini)',
      description: 'AI와 토론을 이어가며 핵심 반론과 근거를 정리하세요.',
    },
    {
      name: '3차시-2',
      headline: '동료 토론',
      description: '동료와 상호 피드백을 주고받으며 글을 다듬으세요.',
    },
    {
      name: '4차시-1',
      headline: '4-1차시 토론 발문',
      description: '관리자가 제공한 발문을 다시 확인하고 논리를 점검하세요.',
    },
    {
      name: '4차시-2',
      headline: '4-2차시 정리',
      description: '4-1차시 기록을 요약하고 추가 메모를 정리하세요.',
    },
  ];
}

function defaultStagePrompts() {
  return [
    {
      reference:
        '찬·반 논거를 조사하며 핵심 근거와 반론거리를 메모하세요. AI 웹검색을 활용해 다양한 출처를 탐색해 보세요.',
      aiPrompt:
        '당신은 학생의 토론 준비를 돕는 AI 웹연구 도우미입니다. 학생이 던지는 질문에 대해, 공정하게 찬성과 반대 측 근거를 모두 제시하고, 신뢰할 만한 출처 정보도 간단히 언급하세요. 답변은 핵심 bullet 2~3개 중심으로, 쉬운 문장으로 작성합니다.',
    },
    { reference: '', aiPrompt: '' },
    { reference: '', aiPrompt: '' },
    {
      reference:
        '4-1차시 토론 발문을 확인하고, AI와 심층 토론을 이어가세요. 주장·근거·반론을 명확하게 정리해 보세요.',
      aiPrompt:
        '당신은 학생의 찬반 토론을 도와주는 AI 멘토입니다. 학생의 주장에 날카로운 질문을 던지고, 근거의 빈틈을 짚어 주며, 구체적인 사례/통계를 제안해 주세요.',
    },
    {
      reference:
        '4-1차시 대화를 요약하고, 최종 주장을 정리하세요. 필요한 경우 AI에게 추가 설명을 요청할 수 있습니다.',
      aiPrompt: '',
    },
  ];
}

function defaultStageLabelsTypeB() {
  return [
    {
      name: '1차시',
      headline: '주제 탐구',
      description: '논제를 이해하고, 배경 지식을 빠르게 정리합니다.',
    },
    {
      name: '2차시',
      headline: '관점 정리',
      description: '찬성/반대 관점을 나눠 핵심 근거를 정리합니다.',
    },
    {
      name: '3차시',
      headline: '3-1/3-2 토론',
      description: 'AI와 토론을 진행하며, 3-1/3-2 단계에서 질문·답변을 기록합니다.',
    },
    {
      name: '4차시',
      headline: '4-1/4-2 평가',
      description: 'AI 평가와 추가 피드백을 받아 논리를 보완합니다.',
    },
    {
      name: '5차시',
      headline: '최종 정리',
      description: '모든 토론 내용을 요약하고 최종 주장을 완성합니다.',
    },
  ];
}

function defaultStagePromptsTypeB() {
  return [
    {
      reference: '주제와 배경 정보, 이해한 핵심 개념을 간단히 정리하세요.',
      aiPrompt:
        '당신은 학생의 주제 탐구를 돕는 가이드입니다. 핵심 개념과 필요한 배경 정보를 짧고 명확하게 안내하고, 추가로 조사할 키워드를 제안하세요.',
    },
    {
      reference: '찬성/반대 관점에서 떠오르는 주장과 근거를 나열하세요.',
      aiPrompt:
        '학생이 제시하는 근거를 검토하고, 양측 관점에서 빠진 논거가 없는지 점검하도록 도와주세요.',
    },
    {
      reference: '3-1/3-2 단계에서 사용할 질문, 예상 반론, 보강할 논지를 적어두세요.',
      aiPrompt:
        '학생의 주장에 대해 비판적 질문을 던지고, 추가로 조사할 키워드를 제안하며 토론을 확장하도록 유도하세요.',
    },
    {
      reference: '4-1/4-2 단계에서 받은 AI 피드백을 정리하고, 보완할 내용을 메모하세요.',
      aiPrompt:
        '학생의 논리 전개를 평가하고, 반론에 대비할 수 있도록 구체적인 수정 제안을 제공하세요.',
    },
    {
      reference: '최종 주장의 핵심을 요약하고, 다음 활동에 필요한 체크리스트를 작성하세요.',
      aiPrompt: '',
    },
  ];
}

function defaultRoster() {
  return { students: [], pairings: [] };
}

function defaultAdminOverrides() {
  return {
    provider: null,
    temperature: null,
    systemPrompt: null,
    openai: {
      model: null,
      baseUrl: null,
      organization: null,
      apiKey: null,
    },
    perplexity: {
      model: null,
      apiKey: null,
    },
  };
}

function buildBaseAiConfig() {
  return {
    provider: (process.env.AI_PROVIDER || '').trim().toLowerCase() || 'auto',
    temperature: parseEnvNumber(process.env.AI_TEMPERATURE),
    systemPrompt: process.env.AI_SYSTEM_PROMPT || '',
    openai: {
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      organization: process.env.OPENAI_ORG || '',
      apiKey: process.env.OPENAI_API_KEY || '',
    },
    perplexity: {
      model: process.env.PERPLEXITY_MODEL || 'llama-3.1-sonar-small-128k-online',
      apiKey: process.env.PERPLEXITY_API_KEY || '',
    },
  };
}

function parseEnvNumber(value) {
  if (typeof value === 'undefined' || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function sanitizeOverrides(input = {}) {
  const safe = defaultAdminOverrides();
  if (typeof input.provider === 'string') safe.provider = input.provider.trim() || null;
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)) {
    safe.temperature = input.temperature;
  } else if (input.temperature === null) {
    safe.temperature = null;
  }
  if (typeof input.systemPrompt === 'string') safe.systemPrompt = input.systemPrompt;

  if (input.openai && typeof input.openai === 'object') {
    safe.openai.model =
      typeof input.openai.model === 'string' ? input.openai.model.trim() || null : null;
    safe.openai.baseUrl =
      typeof input.openai.baseUrl === 'string'
        ? input.openai.baseUrl.trim() || null
        : null;
    safe.openai.organization =
      typeof input.openai.organization === 'string'
        ? input.openai.organization.trim() || null
        : null;
    if (Object.prototype.hasOwnProperty.call(input.openai, 'apiKey')) {
      if (input.openai.apiKey === null) {
        safe.openai.apiKey = '';
      } else if (typeof input.openai.apiKey === 'string') {
        safe.openai.apiKey = input.openai.apiKey.trim();
      }
    } else if (store?.adminOverrides?.openai?.apiKey) {
      safe.openai.apiKey = store.adminOverrides.openai.apiKey;
    }
  } else if (store?.adminOverrides?.openai?.apiKey) {
    safe.openai.apiKey = store.adminOverrides.openai.apiKey;
  }

  if (input.perplexity && typeof input.perplexity === 'object') {
    safe.perplexity.model =
      typeof input.perplexity.model === 'string'
        ? input.perplexity.model.trim() || null
        : null;
    if (Object.prototype.hasOwnProperty.call(input.perplexity, 'apiKey')) {
      if (input.perplexity.apiKey === null) {
        safe.perplexity.apiKey = '';
      } else if (typeof input.perplexity.apiKey === 'string') {
        safe.perplexity.apiKey = input.perplexity.apiKey.trim();
      }
    } else if (store?.adminOverrides?.perplexity?.apiKey) {
      safe.perplexity.apiKey = store.adminOverrides.perplexity.apiKey;
    }
  } else if (store?.adminOverrides?.perplexity?.apiKey) {
    safe.perplexity.apiKey = store.adminOverrides.perplexity.apiKey;
  }

  return safe;
}

function mergeAiConfig(base, overrides) {
  const result = {
    provider: base.provider,
    temperature: base.temperature,
    systemPrompt: base.systemPrompt,
    openai: { ...base.openai },
    perplexity: { ...base.perplexity },
  };
  if (overrides.provider) result.provider = overrides.provider;
  if (typeof overrides.temperature === 'number') result.temperature = overrides.temperature;
  if (overrides.systemPrompt !== null && overrides.systemPrompt !== undefined) {
    result.systemPrompt = overrides.systemPrompt;
  }
  if (overrides.openai) {
    if (overrides.openai.model !== null && overrides.openai.model !== undefined) {
      result.openai.model = overrides.openai.model;
    }
    if (overrides.openai.baseUrl !== null && overrides.openai.baseUrl !== undefined) {
      result.openai.baseUrl = overrides.openai.baseUrl;
    }
    if (
      overrides.openai.organization !== null &&
      overrides.openai.organization !== undefined
    ) {
      result.openai.organization = overrides.openai.organization;
    }
    if (
      Object.prototype.hasOwnProperty.call(overrides.openai, 'apiKey') &&
      overrides.openai.apiKey !== undefined &&
      overrides.openai.apiKey !== null
    ) {
      result.openai.apiKey = overrides.openai.apiKey;
    }
  }
  if (overrides.perplexity) {
    if (
      overrides.perplexity.model !== null &&
      overrides.perplexity.model !== undefined
    ) {
      result.perplexity.model = overrides.perplexity.model;
    }
    if (
      Object.prototype.hasOwnProperty.call(overrides.perplexity, 'apiKey') &&
      overrides.perplexity.apiKey !== undefined &&
      overrides.perplexity.apiKey !== null
    ) {
      result.perplexity.apiKey = overrides.perplexity.apiKey;
    }
  }
  return result;
}

function getEffectiveAiConfig() {
  return effectiveAiConfig;
}

async function applyAdminOverrides(overrides) {
  runtimeOverrides = sanitizeOverrides(overrides);
  await store.saveAdminOverrides(runtimeOverrides);
  effectiveAiConfig = mergeAiConfig(baseAiConfig, runtimeOverrides);
  openAiClient = null;
  openAiClientSignature = '';
}

function issueAdminToken() {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminTokens.set(token, { expiresAt });
  return { token, expiresAt };
}

function extractAdminToken(req) {
  const header = req.headers.authorization || '';
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return '';
}

function validateAdminToken(token) {
  if (!token) return false;
  const session = adminTokens.get(token);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    adminTokens.delete(token);
    return false;
  }
  return true;
}

function requireAdminAuth(req, _res, next) {
  const token = extractAdminToken(req);
  if (!validateAdminToken(token)) {
    return next(createHttpError(401, '관리자 인증이 필요합니다.'));
  }
  req.adminToken = token;
  return next();
}

function revokeAdminToken(token) {
  if (token && adminTokens.has(token)) {
    adminTokens.delete(token);
  }
}

function buildAdminConfigResponse() {
  const effective = getEffectiveAiConfig();
  const overrides = store.adminOverrides || defaultAdminOverrides();
  const redactOverrideKeys = (section) => {
    if (!section) return {};
    const result = { ...section };
    if (Object.prototype.hasOwnProperty.call(result, 'apiKey')) {
      result.hasApiKey = !!result.apiKey;
      delete result.apiKey;
    }
    return result;
  };
  return {
    ai: {
      provider: effective.provider,
      temperature: effective.temperature,
      systemPrompt: effective.systemPrompt,
      openai: {
        model: effective.openai.model,
        baseUrl: effective.openai.baseUrl,
        organization: effective.openai.organization,
        hasApiKey: !!effective.openai.apiKey,
      },
      perplexity: {
        model: effective.perplexity.model,
        hasApiKey: !!effective.perplexity.apiKey,
      },
    },
    overrides: {
      provider: overrides.provider,
      temperature: overrides.temperature,
      systemPrompt: overrides.systemPrompt,
      openai: redactOverrideKeys(overrides.openai),
      perplexity: redactOverrideKeys(overrides.perplexity),
    },
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

function buildPartnerSnapshot(record) {
  if (!record) return null;
  if (record.partnerStudentId) {
    const partner = store.sessions.find(
      (s) => s.group === record.group && s.studentId === record.partnerStudentId
    );
    if (partner) {
      return {
        id: partner.studentId || '',
        name: partner.studentName || '',
        sessionKey: partner.sessionKey || '',
      };
    }
    return {
      id: record.partnerStudentId || '',
      name: record.partnerName || '',
      sessionKey: '',
    };
  }
  if (record.partnerName) {
    return {
      id: record.partnerStudentId || '',
      name: record.partnerName,
      sessionKey: '',
    };
  }
  return null;
}

function buildAdminSessionSummary(record) {
  if (!record) return null;
  return {
    sessionKey: record.sessionKey,
    group: record.group,
    stage: Number(record.stage || 1),
    createdAt: Number(record.createdAt || 0),
    updatedAt: Number(record.updatedAt || 0),
    user: {
      id: record.studentId || '',
      name: record.studentName || '',
    },
    partner: buildPartnerSnapshot(record),
  };
}

function buildAdminSessionDetail(record) {
  if (!record) return null;
  const summary = buildAdminSessionSummary(record);
  return {
    sessionKey: summary.sessionKey,
    mode: summary.group,
    stage: summary.stage,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    aiSessionId: `ai:${record.sessionKey}`,
    peerSessionId: record.roomId ? `peer:${record.roomId}` : '',
    you: summary.user,
    partner: summary.partner,
    writing: {
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
    },
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

  const provider = options.provider || resolveAiProvider(options.stage, group) || 'openai';
  const stage = Number(options.stage || 1);
  const sessionId = options.sessionId || '';
  const evalPrompt = options.evalPrompt || '';
  const config = getEffectiveAiConfig();
  const typeKey = mapGroupToTypeKey(group);
  const stagePrompt = getStagePrompt(stage, typeKey);
  const stageSystemPrompt = typeof stagePrompt?.aiPrompt === 'string' ? stagePrompt.aiPrompt.trim() : '';

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
      systemPrompt: stageSystemPrompt || evalPrompt || config.systemPrompt,
    });
  }

  if (provider === 'perplexity') {
    return callPerplexityChat({
      message: trimmed,
      contextText,
      systemPrompt: stageSystemPrompt || config.systemPrompt,
    });
  }
  return callOpenAiChat({
    message: trimmed,
    contextText,
    systemPrompt: stageSystemPrompt || evalPrompt || config.systemPrompt,
  });
}

async function callOpenAiChat({ message, contextText, model, systemPrompt, temperature }) {
  const client = ensureOpenAiClient();
  const config = getEffectiveAiConfig();
  const modelName = model || config.openai.model || 'gpt-4.1-mini';
  const prompt =
    typeof systemPrompt === 'string' && systemPrompt.trim()
      ? systemPrompt
      : config.systemPrompt || '';
  const messages = [];
  if (prompt) messages.push({ role: 'system', content: prompt });
  if (contextText) {
    messages.push({ role: 'system', content: `[참고]\n${contextText}` });
  }
  messages.push({ role: 'user', content: message });
  const selectedTemp =
    typeof temperature === 'number' && Number.isFinite(temperature)
      ? temperature
      : getEffectiveTemperature();
  const resp = await client.chat.completions.create({
    model: modelName,
    messages,
    temperature: selectedTemp,
  });
  const text = resp?.choices?.[0]?.message?.content || '';
  return text.trim() || '응답을 생성하지 못했습니다.';
}

async function callPerplexityChat({ message, contextText, systemPrompt }) {
  const config = getEffectiveAiConfig();
  const apiKey = config.perplexity.apiKey || '';
  if (!apiKey) {
    throw createHttpError(500, 'Perplexity API 키가 설정되지 않았습니다.');
  }
  const effectivePrompt = typeof systemPrompt === 'string' && systemPrompt.trim()
    ? systemPrompt
    : config.systemPrompt || '';
  const modelName = config.perplexity.model || 'llama-3.1-sonar-small-128k-online';
  const messages = [];
  if (effectivePrompt) messages.push({ role: 'system', content: effectivePrompt });
  if (contextText) {
    messages.push({ role: 'system', content: `[참고]\n${contextText}` });
  }
  messages.push({ role: 'user', content: message });

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
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
function ensureOpenAiClient() {
  const config = getEffectiveAiConfig();
  const apiKey = config.openai.apiKey || '';
  if (!apiKey) {
    throw createHttpError(500, 'OpenAI API 키가 설정되지 않았습니다.');
  }
  const signature = [
    apiKey,
    config.openai.baseUrl || '',
    config.openai.organization || '',
  ].join('|');
  if (!openAiClient || openAiClientSignature !== signature) {
    openAiClient = new (OpenAI.default || OpenAI)({
      apiKey,
      baseURL: config.openai.baseUrl || undefined,
      organization: config.openai.organization || undefined,
    });
    openAiClientSignature = signature;
  }
  return openAiClient;
}

function getEffectiveTemperature() {
  const config = getEffectiveAiConfig();
  return Number.isFinite(config.temperature) ? config.temperature : 0.6;
}

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
const adminRouter = express.Router();

adminRouter.post('/login', (req, res, next) => {
  try {
    const password = String(req.body?.password || '');
    if (!ADMIN_PASSWORD) {
      throw createHttpError(500, '관리자 비밀번호가 설정되지 않았습니다.');
    }
    if (password !== ADMIN_PASSWORD) {
      throw createHttpError(401, '비밀번호가 올바르지 않습니다.');
    }
    const session = issueAdminToken();
    res.json(session);
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/logout', requireAdminAuth, (req, res) => {
  revokeAdminToken(req.adminToken);
  res.json({ ok: true });
});

adminRouter.use(requireAdminAuth);

adminRouter.get('/config', (_req, res) => {
  res.json(buildAdminConfigResponse());
});

adminRouter.post('/config', async (req, res, next) => {
  try {
    await applyAdminOverrides(req.body || {});
    res.json(buildAdminConfigResponse());
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/public-settings', (_req, res) => {
  res.json(store.publicSettings || defaultPublicSettings());
});

adminRouter.post('/public-settings', async (req, res, next) => {
  try {
    store.publicSettings = sanitizePublicSettings(req.body || {}, store.publicSettings);
    await store.savePublicSettings();
    res.json(store.publicSettings);
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/sessions', (_req, res) => {
  const sessions =
    store.sessions?.map((record) => buildAdminSessionSummary(record)) || [];
  res.json({ sessions });
});

adminRouter.get('/sessions/:sessionKey', (req, res, next) => {
  try {
    const record = findSession(req.params.sessionKey);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    res.json({ session: buildAdminSessionDetail(record) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/sessions/:sessionKey/chats/:channel', (req, res, next) => {
  try {
    const record = findSession(req.params.sessionKey);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    const channel = req.params.channel;
    if (channel === 'ai') {
      const sessionId = `ai:${record.sessionKey}`;
      return res.json({ messages: collectMessages(sessionId, 'ai-feedback') });
    }
    if (channel === 'peer') {
      const sessionId = record.roomId ? `peer:${record.roomId}` : '';
      const messages = sessionId ? collectMessages(sessionId, 'peer-chat') : [];
      return res.json({ messages });
    }
    throw createHttpError(400, '알 수 없는 채널입니다.');
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/sessions/:sessionKey/partner', async (req, res, next) => {
  try {
    const sessionKey = req.params.sessionKey;
    const record = findSession(sessionKey);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    await assignPartnerRecord(record, req.body || {});
    await store.saveSessions();
    res.json({ session: buildAdminSessionDetail(record) });
  } catch (err) {
    next(err);
  }
});

adminRouter.delete('/sessions/:sessionKey/partner', async (req, res, next) => {
  try {
    const record = findSession(req.params.sessionKey);
    if (!record) throw createHttpError(404, '세션을 찾을 수 없습니다.');
    await clearPartnerRecord(record);
    await store.saveSessions();
    res.json({ session: buildAdminSessionDetail(record) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/sessions/bulk-delete', async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body?.sessionKeys) ? req.body.sessionKeys : [];
    if (!keys.length) throw createHttpError(400, '삭제할 세션이 없습니다.');
    const result = await deleteSessionsByKeys(keys);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/sessions/export', async (req, res, next) => {
  try {
    const format = String(req.query?.format || 'xlsx').toLowerCase();
    if (format !== 'xlsx') {
      throw createHttpError(400, '지원하지 않는 내보내기 형식입니다.');
    }
    const scopes = parseExportScopes(req.query?.scopes);
    const workbook = await buildExportWorkbook(scopes);
    const buffer = await workbook.xlsx.writeBuffer();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="writingresearch-export-${stamp}.xlsx"`
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/roster', (_req, res) => {
  res.json(store.roster || defaultRoster());
});

adminRouter.post('/roster', async (req, res, next) => {
  try {
    const { students, pairings } = normalizeRosterPayload(req.body || {});
    const roster = { students, pairings };
    await store.saveRoster(roster);
    store.matchups = pairings.map((pair) => ({
      studentIdA: pair.primary.id,
      nameA: pair.primary.name || '',
      studentIdB: pair.partner.id,
      nameB: pair.partner.name || '',
      group: inferGroupFromId(pair.primary.id),
    }));
    await store.saveMatchups();
    res.json(roster);
  } catch (err) {
    next(err);
  }
});

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

app.use(`${API_PREFIX}/admin`, adminRouter);
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
  const config = getEffectiveAiConfig();
  if (config.provider && config.provider !== 'auto') {
    return config.provider;
  }
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

function sanitizePublicSettings(payload, currentSettings = store.publicSettings) {
  const base = {
    ...defaultPublicSettings(),
    ...(currentSettings || {}),
  };
  if (Object.prototype.hasOwnProperty.call(payload, 'topLinkUrl') && typeof payload.topLinkUrl === 'string') {
    base.topLinkUrl = payload.topLinkUrl.trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'topLinkText') && typeof payload.topLinkText === 'string') {
    base.topLinkText = payload.topLinkText.trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'aiAvatarUrl') && typeof payload.aiAvatarUrl === 'string') {
    base.aiAvatarUrl = payload.aiAvatarUrl.trim();
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'promptContent') && typeof payload.promptContent === 'string') {
    base.promptContent = payload.promptContent;
  }
  if (Array.isArray(payload.stageLabels)) {
    base.stageLabels = normalizeStageLabels(payload.stageLabels, base.stageLabels);
  }
  if (Array.isArray(payload.stagePrompts)) {
    base.stagePrompts = normalizeStagePrompts(payload.stagePrompts, base.stagePrompts);
  }
  if (Array.isArray(payload.stageLabelsTypeB)) {
    base.stageLabelsTypeB = normalizeStageLabels(payload.stageLabelsTypeB, base.stageLabelsTypeB);
  }
  if (Array.isArray(payload.stagePromptsTypeB)) {
    base.stagePromptsTypeB = normalizeStagePrompts(payload.stagePromptsTypeB, base.stagePromptsTypeB);
  }
  return base;
}

function normalizeStageLabels(list, fallback) {
  const source = Array.isArray(fallback) && fallback.length ? fallback : defaultStageLabels();
  const normalized = source.map((item, idx) => {
    const incoming = Array.isArray(list) && list[idx] ? list[idx] : {};
    return {
      name:
        typeof incoming.name === 'string'
          ? incoming.name.trim()
          : typeof item.name === 'string'
            ? item.name
            : '',
      headline:
        typeof incoming.headline === 'string'
          ? incoming.headline.trim()
          : typeof item.headline === 'string'
            ? item.headline
            : '',
      description:
        typeof incoming.description === 'string'
          ? incoming.description.trim()
          : typeof item.description === 'string'
            ? item.description
            : '',
    };
  });
  return normalized;
}

function normalizeStagePrompts(list, fallback) {
  const source = Array.isArray(fallback) && fallback.length ? fallback : defaultStagePrompts();
  return source.map((item, idx) => {
    const incoming = Array.isArray(list) && list[idx] ? list[idx] : {};
    return {
      reference:
        typeof incoming.reference === 'string'
          ? incoming.reference
          : typeof item.reference === 'string'
            ? item.reference
            : '',
      aiPrompt:
        typeof incoming.aiPrompt === 'string'
          ? incoming.aiPrompt
          : typeof item.aiPrompt === 'string'
            ? item.aiPrompt
            : '',
    };
  });
}

function mapGroupToTypeKey(group) {
  return String(group || '').toUpperCase() === 'B' ? 'typeB' : 'typeA';
}

function getStageLabelsByType(typeKey = 'typeA') {
  if (typeKey === 'typeB') {
    return store.publicSettings?.stageLabelsTypeB || defaultStageLabelsTypeB();
  }
  return store.publicSettings?.stageLabels || defaultStageLabels();
}

function getStagePromptsByType(typeKey = 'typeA') {
  if (typeKey === 'typeB') {
    return store.publicSettings?.stagePromptsTypeB || defaultStagePromptsTypeB();
  }
  return store.publicSettings?.stagePrompts || defaultStagePrompts();
}

function getStagePrompt(stage, typeKey = 'typeA') {
  const idx = Math.max(0, Math.min(defaultStagePrompts().length - 1, Number(stage || 1) - 1));
  const prompts = getStagePromptsByType(typeKey);
  return prompts[idx] || getStagePromptsByType('typeA')[idx] || defaultStagePrompts()[idx];
}

function getStageLabelName(stage, typeKey = 'typeA') {
  const idx = Math.max(0, Math.min(defaultStageLabels().length - 1, Number(stage || 1) - 1));
  const labels = getStageLabelsByType(typeKey);
  return labels[idx]?.name || `단계 ${stage}`;
}

function collectMessages(sessionId, channel) {
  if (!sessionId || !channel) return [];
  return (store.messages || [])
    .filter((msg) => msg.channel === channel && msg.sessionId === sessionId)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .map((msg) => ({
      ts: Number(msg.ts || 0),
      text: msg.text || '',
      senderName: msg.senderName || '',
      role: msg.role || '',
    }));
}

async function assignPartnerRecord(record, payload) {
  if (!record) return;
  const partnerSessionKey = String(payload?.partnerSessionKey || '').trim();
  const partnerId = String(payload?.partnerId || '').trim();
  const partnerName = String(payload?.partnerName || '').trim();
  let partnerRecord = null;
  if (partnerSessionKey) {
    partnerRecord = findSession(partnerSessionKey);
  }
  if (!partnerRecord && partnerId) {
    partnerRecord = store.sessions.find(
      (s) => s.group === record.group && s.studentId === partnerId
    );
  }
  if (partnerRecord && partnerRecord.sessionKey === record.sessionKey) {
    throw createHttpError(400, '자기 자신과 매칭할 수 없습니다.');
  }
  if (partnerRecord) {
    const roomId =
      record.roomId ||
      partnerRecord.roomId ||
      makePairRoomId(record.sessionKey, partnerRecord.sessionKey);
    record.roomId = roomId;
    partnerRecord.roomId = roomId;
    record.partnerStudentId = partnerRecord.studentId;
    record.partnerName = partnerRecord.studentName;
    partnerRecord.partnerStudentId = record.studentId;
    partnerRecord.partnerName = record.studentName;
    record.updatedAt = Date.now();
    partnerRecord.updatedAt = Date.now();
  } else {
    record.partnerStudentId = partnerId || '';
    record.partnerName = partnerName || '';
    record.updatedAt = Date.now();
  }
}

async function clearPartnerRecord(record) {
  if (!record) return;
  if (record.partnerStudentId) {
    const partner = store.sessions.find(
      (s) => s.group === record.group && s.studentId === record.partnerStudentId
    );
    if (partner && partner.partnerStudentId === record.studentId) {
      partner.partnerStudentId = '';
      partner.partnerName = '';
      partner.updatedAt = Date.now();
    }
  }
  record.partnerStudentId = '';
  record.partnerName = '';
  record.updatedAt = Date.now();
}

async function deleteSessionsByKeys(keys) {
  const keySet = new Set((keys || []).map((key) => String(key || '').trim()).filter(Boolean));
  if (!keySet.size) {
    return { deleted: 0 };
  }
  const removedSessionIds = new Set();
  const removedPeerIds = new Set();
  const removedStudentIds = new Set();
  for (const record of store.sessions) {
    if (keySet.has(record.sessionKey)) {
      removedSessionIds.add(`ai:${record.sessionKey}`);
      if (record.roomId) removedPeerIds.add(`peer:${record.roomId}`);
      removedStudentIds.add(record.studentId);
      presenceMap.delete(`${record.roomId}|${record.studentId}`);
    }
  }
  store.sessions = store.sessions.filter((record) => !keySet.has(record.sessionKey));
  store.sessions.forEach((record) => {
    if (removedStudentIds.has(record.partnerStudentId)) {
      record.partnerStudentId = '';
      record.partnerName = '';
    }
  });
  store.messages = store.messages.filter(
    (msg) =>
      !removedSessionIds.has(msg.sessionId || '') && !removedPeerIds.has(msg.sessionId || '')
  );
  await store.saveSessions();
  await store.saveMessages();
  return { deleted: removedSessionIds.size };
}

function parseExportScopes(input) {
  if (!input) return ['all'];
  const raw =
    typeof input === 'string'
      ? input.split(',')
      : Array.isArray(input)
        ? input
        : ['all'];
  const normalized = raw
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  return normalized.length ? normalized : ['all'];
}

async function buildExportWorkbook(scopes) {
  const workbook = new ExcelJS.Workbook();
  const sessions = (store.sessions || []).map((record) => buildAdminSessionDetail(record));
  addSummarySheet(workbook, sessions);
  if (shouldIncludeScope(scopes, 'stage1')) {
    addStageSheet(workbook, 'Stage1', sessions, (session) => session.writing.prewriting);
  }
  if (shouldIncludeScope(scopes, 'stage2')) {
    addStageSheet(workbook, 'Stage2', sessions, (session) => session.writing.draft);
  }
  if (shouldIncludeScope(scopes, 'stage3')) {
    addStageSheet(workbook, 'Stage3', sessions, (session) => session.writing.notes);
  }
  if (shouldIncludeScope(scopes, 'final')) {
    addStageSheet(workbook, 'Final', sessions, (session) => session.writing.final);
  }
  if (shouldIncludeScope(scopes, 'ai-chat')) {
    addChatSheet(workbook, 'AI Chat', sessions, (session) => ({
      sessionId: `ai:${session.sessionKey}`,
      channel: 'ai-feedback',
    }));
  }
  return workbook;
}

function shouldIncludeScope(scopes, value) {
  return scopes.includes('all') || scopes.includes(value);
}

function addSummarySheet(workbook, sessions) {
  const sheet = workbook.addWorksheet('Sessions');
  sheet.columns = [
    { header: 'Session Key', key: 'sessionKey', width: 24 },
    { header: 'Group', key: 'group', width: 10 },
    { header: 'Student ID', key: 'studentId', width: 16 },
    { header: 'Student Name', key: 'studentName', width: 20 },
    { header: 'Stage', key: 'stage', width: 10 },
    { header: 'Partner', key: 'partner', width: 24 },
    { header: 'Updated At', key: 'updatedAt', width: 22 },
  ];
  sessions.forEach((session) => {
    sheet.addRow({
      sessionKey: session.sessionKey,
      group: session.mode,
      studentId: session.you?.id || '',
      studentName: session.you?.name || '',
      stage: session.stage,
      partner: session.partner
        ? `${session.partner.name || ''} (${session.partner.id || ''})`
        : '',
      updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : '',
    });
  });
}

function addStageSheet(workbook, name, sessions, accessor) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: 'Session Key', key: 'sessionKey', width: 24 },
    { header: 'Student ID', key: 'studentId', width: 16 },
    { header: 'Student Name', key: 'studentName', width: 20 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Content', key: 'content', width: 80 },
  ];
  sessions.forEach((session) => {
    const block = accessor(session);
    if (!block) return;
    sheet.addRow({
      sessionKey: session.sessionKey,
      studentId: session.you?.id || '',
      studentName: session.you?.name || '',
      timestamp: block.submittedAt || block.savedAt || block.updatedAt
        ? new Date(block.submittedAt || block.savedAt || block.updatedAt).toISOString()
        : '',
      content: block.text || '',
    });
  });
}

function addChatSheet(workbook, name, sessions, resolver) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: 'Session Key', key: 'sessionKey', width: 24 },
    { header: 'Student ID', key: 'studentId', width: 16 },
    { header: 'Student Name', key: 'studentName', width: 20 },
    { header: 'Timestamp', key: 'timestamp', width: 22 },
    { header: 'Sender', key: 'sender', width: 20 },
    { header: 'Message', key: 'message', width: 80 },
  ];
  sessions.forEach((session) => {
    const { sessionId, channel } = resolver(session);
    const messages = collectMessages(sessionId, channel);
    messages.forEach((msg) => {
      sheet.addRow({
        sessionKey: session.sessionKey,
        studentId: session.you?.id || '',
        studentName: session.you?.name || '',
        timestamp: msg.ts ? new Date(msg.ts).toISOString() : '',
        sender: msg.senderName || msg.role || '',
        message: msg.text || '',
      });
    });
  });
}

function normalizeRosterPayload(body) {
  const rawStudents = Array.isArray(body.students) ? body.students : [];
  const rawPairings = Array.isArray(body.pairings) ? body.pairings : [];
  const students = rawStudents
    .map((item) => ({
      id: String(item.id || '').trim(),
      name: String(item.name || '').trim(),
    }))
    .filter((item) => item.id || item.name);
  const filteredStudents = students.filter((item) => item.id);
  const idSet = new Set(filteredStudents.map((item) => item.id.toLowerCase()));
  const pairings = rawPairings
    .map((pair) => ({
      primary: {
        id: String(pair?.primary?.id || '').trim(),
        name: String(pair?.primary?.name || '').trim(),
      },
      partner: {
        id: String(pair?.partner?.id || '').trim(),
        name: String(pair?.partner?.name || '').trim(),
      },
    }))
    .filter((pair) => pair.primary.id && pair.partner.id)
    .filter(
      (pair) =>
        idSet.has(pair.primary.id.toLowerCase()) && idSet.has(pair.partner.id.toLowerCase())
    );
  return { students: filteredStudents, pairings };
}

function inferGroupFromId(id) {
  if (!id) return undefined;
  const prefix = String(id).trim().charAt(0).toUpperCase();
  return prefix || undefined;
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


