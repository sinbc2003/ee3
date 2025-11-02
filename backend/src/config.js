import process from 'node:process';

const DEFAULT_ALLOWED_ORIGINS = ['*'];

const providerEnv = (process.env.AI_PROVIDER || '').toLowerCase();
const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
const hasVertex = Boolean(process.env.VERTEX_MODEL);

let aiProvider = 'none';
if (providerEnv === 'openai' && hasOpenAI) {
  aiProvider = 'openai';
} else if (providerEnv === 'vertex' && hasVertex) {
  aiProvider = 'vertex';
} else if (hasOpenAI) {
  aiProvider = 'openai';
} else if (hasVertex) {
  aiProvider = 'vertex';
}

const aiEnabled = aiProvider !== 'none';

const config = {
  port: Number(process.env.PORT || 8080),
  projectId: process.env.GCP_PROJECT_ID || process.env.PROJECT_ID || 'writingresearch',
  dataBucket: process.env.DATA_BUCKET || null,
  localDataDir: process.env.LOCAL_DATA_DIR || '../local-data',
  apiKey: process.env.API_KEY || null,
  allowedOrigins: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS,
  ai: {
    provider: aiProvider,
    enabled: aiEnabled,
    model: process.env.VERTEX_MODEL || 'gemini-1.5-flash',
    location: process.env.VERTEX_LOCATION || 'us-central1',
    systemPrompt: process.env.AI_SYSTEM_PROMPT || `당신은 영어 글쓰기 튜터입니다. 학생이 작성한 영어 글을 기반으로 개선 아이디어를 제안하고, 질문에 친절하게 답하세요.`,
    temperature: process.env.AI_TEMPERATURE ? Number(process.env.AI_TEMPERATURE) : 0.6,
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      organization: process.env.OPENAI_ORG || ''
    }
  },
  dictionary: {
    provider: process.env.DICTIONARY_PROVIDER || 'dictionaryapi',
    libreTranslateUrl: process.env.LIBRE_TRANSLATE_URL || 'https://libretranslate.de/translate'
  },
  admin: {
    password: process.env.ADMIN_PASSWORD || '159753tt!',
    tokenTtl: Number(process.env.ADMIN_TOKEN_TTL || 86400) // 24시간 기본 유지
  }
};

export default config;

