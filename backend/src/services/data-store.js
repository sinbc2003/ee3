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
      apiKey: '',
      model: '',
      baseUrl: '',
      organization: ''
    }
  }
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
      aiAvatarUrl: ''
    });
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
    getAdminConfig,
    saveAdminConfig,
    getServerDiag
  };
}

