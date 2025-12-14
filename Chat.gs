  /**
  * 채팅/세션/데이터/AI 호출
  */

  // ===== 세션 =====
  function startSession(mode, studentId, studentName) {
    var group = String(mode || '').toUpperCase();
    if (!group) throw new Error('집단을 선택하세요.');
    var you = {
      id: String(studentId || '').trim(),
      name: String(studentName || '').trim(),
      group: group
    };
    if (!you.id || !you.name) throw new Error('식별 번호와 이름을 모두 입력하세요.');
    var record = ensureWritingSession_(group, you.id, you.name);
    if (!record) throw new Error('세션 초기화에 실패했습니다.');
    var state = buildSessionStateResponse_(record);
    if (!state) throw new Error('세션 상태를 불러오지 못했습니다.');
    try { touchPresence(state.sessionKey); } catch (e) {}
    return {
      sessionKey: state.sessionKey,
      roomId: state.roomId,
      mode: group,
      you: you,
      stage: state.stage,
      updatedAt: Number(record.updatedAt || state.updatedAt || 0),
      aiSessionId: state.aiSessionId,
      peerSessionId: state.peerSessionId,
      writing: {
        prewriting: state.prewriting,
        draft: state.draft,
        notes: state.notes,
        final: state.final
      },
      steps: state.steps,
      partner: state.partner,
      presence: state.presence
    };
  }

  // generateRoomId_는 Code.gs의 공용 유틸을 사용합니다.

  // ===== 메시지 기록/조회 =====
  function postMessage(sessionId, mode, senderId, senderName, role, text, options) {
    var sh = getMessagesSheet_();
    var now = Date.now();
    var opt = options || {};
    var roomId = opt.roomId || sessionId;
    var ext = opt.ext || {};
    if (opt.channel) ext.channel = opt.channel;
    if (opt.sessionKey) ext.sessionKey = opt.sessionKey;
    if (opt.stage) ext.stage = opt.stage;
    if (opt.meta && typeof opt.meta === 'object') {
      for (var k in opt.meta) {
        if (opt.meta.hasOwnProperty(k)) ext[k] = opt.meta[k];
      }
    }
    var extStr = '';
    if (ext && Object.keys(ext).length) {
      try {
        extStr = JSON.stringify(ext);
      } catch (e) {
        extStr = String(ext);
      }
    }
    var row = [now, sessionId, roomId, String(mode).toUpperCase(), senderId || '', senderName || '', role || 'user', text || '', extStr];
    sh.appendRow(row);
    try { Logger.log(JSON.stringify({ tag: 'postMessage', ts: now, sessionId: sessionId, mode: String(mode).toUpperCase(), senderId: String(senderId || ''), senderName: String(senderName || ''), role: String(role || 'user'), textLen: String((text || '').length) })); } catch (e) {}
    try {
      if (opt.sessionKey) {
        appendChatToWorkbook_(opt.sessionKey, opt.channel || '', {
          ts: now,
          senderName: senderName,
          role: role,
          text: text
        });
      }
    } catch (e) {
      try { Logger.log('appendChatToWorkbook_ failed: ' + e.message); } catch (ignored) {}
    }
    return { ok: true, ts: now };
  }

  function getMessages(sessionId, sinceTs, channel) {
    var sh = getMessagesSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    var rowsToRead = Math.min(1000, lastRow - 1); // 최근 1000행만
    var startRow = Math.max(2, lastRow - rowsToRead + 1);
    var rng = sh.getRange(startRow, 1, rowsToRead, 9);
    var values = rng.getValues();
    var list = [];
    var since = Number(sinceTs || 0);
    var isPeerChannel = String(channel) === 'peer-chat' || String(channel) === 'peer';
    
    for (var i=0; i<values.length; i++) {
      var r = values[i];
      // 동료 채팅의 경우 roomId(peerSessionId)로 검색, 다른 채널은 sessionId로 검색
      if (isPeerChannel) {
        if (String(r[2]) !== String(sessionId)) continue; // roomId 컬럼
      } else {
        if (String(r[1]) !== String(sessionId)) continue; // sessionId 컬럼
      }
      var ts = Number(r[0]);
      if (ts <= since) continue;
      var meta = {};
      if (r[8]) {
        try { meta = JSON.parse(r[8]); }
        catch (e) { meta = { raw: String(r[8]) }; }
      }
      // 채널 필터: 메타에 channel이 있을 때만 엄격히 비교, 없으면 허용(레거시 호환)
      if (channel) {
        var metaChannel = String((meta && meta.channel) || '');
        if (metaChannel && metaChannel !== String(channel)) continue;
      }
      list.push({ ts: ts, sessionId: r[1], roomId: r[2], mode: r[3], senderId: r[4], senderName: r[5], role: r[6], text: r[7], ext: meta });
    }
    return list.sort(function(a,b){ return a.ts - b.ts; });
  }

  // ===== AI 응답 =====
  function requestAiIfNeeded(sessionId, mode, latestUserText, stance, options) {
    var m = String(mode).toUpperCase();
    // PVP 레거시 모드에서만 AI를 사용하지 않습니다.
    if (m === 'PVP') return { skipped: true };
    var settings = getSettings_();
    var useModel = (m === 'B' || m === 'CUSTOM') ? (settings.customModel || settings.defaultModel || 'gpt-4o-mini') : (settings.defaultModel || 'gpt-4o-mini');
    var systemPrompt = settings.aiTutorSystemPrompt || settings.customSystemPrompt || '';
    var sessionKey = options && options.sessionKey;
    if (sessionKey) {
      try {
        var sessionState = getSessionState(sessionKey);
        var prewritingText = sessionState && sessionState.prewriting && sessionState.prewriting.text ? String(sessionState.prewriting.text).trim() : '';
        if (prewritingText) {
          var prewritingBlock = '<1단계 글쓰기>\n' + prewritingText + '\n</1단계 글쓰기>';
          systemPrompt = systemPrompt ? (systemPrompt + '\n\n' + prewritingBlock) : prewritingBlock;
        }
      } catch (e) {
        try { Logger.log('requestAiIfNeeded prewriting load failed: ' + e.message); } catch (ignored) {}
      }
    }
    var messages = getRecentByUserTurns_(sessionId, 30);
    if (latestUserText && String(latestUserText).trim()) {
      var last = messages.length ? messages[messages.length - 1] : null;
      if (!(last && last.role === 'user' && String(last.content || '') === String(latestUserText))) {
        messages.push({ role: 'user', content: String(latestUserText) });
      }
    }
    var apiKey = readUserSetting_(USERPROP_OPENAI_KEY) || settings.aiApiKey;
    var aiText = llmGenerateOpenAI_(apiKey, useModel, systemPrompt, messages);
    var res = postMessage(sessionId, mode, 'AI', 'AI', 'ai', aiText, {
      roomId: (options && options.roomId) || sessionId,
      channel: (options && options.channel) || 'ai-feedback',
      sessionKey: options && options.sessionKey
    });
    return { ok: true, text: aiText, ts: (res && res.ts) ? res.ts : Date.now() };
  }

  function getRecentByUserTurns_(sessionId, maxUserTurns) {
    var sh = getMessagesSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow <= 1) return [];
    var rowsToRead = Math.min(1000, lastRow - 1);
    var startRow = Math.max(2, lastRow - rowsToRead + 1);
    var values = sh.getRange(startRow, 1, rowsToRead, 9).getValues();
    var convo = [];
    var userTurns = 0;
    for (var i = values.length - 1; i >= 0; i--) {
      var r = values[i];
      if (String(r[1]) !== String(sessionId)) continue;
      var role = String(r[6]||'');
      convo.push({ role: role === 'ai' ? 'assistant' : (role === 'system' ? 'system' : 'user'), content: String(r[7]||'') });
      if (role === 'user') {
        userTurns += 1;
        if (userTurns >= (maxUserTurns || 30)) break;
      }
    }
    convo.reverse();
    return convo;
  }

  // ===== 세션 초기화/프레즌스 =====
  function clearSession(sessionId) {
    var sh = getMessagesSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow <= 1) return { ok: true, deleted: 0 };
    var values = sh.getRange(2, 1, lastRow - 1, 9).getValues();
    var keep = [];
    var deleted = 0;
    for (var i=0; i<values.length; i++) {
      var r = values[i];
      if (String(r[1]) === String(sessionId)) { deleted++; continue; }
      keep.push(r);
    }
    sh.clear();
    sh.appendRow(['timestampMs','sessionId','roomId','mode','senderId','senderName','role','text','ext']);
    if (keep.length) sh.getRange(2, 1, keep.length, 9).setValues(keep);
    return { ok: true, deleted: deleted };
  }

  function postPresenceLeave(sessionId, userId, userName, options) {
    try {
      postMessage(sessionId, 'SYSTEM', userId||'', userName||'', 'system', 'presence:leave', options || {});
    } catch (e) {}
    return { ok: true };
  }

  // ===== 매칭 헬퍼 =====
  function getMatchupForStudent_(studentId, studentName) {
    // 우선순위: UserProperties.TEACHER_SHEET_ID -> settings.teacherSheetId -> 내부 데이터 스프레드시트 Matchups 시트
    var tId = readUserSetting_(USERPROP_TEACHER_SHEET_ID) || getSettings_().teacherSheetId;
    var rows = [];
    if (tId) {
      try {
        var sh = SpreadsheetApp.openById(tId).getSheetByName('Matchups');
        if (sh) rows = sh.getDataRange().getValues();
      } catch (e) {}
    }
    if (!rows.length) {
      try {
        var sh2 = getOrCreateDataSpreadsheet_().getSheetByName('Matchups');
        if (sh2) rows = sh2.getDataRange().getValues();
      } catch (e) {}
    }
    if (!rows.length) return null;
    var sid = String(studentId||'').trim();
    var sname = String(studentName||'').trim();
    for (var i=1; i<rows.length; i++) {
      var r = rows[i];
      var roomId = String(r[0]||'').trim();
      var aId = String(r[1]||'').trim(); var aName = String(r[2]||'').trim();
      var bId = String(r[3]||'').trim(); var bName = String(r[4]||'').trim();
      var match = (aId && aId === sid) || (bId && bId === sid) || (aName && aName === sname) || (bName && bName === sname);
      if (match) {
        var finalRoom = roomId;
        if (!finalRoom) {
          // roomId가 비어있으면 두 학생 키로부터 결정적 roomId 생성(시트 수정 없이 동일 값 보장)
          finalRoom = makePairRoomId_((aId||aName), (bId||bName));
        }
        return { roomId: finalRoom, studentIdA: aId, nameA: aName, studentIdB: bId, nameB: bName };
      }
    }
    return null;
  }

  function makePairRoomId_(keyA, keyB) {
    var a = String(keyA||'').trim();
    var b = String(keyB||'').trim();
    var left = a < b ? a : b;
    var right = a < b ? b : a;
    var text = left + '|' + right;
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
    var hex = '';
    for (var i=0; i<bytes.length; i++) {
      var h = (bytes[i] & 0xff).toString(16);
      if (h.length === 1) h = '0' + h;
      hex += h;
    }
    return 'r_' + hex.substring(0, 12);
  }

  // ===== OpenAI 호출 =====
  function llmGenerateOpenAI_(apiKey, model, systemPrompt, messages) {
    if (!apiKey) throw new Error('OpenAI API 키가 설정되지 않았습니다.');
    var payload = {
      model: model || 'gpt-4o-mini',
      messages: [],
      temperature: 0.7,
      stream: false
    };
    if (systemPrompt) payload.messages.push({ role: 'system', content: systemPrompt });
    (messages || []).forEach(function(m){ payload.messages.push({ role: m.role, content: m.content }); });
    if (!payload.messages.length) payload.messages.push({ role: 'user', content: '안녕' });
    var url = 'https://api.openai.com/v1/chat/completions';
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      payload: JSON.stringify(payload)
    });
    var code = res.getResponseCode();
    var body = res.getContentText();
    try { Logger.log(JSON.stringify({ tag: 'openai_res', code: code, bodyLen: (body||'').length })); } catch (e) {}
    if (code < 200 || code >= 300) {
      throw new Error('OpenAI 호출 실패: HTTP ' + code + ' ' + body);
    }
    var obj = {};
    try { obj = JSON.parse(body); } catch (e) { throw new Error('OpenAI 응답 파싱 실패: ' + e.message); }
    var text = '';
    try { text = String(obj.choices[0].message.content || ''); } catch (e) {}
    if (!text) text = '[빈 응답]';
    return text;
  }


