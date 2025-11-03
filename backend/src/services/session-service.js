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
    rosterFetchedAt = now;
    return rosterCache;
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
    await dataStore.saveSession(sessionKey, base);
    return base;
  }

  async function getSessionState(sessionKey) {
    const session = await dataStore.getSession(sessionKey);
    if (!session) {
      throw createError(404, '세션을 찾을 수 없습니다.');
    }
    return session;
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
    return dataStore.updateSession(sessionKey, async (session) => {
      const info = {};
      if (partnerSessionKey) {
        const partnerSession = await dataStore.getSession(partnerSessionKey);
        if (!partnerSession) {
          throw createError(404, '동료 세션을 찾을 수 없습니다.');
        }
        info.sessionKey = partnerSession.sessionKey;
        info.name = partnerSession.you?.name || '';
        info.id = partnerSession.you?.id || '';
      }
      const manualAllowed = await ensurePartnerAllowed(partnerSessionKey, partnerId, partnerName);
      if (manualAllowed) {
        info.name = manualAllowed.name;
        info.id = manualAllowed.id;
      }
      if (!info.sessionKey && !info.name && !info.id) {
        throw createError(400, '동료 정보를 입력하세요.');
      }
      session.partner = info;
      return session;
    });
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
    return dataStore.updateSession(sessionKey, (session) => {
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
  }

  async function postPresenceLeave(sessionKey, userId, userName) {
    return dataStore.updateSession(sessionKey, (session) => {
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
    deleteSession
  };
}

