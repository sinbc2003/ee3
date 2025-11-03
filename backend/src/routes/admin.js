import express from 'express';
import createError from 'http-errors';

import { buildSessionExportWorkbook } from '../utils/export-workbook.js';

export function createAdminRouter({ adminService, sessionService, chatService }) {
  if (!adminService || !sessionService || !chatService) {
    throw new Error('adminService, sessionService, chatService가 필요합니다.');
  }

  const router = express.Router();

  function parseScopesParam(input) {
    if (!input) return [];
    const source = Array.isArray(input) ? input : String(input).split(',');
    return source
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  async function buildJsonExportPayload(sessions) {
    const payload = await Promise.all(
      sessions.map(async (session) => {
        const aiHistory = session.aiSessionId ? await chatService.getChatHistory(session.aiSessionId, 'ai') : [];
        const peerHistory = session.peerSessionId ? await chatService.getChatHistory(session.peerSessionId, 'peer') : [];
        return {
          ...session,
          aiChat: aiHistory,
          peerChat: peerHistory
        };
      })
    );
    return {
      exportedAt: Date.now(),
      total: payload.length,
      sessions: payload
    };
  }

  async function handleSessionsExport(req, res, next, formatOverride) {
    try {
      const format = String(formatOverride || req.query?.format || 'json').toLowerCase();
      const scopes = parseScopesParam(req.query?.scopes);
      const sessions = await sessionService.getAllSessionsWithDetails();

      if (format === 'json') {
        const result = await buildJsonExportPayload(sessions);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="writingresearch-export.json"');
        res.send(JSON.stringify(result, null, 2));
        return;
      }

      if (format === 'xlsx' || format === 'xls') {
        const workbook = await buildSessionExportWorkbook({ sessions, scopes, chatService });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="writingresearch-export-${stamp}.xlsx"`);
        await workbook.xlsx.write(res);
        res.end();
        return;
      }

      throw createError(400, '지원하지 않는 내보내기 형식입니다. (json, xlsx 중 선택)');
    } catch (error) {
      next(error);
    }
  }

  router.post('/login', async (req, res, next) => {
    try {
      const password = req.body?.password || '';
      if (!adminService.verifyPassword(password)) {
        throw createError(401, '인증에 실패했습니다.');
      }
      const { token, expiresAt } = adminService.issueToken();
      res.json({ token, expiresAt });
    } catch (error) {
      next(error);
    }
  });

  router.use((req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!adminService.validateToken(token)) {
      res.status(401).json({ error: '인증이 필요합니다.' });
      return;
    }
    req.adminToken = token;
    next();
  });

  router.post('/logout', (req, res) => {
    if (req.adminToken) {
      adminService.revokeToken(req.adminToken);
    }
    res.json({ ok: true });
  });

  router.get('/sessions', async (req, res, next) => {
    try {
      const sessions = await sessionService.listSessions();
      res.json({ sessions });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionKey', async (req, res, next) => {
    try {
      const session = await sessionService.getSessionState(req.params.sessionKey);
      res.json({ session });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sessions/:sessionKey/partner', async (req, res, next) => {
    try {
      const updated = await sessionService.setPartner(req.params.sessionKey, req.body || {});
      res.json({ session: updated });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sessions/:sessionKey/partner', async (req, res, next) => {
    try {
      const updated = await sessionService.clearPartner(req.params.sessionKey);
      res.json({ session: updated });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/:sessionKey/chats/:channel', async (req, res, next) => {
    try {
      const { sessionKey, channel } = req.params;
      const normalizedChannel = channel === 'peer' || channel === 'peer-chat' ? 'peer' : 'ai';
      const session = await sessionService.getSessionState(sessionKey);
      const chatId = normalizedChannel === 'peer' ? session.peerSessionId : session.aiSessionId;
      if (!chatId) {
        res.json({ messages: [] });
        return;
      }
      const history = await chatService.getChatHistory(chatId, normalizedChannel);
      res.json({ messages: history });
    } catch (error) {
      next(error);
    }
  });

  router.get('/sessions/export', (req, res, next) => handleSessionsExport(req, res, next));
  router.get('/sessions/export/json', (req, res, next) => handleSessionsExport(req, res, next, 'json'));

  router.get('/roster', async (req, res, next) => {
    try {
      const roster = await adminService.getRoster();
      res.json(roster);
    } catch (error) {
      next(error);
    }
  });

  router.post('/roster', async (req, res, next) => {
    function parseText(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.replace(/\t/g, ',').trim())
        .filter(Boolean)
        .map((line) => line.split(',').map((part) => part.trim()))
        .map(([id, name]) => ({ id, name }));
    }

    try {
      const body = req.body || {};
      let students = [];
      if (Array.isArray(body.students)) {
        students = body.students;
      } else if (typeof body.text === 'string') {
        students = parseText(body.text);
      } else if (typeof body === 'string') {
        students = parseText(body);
      }
      const roster = await adminService.replaceRoster({ students });
      res.json(roster);
    } catch (error) {
      next(error);
    }
  });

  router.get('/config', async (req, res, next) => {
    try {
      const config = await adminService.getConfig();
      res.json(config);
    } catch (error) {
      next(error);
    }
  });

  router.get('/public-settings', async (req, res, next) => {
    try {
      const settings = await adminService.getPublicSettings();
      res.json(settings);
    } catch (error) {
      next(error);
    }
  });

  router.post('/config', async (req, res, next) => {
    try {
      const result = await adminService.updateConfig(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/public-settings', async (req, res, next) => {
    try {
      const result = await adminService.updatePublicSettings(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

