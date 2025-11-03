import ExcelJS from 'exceljs';

function formatDateTime(value) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  try {
    return new Date(ms).toLocaleString('ko-KR');
  } catch (error) {
    return '';
  }
}

function ensureHeaderBold(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
}

function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function addSummarySheet(workbook, sessions) {
  const sheet = workbook.addWorksheet('세션 전체 요약');
  sheet.columns = [
    { header: '세션 키', key: 'sessionKey', width: 28 },
    { header: '집단', key: 'group', width: 8 },
    { header: '현재 단계', key: 'stage', width: 12 },
    { header: '학생 이름', key: 'studentName', width: 16 },
    { header: '학생 식별 번호', key: 'studentId', width: 18 },
    { header: '동료 이름', key: 'partnerName', width: 18 },
    { header: '동료 식별 번호', key: 'partnerId', width: 18 },
    { header: '동료 세션 키', key: 'partnerSessionKey', width: 28 },
    { header: '생성 시간', key: 'createdAt', width: 20 },
    { header: '최근 업데이트', key: 'updatedAt', width: 20 },
    { header: '1단계 제출 시간', key: 'prewritingAt', width: 20 },
    { header: '1단계 사전 글쓰기', key: 'prewritingText', width: 60 },
    { header: '2단계 저장 시간', key: 'draftAt', width: 20 },
    { header: '2단계 수정 메모', key: 'draftText', width: 60 },
    { header: '3단계 저장 시간', key: 'notesAt', width: 20 },
    { header: '3단계 동료 메모', key: 'notesText', width: 60 },
    { header: '최종 글 제출 시간', key: 'finalAt', width: 20 },
    { header: '최종 글', key: 'finalText', width: 60 }
  ];

  sessions.forEach((session) => {
    const writing = session?.writing || {};
    const partner = session?.partner || {};
    sheet.addRow({
      sessionKey: safeText(session?.sessionKey),
      group: safeText(session?.mode),
      stage: safeText(session?.stage),
      studentName: safeText(session?.you?.name),
      studentId: safeText(session?.you?.id),
      partnerName: safeText(partner?.name),
      partnerId: safeText(partner?.id),
      partnerSessionKey: safeText(partner?.sessionKey),
      createdAt: formatDateTime(session?.createdAt),
      updatedAt: formatDateTime(session?.updatedAt),
      prewritingAt: formatDateTime(writing?.prewriting?.submittedAt),
      prewritingText: safeText(writing?.prewriting?.text),
      draftAt: formatDateTime(writing?.draft?.savedAt),
      draftText: safeText(writing?.draft?.text),
      notesAt: formatDateTime(writing?.notes?.updatedAt),
      notesText: safeText(writing?.notes?.text),
      finalAt: formatDateTime(writing?.final?.submittedAt),
      finalText: safeText(writing?.final?.text)
    });
  });

  if (sheet.rowCount === 1) {
    sheet.addRow({ sessionKey: '데이터가 없습니다.' });
  }
  ensureHeaderBold(sheet);
}

function addStageSheet(workbook, sessions, { scope, key, sheetName, timeKey, timeLabel }) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = [
    { header: '세션 키', key: 'sessionKey', width: 28 },
    { header: '집단', key: 'group', width: 8 },
    { header: '학생 이름', key: 'studentName', width: 18 },
    { header: '학생 식별 번호', key: 'studentId', width: 18 },
    { header: timeLabel, key: 'timestamp', width: 22 },
    { header: '내용', key: 'content', width: 80 }
  ];

  sessions.forEach((session) => {
    const writing = session?.writing?.[key] || {};
    const content = safeText(writing?.text).trim();
    const timestamp = formatDateTime(writing?.[timeKey]);
    if (!content && !timestamp) return;
    sheet.addRow({
      sessionKey: safeText(session?.sessionKey),
      group: safeText(session?.mode),
      studentName: safeText(session?.you?.name),
      studentId: safeText(session?.you?.id),
      timestamp,
      content: content || '내용이 비어 있습니다.'
    });
  });

  if (sheet.rowCount === 1) {
    sheet.addRow({ sessionKey: '데이터가 없습니다.' });
  }
  ensureHeaderBold(sheet);

  return scope;
}

async function addAiChatSheet(workbook, sessions, chatService) {
  const sheet = workbook.addWorksheet('AI 대화 로그');
  sheet.columns = [
    { header: '세션 키', key: 'sessionKey', width: 28 },
    { header: '학생 이름', key: 'studentName', width: 18 },
    { header: '학생 식별 번호', key: 'studentId', width: 18 },
    { header: '타임스탬프', key: 'timestamp', width: 22 },
    { header: '발신자', key: 'sender', width: 18 },
    { header: '역할', key: 'role', width: 12 },
    { header: '메시지', key: 'message', width: 90 }
  ];

  for (const session of sessions) {
    if (!session?.aiSessionId) continue;
    if (!chatService?.getChatHistory) continue;
    // eslint-disable-next-line no-await-in-loop
    const history = await chatService.getChatHistory(session.aiSessionId, 'ai');
    if (!history || !history.length) continue;
    history.forEach((message) => {
      sheet.addRow({
        sessionKey: safeText(session?.sessionKey),
        studentName: safeText(session?.you?.name),
        studentId: safeText(session?.you?.id),
        timestamp: formatDateTime(message?.ts),
        sender: safeText(message?.senderName || message?.role),
        role: safeText(message?.role),
        message: safeText(message?.text)
      });
    });
  }

  if (sheet.rowCount === 1) {
    sheet.addRow({ sessionKey: '데이터가 없습니다.' });
  }
  ensureHeaderBold(sheet);
}

const STAGE_CONFIGS = [
  { scope: 'stage1', key: 'prewriting', sheetName: '1단계 사전 글쓰기', timeKey: 'submittedAt', timeLabel: '제출 시간' },
  { scope: 'stage2', key: 'draft', sheetName: '2단계 수정 아이디어 메모', timeKey: 'savedAt', timeLabel: '저장 시간' },
  { scope: 'stage3', key: 'notes', sheetName: '3단계 동료 피드백 메모', timeKey: 'updatedAt', timeLabel: '저장 시간' },
  { scope: 'final', key: 'final', sheetName: '최종 글', timeKey: 'submittedAt', timeLabel: '제출 시간' }
];

export async function buildSessionExportWorkbook({ sessions = [], scopes = [], chatService }) {
  const workbook = new ExcelJS.Workbook();
  const now = new Date();
  workbook.created = now;
  workbook.modified = now;
  const scopeList = Array.isArray(scopes) && scopes.length ? scopes : ['all'];
  const scopeSet = new Set(scopeList.map((item) => String(item || '').toLowerCase()).filter(Boolean));

  if (scopeSet.has('all')) {
    addSummarySheet(workbook, sessions);
  }

  STAGE_CONFIGS.forEach((config) => {
    if (scopeSet.has(config.scope) || scopeSet.has('all')) {
      addStageSheet(workbook, sessions, config);
    }
  });

  if (scopeSet.has('ai-chat') || scopeSet.has('all')) {
    await addAiChatSheet(workbook, sessions, chatService);
  }

  if (workbook.worksheets.length === 0) {
    const sheet = workbook.addWorksheet('내보낼 데이터가 없습니다');
    sheet.addRow(['선택한 범위에 해당하는 데이터가 없습니다.']);
  }

  return workbook;
}


