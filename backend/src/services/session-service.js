import createError from 'http-errors';
import { v4 as uuid } from 'uuid';

const emptyWritingState = () => ({ text: '', submittedAt: 0, savedAt: 0, updatedAt: 0 });

function normalizeGroup(group) {
  const value = String(group || '').trim().toUpperCase();
  if (!['A', 'B', 'C'].includes(value)) {
    throw createError(400, '지원하지 않는 집단입니다. (A, B, C 중에서 선택)');
  }
  return value;
}

function ensureWriting(session) {
  session.writing = session.writing || {};
  session.writing.prewriting = session.writing.prewriting || { ...emptyWritingState() };
  session.writing.draft = session.writing.draft || { ...emptyWritingState() };
  session.writing.notes = session.writing.notes || { ...emptyWritingState() };
  session.writing.final = session.writing.final || { ...emptyWritingState() };
}

function ensureSteps(session) {
  session.steps = session.steps || {};
  session.steps.prewriting = session.steps.prewriting || { completed: false, submittedAt: 0 };
  session.steps.draft = session.steps.draft || { saved: false, savedAt: 0 };
  session.steps.notes = session.steps.notes || { saved: false, updatedAt: 0 };
  session.steps.final = session.steps.final || { submitted: false, submittedAt: 0 };
}

function getPreviousStage(session) {
  const current = Number(session.stage || 1);
  const group = normalizeGroup(session.mode || 'A');
  if (current <= 1) return 1;
  if (current === 2) return 1;
  if (current === 3) return 2;
  if (current >= 4) return group === 'C' ? 2 : 3;
  return Math.max(1, current - 1);
}

function advanceStageValue(session, target) {
  const current = Number(session.stage || 1);
  if (target > current) {
    session.stage = target;
  }
  return session.stage;
}

function computeNextStageForAdvance(session) {
  const group = session.mode ? normalizeGroup(session.mode) : 'A';
  const current = Number(session.stage || 1);
  if (current >= 4) return 4;
  if (group === 'C') return 4;
  if (current <= 2) return 3;
  return Math.min(4, current + 1);
}

export function createSessionService(dataStore) {
  if (!dataStore) throw new Error('dataStore가 필요합니다.');

  let rosterCache = null;
  let rosterPairingsCache = [];
  let rosterFetchedAt = 0;
  const ROSTER_CACHE_TTL = 60 * 1000;

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeIdForCompare(value) {
    return normalizeId(value).toLowerCase();
  }

  function normalizeName(value) {
    return String(value || '').trim();
  }

  function buildFallbackPairings(students = []) {
    const buckets = new Map();
    (Array.isArray(students) ? students : []).forEach((student) => {
      if (!student) return;
      const id = normalizeId(student.id);
      if (!id) return;
      const name = normalizeName(student.name);
      const groupKey = id.charAt(0).toUpperCase();
      if (!buckets.has(groupKey)) buckets.set(groupKey, []);
      buckets.get(groupKey).push({ id, name });
    });
    const seen = new Set();
    const fallback = [];
    for (const list of buckets.values()) {
      for (let i = 0; i + 1 < list.length; i += 2) {
        const first = list[i];
        const second = list[i + 1];
        const primaryKey = normalizeIdForCompare(first.id);
        const partnerKey = normalizeIdForCompare(second.id);
        if (!primaryKey || !partnerKey || primaryKey === partnerKey) continue;
        const dedupeKey = [primaryKey, partnerKey].sort().join('|');
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        fallback.push({
          primary: { id: first.id, name: first.name },
          partner: { id: second.id, name: second.name }
        });
      }
    }
    return fallback;
  }

  function normalizeRosterPairingsForCache(pairings = [], students = []) {
    const list = Array.isArray(pairings) ? pairings : [];
    const seen = new Set();
    const studentNameMap = new Map(
      (Array.isArray(students) ? students : []).map((student) => [normalizeIdForCompare(student.id), normalizeName(student.name)])
    );
    const normalized = [];
    for (const entry of list) {
      if (!entry) continue;
      const primaryId = normalizeId(entry.primary?.id);
      const partnerId = normalizeId(entry.partner?.id);
      if (!primaryId || !partnerId) continue;
      const primaryKey = normalizeIdForCompare(primaryId);
      const partnerKey = normalizeIdForCompare(partnerId);
      if (primaryKey === partnerKey) continue;
      const key = [primaryKey, partnerKey].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        primary: {
          id: primaryId,
          name: normalizeName(entry.primary?.name || studentNameMap.get(primaryKey) || '')
        },
        partner: {
          id: partnerId,
          name: normalizeName(entry.partner?.name || studentNameMap.get(partnerKey) || '')
        }
      });
    }
    if (!normalized.length) {
      const fallback = buildFallbackPairings(students);
      fallback.forEach((pair) => {
        const primaryKey = normalizeIdForCompare(pair.primary?.id);
        const partnerKey = normalizeIdForCompare(pair.partner?.id);
        if (!primaryKey || !partnerKey || primaryKey === partnerKey) return;
        const key = [primaryKey, partnerKey].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(pair);
      });
    }
    return normalized;
  }

  async function fetchRosterStudents(forceReload = false) {
    if (!dataStore.getRoster) {
      throw createError(500, '학생 명단 기능이 활성화되지 않았습니다.');
    }
    const now = Date.now();
    if (!forceReload && rosterCache && now - rosterFetchedAt < ROSTER_CACHE_TTL) {
      return rosterCache;
    }
    const roster = await dataStore.getRoster();
    const students = Array.isArray(roster?.students) ? roster.students : [];
    rosterCache = students.map((item) => ({
      id: normalizeId(item.id),
      name: normalizeName(item.name)
    }));
    rosterPairingsCache = normalizeRosterPairingsForCache(roster?.pairings || [], rosterCache);
    rosterFetchedAt = now;
    return rosterCache;
  }

  function findRosterPairingForStudent(studentId) {
    const target = normalizeIdForCompare(studentId);
    if (!target) return null;
    return (
      rosterPairingsCache.find(
        (pair) => normalizeIdForCompare(pair.primary?.id) === target || normalizeIdForCompare(pair.partner?.id) === target
      ) || null
    );
  }

  function resolvePartnerEntry(pair, studentId) {
    const target = normalizeIdForCompare(studentId);
    if (normalizeIdForCompare(pair.primary?.id) === target) return pair.partner;
    return pair.primary;
  }

  function buildPartnerSnapshot(session, fallback = {}, includeDetails = false) {
    const snapshot = {
      sessionKey: session?.sessionKey || '',
      id: normalizeId(fallback.id || session?.you?.id),
      name: normalizeName(session?.you?.name || fallback.name)
    };
    if (includeDetails && session) {
      ensureWriting(session);
      snapshot.stage = Number(session.stage || 1);
      const prewriting = session.writing?.prewriting || session.prewriting;
      const draft = session.writing?.draft || session.draft;
      const notes = session.writing?.notes || session.notes;
      if (prewriting) {
        snapshot.prewriting = {
          text: String(prewriting.text || ''),
          submittedAt: Number(prewriting.submittedAt || 0)
        };
      }
      if (draft) {
        snapshot.draft = {
          text: String(draft.text || ''),
          savedAt: Number(draft.savedAt || draft.updatedAt || 0)
        };
      }
      if (notes) {
        snapshot.notes = {
          text: String(notes.text || ''),
          updatedAt: Number(notes.updatedAt || notes.savedAt || 0)
        };
      }
    }
    return snapshot;
  }

  function buildPartnerPresence(session, fallback = {}) {
    return {
      sessionKey: session?.sessionKey || '',
      name: normalizeName(session?.you?.name || fallback.name),
      id: normalizeId(session?.you?.id || fallback.id),
      stage: Number(session?.stage || fallback.stage || 1),
      online: session?.presence?.self?.online ?? Boolean(fallback.online),
      lastSeen: Number(session?.presence?.self?.lastSeen || fallback.lastSeen || 0)
    };
  }

  function rememberRosterPairing(primary, partner) {
    if (!primary || !partner) return;
    const primaryId = normalizeId(primary.id);
    const partnerId = normalizeId(partner.id);
    if (!primaryId || !partnerId) return;
    const primaryKey = normalizeIdForCompare(primaryId);
    const partnerKey = normalizeIdForCompare(partnerId);
    if (!primaryKey || !partnerKey || primaryKey === partnerKey) return;
    const dedupeKey = [primaryKey, partnerKey].sort().join('|');
    if (rosterPairingsCache.some((entry) => {
      const entryKey = [normalizeIdForCompare(entry.primary?.id || ''), normalizeIdForCompare(entry.partner?.id || '')]
        .sort()
        .join('|');
      return entryKey === dedupeKey;
    })) {
      return;
    }
    rosterPairingsCache.push({
      primary: {
        id: primaryId,
        name: normalizeName(primary.name)
      },
      partner: {
        id: partnerId,
        name: normalizeName(partner.name)
      }
    });
  }

  async function updatePartnerMirrorPresence(session) {
    if (!session?.partner) return;
    const partnerInfo = session.partner;
    let partnerSession = null;
    if (partnerInfo.sessionKey) {
      try {
        partnerSession = await dataStore.getSession(partnerInfo.sessionKey);
      } catch (error) {
        partnerSession = null;
      }
    }
    if (!partnerSession && partnerInfo.id) {
      partnerSession = await findExistingSessionByStudentId(partnerInfo.id);
    }
    if (!partnerSession || partnerSession.sessionKey === session.sessionKey) return;
    await dataStore.updateSession(partnerSession.sessionKey, (record) => {
      record.presence = record.presence || {};
      record.presence.partner = buildPartnerPresence(session, {
        id: session.you?.id,
        name: session.you?.name
      });
      return record;
    });
  }

  async function determineSharedPeerSessionId(session, partnerSession) {
    const sessionPeerId = String(session?.peerSessionId || '').trim();
    const partnerPeerId = String(partnerSession?.peerSessionId || '').trim();
    let sharedId = sessionPeerId || partnerPeerId || uuid();
    let messagesA = [];
    let messagesB = [];
    if (sessionPeerId) {
      try {
        messagesA = await dataStore.getChatHistory(sessionPeerId, 'peer');
      } catch (error) {
        messagesA = [];
      }
    }
    if (partnerPeerId) {
      try {
        messagesB = await dataStore.getChatHistory(partnerPeerId, 'peer');
      } catch (error) {
        messagesB = [];
      }
    }
    if (sessionPeerId && partnerPeerId && sessionPeerId !== partnerPeerId) {
      if (messagesA.length && !messagesB.length) {
        sharedId = sessionPeerId;
      } else if (!messagesA.length && messagesB.length) {
        sharedId = partnerPeerId;
      } else if (!messagesA.length && !messagesB.length) {
        sharedId = sessionPeerId || partnerPeerId || uuid();
      } else {
        sharedId = uuid();
      }
    }
    if (!sharedId) sharedId = uuid();
    const mergeSources = [];
    const addSource = (id, messages) => {
      if (!id || id === sharedId || !Array.isArray(messages) || !messages.length) return;
      if (mergeSources.some((src) => src.id === id)) return;
      mergeSources.push({ id, messages });
    };
    if (sessionPeerId && sessionPeerId !== sharedId) addSource(sessionPeerId, messagesA);
    if (partnerPeerId && partnerPeerId !== sharedId) addSource(partnerPeerId, messagesB);
    return { sharedId, mergeSources };
  }

  async function mergePeerChatHistories(targetId, sources = []) {
    const target = String(targetId || '').trim();
    if (!target || !Array.isArray(sources) || !sources.length) return;
    let existing = [];
    try {
      existing = await dataStore.getChatHistory(target, 'peer');
    } catch (error) {
      existing = [];
    }
    const seen = new Set(existing.map((msg) => `${Number(msg.ts || 0)}|${msg.senderId || ''}|${msg.text || ''}`));
    for (const source of sources) {
      if (!source || !Array.isArray(source.messages) || !source.messages.length) continue;
      const sorted = [...source.messages].sort((a, b) => Number(a?.ts || 0) - Number(b?.ts || 0));
      for (const message of sorted) {
        if (!message) continue;
        const key = `${Number(message.ts || 0)}|${message.senderId || ''}|${message.text || ''}`;
        if (seen.has(key)) continue;
        await dataStore.appendChatMessage(target, 'peer', message);
        seen.add(key);
      }
    }
  }

  async function findExistingSessionByStudentId(studentId) {
    const target = normalizeIdForCompare(studentId);
    if (!target) return null;
    const keys = await dataStore.listSessions();
    if (!keys.length) return null;
    let candidate = null;
    for (const key of keys) {
      try {
        const session = await dataStore.getSession(key);
        if (!session?.you?.id) continue;
        if (normalizeIdForCompare(session.you.id) !== target) continue;
        if (!candidate) {
          candidate = session;
          continue;
        }
        const candidateUpdated = Number(candidate.updatedAt || candidate.createdAt || 0);
        const sessionUpdated = Number(session.updatedAt || session.createdAt || 0);
        if (sessionUpdated > candidateUpdated) {
          candidate = session;
        }
      } catch (error) {
        console.warn('기존 세션 조회 실패', error);
      }
    }
    return candidate;
  }

  async function ensureStudentAllowed(studentId, studentName) {
    const id = normalizeId(studentId);
    const name = normalizeName(studentName);
    if (!id) {
      throw createError(400, '식별 번호를 입력하세요.');
    }
    if (!name) {
      throw createError(400, '이름을 입력하세요.');
    }
    const roster = await fetchRosterStudents();
    if (!roster.length) {
      throw createError(403, '학생 명단이 비어 있습니다. 관리자에게 문의하세요.');
    }
    const matched = roster.find((student) => normalizeIdForCompare(student.id) === normalizeIdForCompare(id));
    if (!matched) {
      throw createError(403, '등록되지 않은 식별 번호입니다. 관리자에게 문의하세요.');
    }
    if (matched.name && normalizeName(matched.name) && normalizeName(matched.name) !== name) {
      throw createError(403, '등록된 이름과 일치하지 않습니다. 관리자에게 문의하세요.');
    }
    return {
      id: matched.id || id,
      name: matched.name || name
    };
  }

  async function ensurePartnerAllowed(partnerSessionKey, partnerId, partnerName) {
    if (partnerSessionKey) {
      return null;
    }
    const id = normalizeId(partnerId);
    const name = normalizeName(partnerName);
    if (!id) {
      throw createError(400, '동료 식별 번호를 입력하세요.');
    }
    const roster = await fetchRosterStudents();
    const matched = roster.find((student) => normalizeIdForCompare(student.id) === normalizeIdForCompare(id));
    if (!matched) {
      throw createError(404, '등록되지 않은 동료 식별 번호입니다.');
    }
    if (matched.name && name && normalizeName(matched.name) !== name) {
      throw createError(403, '동료 이름이 등록된 정보와 일치하지 않습니다.');
    }
    return {
      id: matched.id || id,
      name: matched.name || name
    };
  }

  async function startSession({ group, studentId, studentName }) {
    const normalizedGroup = normalizeGroup(group);
    const verifiedStudent = await ensureStudentAllowed(studentId, studentName);
    const existingSession = await findExistingSessionByStudentId(verifiedStudent.id);
    if (existingSession) {
      const updated = await dataStore.updateSession(existingSession.sessionKey, (session) => {
        ensureWriting(session);
        ensureSteps(session);
        const now = Date.now();
        session.mode = session.mode || normalizedGroup;
        session.you = {
          id: verifiedStudent.id,
          name: verifiedStudent.name
        };
        session.presence = session.presence || {};
        session.presence.self = {
          ...(session.presence.self || {}),
          online: true,
          lastSeen: now,
          stage: session.stage || 1,
          name: verifiedStudent.name,
          id: verifiedStudent.id
        };
        if (!session.aiSessionId) session.aiSessionId = existingSession.aiSessionId || uuid();
        if (!session.peerSessionId) session.peerSessionId = existingSession.peerSessionId || uuid();
        if (!session.createdAt) session.createdAt = existingSession.createdAt || now;
        return session;
      });
      return ensureRosterPairing(updated);
    }
    const now = Date.now();
    const sessionKey = uuid();
    const aiSessionId = uuid();
    const peerSessionId = uuid();
    const base = {
      sessionKey,
      createdAt: now,
      mode: normalizedGroup,
      you: { id: verifiedStudent.id, name: verifiedStudent.name },
      stage: 1,
      updatedAt: now,
      writing: {
        prewriting: { text: '', submittedAt: 0 },
        draft: { text: '', savedAt: 0 },
        notes: { text: '', updatedAt: 0 },
        final: { text: '', submittedAt: 0 }
      },
      steps: {
        prewriting: { completed: false, submittedAt: 0 },
        draft: { saved: false, savedAt: 0 },
        notes: { saved: false, updatedAt: 0 },
        final: { submitted: false, submittedAt: 0 }
      },
      partner: null,
      presence: {
        self: { online: true, lastSeen: now, stage: 1 },
        partner: null
      },
      aiSessionId,
      peerSessionId
    };
    const saved = await dataStore.saveSession(sessionKey, base);
    return ensureRosterPairing(saved);
  }

  async function ensureRosterPairing(session) {
    if (!session || !session.sessionKey || !session.you?.id) {
      return session;
    }
    const pair = findRosterPairingForStudent(session.you.id);
    if (!pair) return session;
    const partnerEntry = resolvePartnerEntry(pair, session.you.id) || {};
    const desiredPartnerId = normalizeId(partnerEntry.id);
    if (!desiredPartnerId) return session;
    const desiredPartnerKey = normalizeIdForCompare(desiredPartnerId);
    const currentPartnerKey = session.partner?.id ? normalizeIdForCompare(session.partner.id) : '';
    const selfKey = normalizeIdForCompare(session.you.id);

    if (currentPartnerKey && currentPartnerKey !== desiredPartnerKey) {
      return session;
    }

    const partnerSession = await findExistingSessionByStudentId(desiredPartnerId);
    if (!partnerSession) {
      if (!currentPartnerKey) {
        return dataStore.updateSession(session.sessionKey, (record) => {
          ensureWriting(record);
          ensureSteps(record);
          rememberRosterPairing({ id: session.you?.id, name: session.you?.name }, partnerEntry);
          record.partner = {
            sessionKey: '',
            name: normalizeName(partnerEntry.name),
            id: desiredPartnerId
          };
          record.presence = record.presence || {};
          record.presence.partner = {
            ...(record.presence.partner || {}),
            sessionKey: '',
            name: normalizeName(partnerEntry.name),
            id: desiredPartnerId,
            stage: 1,
            online: false,
            lastSeen: 0
          };
          return record;
        });
      }
      return session;
    }
    const partnerCurrentKey = partnerSession.partner?.id ? normalizeIdForCompare(partnerSession.partner.id) : '';
    if (partnerCurrentKey && partnerCurrentKey !== selfKey) {
      return session;
    }

    const { sharedId, mergeSources } = await determineSharedPeerSessionId(session, partnerSession);
    const partnerSnapshot = buildPartnerSnapshot(partnerSession, partnerEntry);
    const partnerPresence = buildPartnerPresence(partnerSession, partnerEntry);
    const selfSnapshot = buildPartnerSnapshot(session, { id: session.you.id, name: session.you.name });
    const selfPresence = buildPartnerPresence(session, { id: session.you.id, name: session.you.name });

    const [updatedSession, updatedPartner] = await Promise.all([
      dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        rememberRosterPairing(session.you || { id: session.you?.id, name: session.you?.name }, partnerEntry);
        record.partner = buildPartnerSnapshot(partnerSession, partnerEntry, true);
        record.presence = record.presence || {};
        record.presence.partner = partnerPresence;
        record.peerSessionId = sharedId;
        return record;
      }),
      dataStore.updateSession(partnerSession.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        record.partner = buildPartnerSnapshot(session, { id: session.you?.id, name: session.you?.name }, true);
        record.presence = record.presence || {};
        record.presence.partner = selfPresence;
        record.peerSessionId = sharedId;
        return record;
      })
    ]);
    if (mergeSources.length) {
      await mergePeerChatHistories(sharedId, mergeSources);
    }
    await Promise.all([updatePartnerMirrorPresence(updatedSession), updatePartnerMirrorPresence(updatedPartner)]);
    return updatedSession;
  }

  async function getSessionState(sessionKey) {
    const session = await dataStore.getSession(sessionKey);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }
    // 세션 상태 조회 시마다 동료 매칭을 다시 확인하여 동료가 나중에 로그인한 경우에도 매칭되도록 함
    const updated = await ensureRosterPairing(session);
    return updated;
  }

  async function listSessions() {
    const keys = await dataStore.listSessions();
    if (!keys.length) return [];
    const sessions = await Promise.all(keys.map((key) => dataStore.getSession(key)));
    return sessions
      .filter(Boolean)
      .map((session) => ({
        sessionKey: session.sessionKey,
        group: session.mode,
        user: session.you,
        stage: session.stage,
        createdAt: Number(session.createdAt || session.updatedAt || 0),
        updatedAt: Number(session.updatedAt || 0),
        writing: {
          prewritingSubmittedAt: Number(session.writing?.prewriting?.submittedAt || 0),
          draftSavedAt: Number(session.writing?.draft?.savedAt || 0),
          notesUpdatedAt: Number(session.writing?.notes?.updatedAt || 0),
          finalSubmittedAt: Number(session.writing?.final?.submittedAt || 0)
        },
        partner: session.partner || null
      }));
  }

  async function submitPrewriting(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '사전 글쓰기를 입력하세요.');
    return dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const submittedAt = Date.now();
      session.writing.prewriting = { text: cleaned, submittedAt };
      session.steps.prewriting = { completed: true, submittedAt };
      session.stage = Math.max(Number(session.stage || 1), 2);
      return session;
    });
  }

  async function saveDraft(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '2단계 메모를 입력하세요.');
    return dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const savedAt = Date.now();
      session.writing.draft = { text: cleaned, savedAt };
      session.steps.draft = { saved: true, savedAt };
      return session;
    });
  }

  async function savePeerNotes(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '3단계 메모를 입력하세요.');
    return dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const updatedAt = Date.now();
      session.writing.notes = { text: cleaned, updatedAt };
      session.steps.notes = { saved: true, updatedAt };
      return session;
    });
  }

  async function submitFinalWriting(sessionKey, text) {
    const cleaned = String(text || '').trim();
    if (!cleaned) throw createError(400, '최종 글을 입력하세요.');
    return dataStore.updateSession(sessionKey, (session) => {
      ensureWriting(session);
      ensureSteps(session);
      const submittedAt = Date.now();
      session.writing.final = { text: cleaned, submittedAt };
      session.steps.final = { submitted: true, submittedAt };
      session.stage = 4;
      return session;
    });
  }

  async function setPartner(sessionKey, payload = {}) {
    const { partnerSessionKey, partnerName, partnerId } = payload;
    const session = await dataStore.getSession(sessionKey);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }

    const normalizedPartnerKey = normalizeId(partnerSessionKey);
    const normalizedPartnerId = normalizeId(partnerId);
    let partnerSession = null;

    if (normalizedPartnerKey) {
      partnerSession = await dataStore.getSession(normalizedPartnerKey);
      if (!partnerSession) {
        throw createError(404, '동료 세션을 찾을 수 없습니다.');
      }
    }

    const manualAllowed = await ensurePartnerAllowed(partnerSessionKey, partnerId, partnerName);

    if (!partnerSession && normalizedPartnerId) {
      partnerSession = await findExistingSessionByStudentId(normalizedPartnerId);
    }

    if (partnerSession && partnerSession.sessionKey === session.sessionKey) {
      throw createError(400, '본인 세션을 동료로 지정할 수 없습니다.');
    }

    if (!partnerSession) {
      if (!manualAllowed) {
        throw createError(404, '동료 세션을 찾을 수 없습니다.');
      }
      const offlinePartner = {
        sessionKey: '',
        name: manualAllowed.name,
        id: manualAllowed.id,
        stage: Number(manualAllowed.stage || 1)
      };
      const updated = await dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        rememberRosterPairing({ id: session.you?.id, name: session.you?.name }, manualAllowed);
        record.partner = offlinePartner;
        record.presence = record.presence || {};
        record.presence.partner = {
          ...(record.presence.partner || {}),
          sessionKey: '',
          name: manualAllowed.name,
          id: manualAllowed.id,
          stage: Number(manualAllowed.stage || 1),
          online: false,
          lastSeen: 0
        };
        return record;
      });
      return updated;
    }

    const fallbackInfo = manualAllowed || {
      id: normalizedPartnerId,
      name: normalizeName(partnerName)
    };

    rememberRosterPairing(session.you || { id: session.you?.id, name: session.you?.name }, fallbackInfo || partnerSession.you);
    const { sharedId, mergeSources } = await determineSharedPeerSessionId(session, partnerSession);
    const partnerSnapshot = buildPartnerSnapshot(partnerSession, fallbackInfo || {}, true);
    const partnerPresence = buildPartnerPresence(partnerSession, fallbackInfo || {});
    const selfSnapshot = buildPartnerSnapshot(session, { id: session.you?.id, name: session.you?.name }, true);
    const selfPresence = buildPartnerPresence(session, { id: session.you?.id, name: session.you?.name });

    const [updatedSession, updatedPartner] = await Promise.all([
      dataStore.updateSession(session.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        record.partner = partnerSnapshot;
        record.presence = record.presence || {};
        record.presence.partner = partnerPresence;
        record.peerSessionId = sharedId;
        return record;
      }),
      dataStore.updateSession(partnerSession.sessionKey, (record) => {
        ensureWriting(record);
        ensureSteps(record);
        record.partner = selfSnapshot;
        record.presence = record.presence || {};
        record.presence.partner = selfPresence;
        record.peerSessionId = sharedId;
        return record;
      })
    ]);

    if (mergeSources.length) {
      await mergePeerChatHistories(sharedId, mergeSources);
    }

    await Promise.all([updatePartnerMirrorPresence(updatedSession), updatePartnerMirrorPresence(updatedPartner)]);
    return updatedSession;
  }

  async function clearPartner(sessionKey) {
    return dataStore.updateSession(sessionKey, (session) => {
      session.partner = null;
      return session;
    });
  }

  async function advanceToPeerStage(sessionKey) {
    return dataStore.updateSession(sessionKey, (session) => {
      const nextStage = computeNextStageForAdvance(session);
      advanceStageValue(session, nextStage);
      return session;
    });
  }

  async function advanceToFinalStage(sessionKey) {
    return dataStore.updateSession(sessionKey, (session) => {
      advanceStageValue(session, 4);
      return session;
    });
  }

  async function regressStage(sessionKey) {
    return dataStore.updateSession(sessionKey, (session) => {
      const previous = getPreviousStage(session);
      session.stage = previous;
      return session;
    });
  }

  async function touchPresence(sessionKey) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const now = Date.now();
      session.presence = session.presence || {};
      session.presence.self = {
        ...(session.presence.self || {}),
        online: true,
        lastSeen: now,
        stage: session.stage
      };
      return session;
    });
    await updatePartnerMirrorPresence(updated);
    return updated;
  }

  async function postPresenceLeave(sessionKey, userId, userName) {
    const updated = await dataStore.updateSession(sessionKey, (session) => {
      const now = Date.now();
      session.presence = session.presence || {};
      session.presence.self = {
        ...(session.presence.self || {}),
        online: false,
        lastSeen: now,
        stage: session.stage,
        name: userName,
        id: userId
      };
      return session;
    });
    await updatePartnerMirrorPresence(updated);
    return updated;
  }

  async function getPublicSettings() {
    return dataStore.getPublicSettings();
  }

  async function getServerDiag() {
    return dataStore.getServerDiag();
  }

  async function deleteSession(sessionKey) {
    const key = String(sessionKey || '').trim();
    if (!key) {
      throw createError(400, '세션 키를 입력하세요.');
    }
    const session = await dataStore.getSession(key);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }
    await dataStore.deleteSession(key, session);
    return { sessionKey: key };
  }

  return {
    startSession,
    listSessions,
    getSessionState,
    submitPrewriting,
    saveDraft,
    savePeerNotes,
    submitFinalWriting,
    setPartner,
    clearPartner,
    advanceToPeerStage,
    advanceToFinalStage,
    regressStage,
    touchPresence,
    postPresenceLeave,
    getAllSessionsWithDetails: async () => {
      const list = await listSessions();
      const detailed = await Promise.all(
        list.map(async (record) => {
          try {
            const session = await getSessionState(record.sessionKey);
            return session;
          } catch (error) {
            return null;
          }
        })
      );
      return detailed.filter(Boolean);
    },
    getPublicSettings,
    getServerDiag,
    deleteSession,
    reloadRosterCache: () => {
      rosterCache = null;
      rosterPairingsCache = [];
      rosterFetchedAt = 0;
    }
  };
}

