import { Storage } from '@google-cloud/storage';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const JSON_SPACING = 2;
const DEFAULT_ADMIN_CONFIG = {
  ai: {
    provider: '',
    systemPrompt: '',
    temperature: null,
    model: '',
    location: '',
    openai: {
      model: '',
      baseUrl: '',
      organization: ''
    }
  }
};

const DEFAULT_ROSTER = {
  students: [],
  pairings: []
};

function resolveLocalPath(rootDir, relativePath) {
  return path.resolve(rootDir, relativePath);
}

async function readLocalJson(filePath, fallback = null) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return JSON.parse(contents);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeLocalJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, JSON_SPACING), 'utf8');
}

export async function createDataStore(config) {
  const usingBucket = Boolean(config.dataBucket);
  const storage = usingBucket ? new Storage({ projectId: config.projectId || process.env.GCLOUD_PROJECT }) : null;
  const bucket = usingBucket ? storage.bucket(config.dataBucket) : null;
  const localRoot = usingBucket ? null : resolveLocalPath(process.cwd(), config.localDataDir || '../local-data');

  async function readJson(relativePath, fallback = null) {
    if (usingBucket) {
      const file = bucket.file(relativePath);
      const [exists] = await file.exists();
      if (!exists) return fallback;
      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf8'));
    }
    const absolute = resolveLocalPath(localRoot, relativePath);
    return readLocalJson(absolute, fallback);
  }

  async function writeJson(relativePath, data) {
    if (usingBucket) {
      const file = bucket.file(relativePath);
      await file.save(JSON.stringify(data, null, JSON_SPACING), { contentType: 'application/json' });
      return;
    }
    const absolute = resolveLocalPath(localRoot, relativePath);
    await writeLocalJson(absolute, data);
  }

  async function deleteFile(relativePath) {
    if (usingBucket) {
      const file = bucket.file(relativePath);
      try {
        await file.delete({ ignoreNotFound: true });
      } catch (error) {
        if (error.code !== 404) throw error;
      }
      return;
    }
    const absolute = resolveLocalPath(localRoot, relativePath);
    try {
      await fs.unlink(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function appendJsonArray(relativePath, item) {
    const list = (await readJson(relativePath, [])) || [];
    list.push(item);
    await writeJson(relativePath, list);
    return item;
  }

  async function ensureDirectories() {
    if (!usingBucket && localRoot) {
      await fs.mkdir(resolveLocalPath(localRoot, 'sessions'), { recursive: true });
      await fs.mkdir(resolveLocalPath(localRoot, 'chats/ai'), { recursive: true });
      await fs.mkdir(resolveLocalPath(localRoot, 'chats/peer'), { recursive: true });
      await fs.mkdir(resolveLocalPath(localRoot, 'settings'), { recursive: true });
    }
  }

  await ensureDirectories();

  async function getSession(sessionKey) {
    if (!sessionKey) return null;
    return readJson(`sessions/${sessionKey}.json`, null);
  }

  async function saveSession(sessionKey, data) {
    if (!sessionKey) throw new Error('sessionKey is required');
    const payload = { ...data, sessionKey };
    await writeJson(`sessions/${sessionKey}.json`, payload);
    return payload;
  }

  async function updateSession(sessionKey, updater) {
    if (!sessionKey) throw new Error('sessionKey is required');
    const current = (await readJson(`sessions/${sessionKey}.json`, null)) || null;
    if (!current) throw new Error('세션을 찾을 수 없습니다.');
    const updated = (await updater({ ...current })) || current;
    updated.updatedAt = Date.now();
    await writeJson(`sessions/${sessionKey}.json`, updated);
    return updated;
  }

  async function listSessions() {
    if (usingBucket) {
      const [files] = await bucket.getFiles({ prefix: 'sessions/' });
      return files.map((file) => file.name.replace('sessions/', '').replace('.json', ''));
    }
    try {
      const files = await fs.readdir(resolveLocalPath(localRoot, 'sessions'));
      return files.filter((file) => file.endsWith('.json')).map((file) => file.replace('.json', ''));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function appendChatMessage(sessionId, channel, message) {
    const relativePath = `chats/${channel}/${sessionId}.json`;
    const history = (await readJson(relativePath, [])) || [];
    history.push(message);
    await writeJson(relativePath, history);
    return message;
  }

  async function getChatMessages(sessionId, channel, sinceTs = 0) {
    const relativePath = `chats/${channel}/${sessionId}.json`;
    const history = (await readJson(relativePath, [])) || [];
    if (!sinceTs) return history;
    return history.filter((item) => Number(item.ts || 0) > Number(sinceTs));
  }

  async function getChatHistory(sessionId, channel) {
    return readJson(`chats/${channel}/${sessionId}.json`, []);
  }

  async function getPublicSettings() {
    return readJson('settings/public.json', {
      promptContent: '',
      aiAvatarUrl: '/chatgpt.png'
    });
  }

  async function savePublicSettings(data = {}) {
    const current = await getPublicSettings();
    const next = {
      promptContent: Object.prototype.hasOwnProperty.call(data, 'promptContent')
        ? String(data.promptContent || '').trim()
        : String(current.promptContent || ''),
      aiAvatarUrl: Object.prototype.hasOwnProperty.call(data, 'aiAvatarUrl')
        ? String(data.aiAvatarUrl || '').trim()
        : String(current.aiAvatarUrl || '')
    };
    await writeJson('settings/public.json', next);
    return next;
  }

  async function getAdminConfig() {
    return readJson('settings/admin-config.json', DEFAULT_ADMIN_CONFIG);
  }

  async function saveAdminConfig(data) {
    const payload = {
      ai: {
        ...DEFAULT_ADMIN_CONFIG.ai,
        ...(data.ai || {}),
        openai: {
          ...DEFAULT_ADMIN_CONFIG.ai.openai,
          ...((data.ai && data.ai.openai) || {})
        }
      }
    };
    await writeJson('settings/admin-config.json', payload);
    return payload;
  }

function normalizeRosterEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    const seen = new Set();
    const normalized = [];
    for (const entry of list) {
      if (!entry) continue;
      const id = String(entry.id || '').trim();
      const name = String(entry.name || '').trim();
      if (!id && !name) continue;
      const key = `${id.toLowerCase()}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({ id, name });
    }
    return normalized;
  }

function normalizeRosterPairings(entries, students = []) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set();
  const studentNameMap = new Map(
    (Array.isArray(students) ? students : []).map((student) => [String(student.id || '').trim().toLowerCase(), String(student.name || '').trim()])
  );
  const normalized = [];
  for (const entry of list) {
    if (!entry) continue;
    const primarySource = entry.primary || entry.a || entry.studentA || entry.source || entry.left || {};
    const partnerSource = entry.partner || entry.b || entry.studentB || entry.target || entry.right || {};
    const primaryIdRaw = primarySource.id ?? entry.primaryId ?? entry.idA ?? entry.student_id_a ?? entry.student_id ?? entry.leftId;
    const partnerIdRaw = partnerSource.id ?? entry.partnerId ?? entry.idB ?? entry.student_id_b ?? entry.partner_student_id ?? entry.rightId;
    const primaryId = String(primaryIdRaw || '').trim();
    const partnerId = String(partnerIdRaw || '').trim();
    if (!primaryId || !partnerId) continue;
    const primaryKey = primaryId.toLowerCase();
    const partnerKey = partnerId.toLowerCase();
    if (primaryKey === partnerKey) continue;
    const dedupeKey = [primaryKey, partnerKey].sort().join('|');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const primaryName = String(primarySource.name || studentNameMap.get(primaryKey) || '').trim();
    const partnerName = String(partnerSource.name || studentNameMap.get(partnerKey) || '').trim();
    normalized.push({
      primary: {
        id: primaryId,
        name: primaryName
      },
      partner: {
        id: partnerId,
        name: partnerName
      }
    });
  }
  return normalized;
}

  async function getRoster() {
    const stored = await readJson('settings/roster.json', DEFAULT_ROSTER);
    const students = normalizeRosterEntries(stored?.students || []);
    const pairings = normalizeRosterPairings(stored?.pairings || [], students);
    return { students, pairings };
  }

  async function saveRoster(data) {
    const source = data && data.students ? data.students : data;
    const students = normalizeRosterEntries(source);
    const pairings = normalizeRosterPairings((data && data.pairings) || [], students);
    await writeJson('settings/roster.json', { students, pairings });
    return { students, pairings };
  }

  async function deleteSession(sessionKey, meta = null) {
    if (!sessionKey) throw new Error('sessionKey is required');
    const session = meta || (await getSession(sessionKey));
    await deleteFile(`sessions/${sessionKey}.json`);
    if (session?.aiSessionId) {
      await deleteFile(`chats/ai/${session.aiSessionId}.json`);
    }
    if (session?.peerSessionId) {
      await deleteFile(`chats/peer/${session.peerSessionId}.json`);
    }
    return { sessionKey };
  }

  async function getServerDiag() {
    const sessions = await listSessions();
    return {
      ok: true,
      sessions: sessions.length,
      dataBucket: config.dataBucket || null,
      storageMode: usingBucket ? 'gcs' : 'local'
    };
  }

  return {
    getSession,
    saveSession,
    updateSession,
    listSessions,
    appendChatMessage,
    getChatMessages,
    getChatHistory,
    getPublicSettings,
    savePublicSettings,
    getAdminConfig,
    saveAdminConfig,
    getRoster,
    saveRoster,
    deleteSession,
    getServerDiag
  };
}

