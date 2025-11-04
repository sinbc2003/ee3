import crypto from 'node:crypto';

const EMPTY_OVERRIDES = { ai: {} };
const EMPTY_PUBLIC_SETTINGS = { promptContent: '', aiAvatarUrl: '' };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeString(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sanitizeOverridesForStorage(overrides = {}) {
  const sourceAi = overrides.ai ? overrides.ai : overrides;
  const ai = clone({ ai: sourceAi || {} }).ai || {};
  if (ai.temperature !== undefined) {
    const t = toNumber(ai.temperature, undefined);
    if (t === undefined) delete ai.temperature;
    else ai.temperature = t;
  }
  ai.openai = { ...(ai.openai || {}) };
  return { ai };
}

function summarizeForClient(effective, overrides) {
  const ai = effective.ai || {};
  const aiOverrides = overrides.ai || {};
  return {
    ai: {
      provider: ai.provider || 'none',
      enabled: Boolean(ai.enabled),
      systemPrompt: ai.systemPrompt || '',
      temperature: ai.temperature ?? null,
      vertex: {
        model: ai.model || '',
        location: ai.location || ''
      },
      openai: {
        model: ai.openai?.model || '',
        baseUrl: ai.openai?.baseUrl || '',
        organization: ai.openai?.organization || '',
        hasApiKey: Boolean(ai.openai?.apiKey)
      }
    },
    overrides: {
      provider: aiOverrides.provider || aiOverrides.aiProvider || '',
      systemPrompt: aiOverrides.systemPrompt || '',
      temperature: aiOverrides.temperature ?? null,
      vertex: {
        model: aiOverrides.model || '',
        location: aiOverrides.location || ''
      },
      openai: {
        model: aiOverrides.openai?.model || '',
        baseUrl: aiOverrides.openai?.baseUrl || '',
        organization: aiOverrides.openai?.organization || '',
        hasApiKey: Boolean(aiOverrides.openai?.apiKey)
      }
    }
  };
}

function sanitizeRosterStudents(students = []) {
  if (!Array.isArray(students)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of students) {
    if (!entry) continue;
    const id = sanitizeString(entry.id);
    const name = sanitizeString(entry.name);
    if (!id && !name) continue;
    const key = `${id.toLowerCase()}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ id, name });
  }
  return normalized;
}

function sanitizeRosterPairings(pairings = []) {
  if (!Array.isArray(pairings)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of pairings) {
    if (!entry) continue;
    const primaryId = sanitizeString(entry.primary?.id);
    const partnerId = sanitizeString(entry.partner?.id);
    if (!primaryId || !partnerId) continue;
    const primaryKey = primaryId.toLowerCase();
    const partnerKey = partnerId.toLowerCase();
    if (primaryKey === partnerKey) continue;
    const key = [primaryKey, partnerKey].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      primary: {
        id: primaryId,
        name: sanitizeString(entry.primary?.name)
      },
      partner: {
        id: partnerId,
        name: sanitizeString(entry.partner?.name)
      }
    });
  }
  return normalized;
}

export function createAdminService({ config, dataStore, aiResponder }) {
  if (!config || !dataStore || !aiResponder) {
    throw new Error('config, dataStore, aiResponder가 필요합니다.');
  }

  const tokens = new Map();
  const tokenTtlMs = Math.max(60, Number(config.admin?.tokenTtl || 3600)) * 1000;

  function resolvePassword() {
    return process.env.ADMIN_PASSWORD || config.admin?.password || '159753tt!';
  }

  function verifyPassword(password) {
    return typeof password === 'string' && password === resolvePassword();
  }

  function issueToken() {
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + tokenTtlMs;
    tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  function validateToken(token) {
    if (!token || !tokens.has(token)) return false;
    const expiresAt = tokens.get(token);
    if (Date.now() > expiresAt) {
      tokens.delete(token);
      return false;
    }
    tokens.set(token, Date.now() + tokenTtlMs);
    return true;
  }

  function revokeToken(token) {
    if (token && tokens.has(token)) tokens.delete(token);
  }

  async function initialize() {
    if (!dataStore.getAdminConfig) return;
    const stored = await dataStore.getAdminConfig();
    if (stored && stored.ai) {
      aiResponder.setOverrides(stored);
    }
  }

  async function getConfig() {
    const overrides = dataStore.getAdminConfig ? await dataStore.getAdminConfig() : EMPTY_OVERRIDES;
    const effective = aiResponder.getEffectiveConfig();
    return summarizeForClient(effective, overrides || EMPTY_OVERRIDES);
  }

  function mergeConfig(current, incoming) {
    const next = sanitizeOverridesForStorage(current);
    const ai = next.ai;
    const payloadAi = incoming.ai ? incoming.ai : incoming;

    if ('provider' in payloadAi || 'aiProvider' in payloadAi) {
      ai.provider = (payloadAi.provider ?? payloadAi.aiProvider ?? '').trim();
    }
    if ('systemPrompt' in payloadAi) {
      ai.systemPrompt = payloadAi.systemPrompt ?? '';
    }
    if ('temperature' in payloadAi) {
      ai.temperature = toNumber(payloadAi.temperature, null);
    }
    if ('model' in payloadAi) {
      ai.model = payloadAi.model ?? '';
    }
    if ('location' in payloadAi) {
      ai.location = payloadAi.location ?? '';
    }

    if (payloadAi.vertex && typeof payloadAi.vertex === 'object') {
      if ('model' in payloadAi.vertex) ai.model = payloadAi.vertex.model ?? '';
      if ('location' in payloadAi.vertex) ai.location = payloadAi.vertex.location ?? '';
    }

    const incomingOpenAi = payloadAi.openai || {};
    const currentOpenAi = { ...ai.openai };
    if ('model' in incomingOpenAi) currentOpenAi.model = incomingOpenAi.model ?? '';
    if ('baseUrl' in incomingOpenAi) currentOpenAi.baseUrl = incomingOpenAi.baseUrl ?? '';
    if ('organization' in incomingOpenAi) currentOpenAi.organization = incomingOpenAi.organization ?? '';
    if ('apiKey' in incomingOpenAi) {
      if (incomingOpenAi.apiKey === null) {
        currentOpenAi.apiKey = '';
      } else if (typeof incomingOpenAi.apiKey === 'string' && incomingOpenAi.apiKey.trim()) {
        currentOpenAi.apiKey = incomingOpenAi.apiKey.trim();
      } else if (incomingOpenAi.apiKey !== '') {
        currentOpenAi.apiKey = incomingOpenAi.apiKey || '';
      }
      // 빈 문자열('')은 기존 키 유지
    }
    ai.openai = currentOpenAi;

    return { ai };
  }

  async function updateConfig(payload = {}) {
    const current = dataStore.getAdminConfig ? await dataStore.getAdminConfig() : EMPTY_OVERRIDES;
    const merged = mergeConfig(current || EMPTY_OVERRIDES, payload);
    const saved = await dataStore.saveAdminConfig(merged);
    aiResponder.setOverrides(saved);
    const effective = aiResponder.getEffectiveConfig();
    return summarizeForClient(effective, saved);
  }

  async function getRoster() {
    if (!dataStore.getRoster) return { students: [], pairings: [] };
    const roster = await dataStore.getRoster();
    return {
      students: sanitizeRosterStudents(roster?.students || []),
      pairings: sanitizeRosterPairings(roster?.pairings || [])
    };
  }

  async function replaceRoster(payload = {}) {
    const students = sanitizeRosterStudents(payload?.students || payload);
    const pairings = sanitizeRosterPairings(payload?.pairings || []);
    const saved = dataStore.saveRoster ? await dataStore.saveRoster({ students, pairings }) : { students, pairings };
    return {
      students: sanitizeRosterStudents(saved?.students || []),
      pairings: sanitizeRosterPairings(saved?.pairings || [])
    };
  }

  async function getPublicSettings() {
    if (!dataStore.getPublicSettings) return { ...EMPTY_PUBLIC_SETTINGS };
    const stored = await dataStore.getPublicSettings();
    return {
      promptContent: sanitizeString(stored?.promptContent),
      aiAvatarUrl: sanitizeString(stored?.aiAvatarUrl)
    };
  }

  async function updatePublicSettings(payload = {}) {
    const current = await getPublicSettings();
    const next = {
      promptContent: Object.prototype.hasOwnProperty.call(payload, 'promptContent')
        ? sanitizeString(payload.promptContent)
        : current.promptContent,
      aiAvatarUrl: Object.prototype.hasOwnProperty.call(payload, 'aiAvatarUrl')
        ? sanitizeString(payload.aiAvatarUrl)
        : current.aiAvatarUrl
    };
    const saved = await dataStore.savePublicSettings(next);
    return {
      promptContent: sanitizeString(saved?.promptContent),
      aiAvatarUrl: sanitizeString(saved?.aiAvatarUrl)
    };
  }

  return {
    initialize,
    verifyPassword,
    issueToken,
    validateToken,
    revokeToken,
    getTokenTtl: () => tokenTtlMs,
    getConfig,
    updateConfig,
    getPublicSettings,
    updatePublicSettings,
    getRoster,
    replaceRoster,
    sanitizeRosterPairings
  };
}

