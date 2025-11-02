import { VertexAI } from '@google-cloud/vertexai';
import OpenAI from 'openai';

function buildVertexContents(history, userMessage) {
  const recent = Array.isArray(history) ? history.slice(-12) : [];
  const mapped = recent
    .map((entry) => {
      if (!entry || !entry.text) return null;
      const role = entry.role === 'ai' ? 'model' : entry.role === 'system' ? 'user' : 'user';
      return {
        role,
        parts: [{ text: String(entry.text) }]
      };
    })
    .filter(Boolean);
  mapped.push({ role: 'user', parts: [{ text: String(userMessage) }] });
  return mapped;
}

function buildFallbackResponse(userMessage) {
  const suggestions = `다음 제안을 참고해 보세요:\n1. 핵심 주장 명확히 하기\n2. 근거를 구체적인 예시로 보강하기\n3. 문장 간 연결어를 점검하기`;
  return `${userMessage ? '질문해 주신 내용 잘 읽었습니다.' : '안녕하세요!'}\n\n${suggestions}`;
}

function sanitizeOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== 'object') return {};
  const ai = overrides.ai ? overrides.ai : overrides;
  const cleaned = { ...ai };
  if (cleaned.temperature !== undefined && cleaned.temperature !== null) {
    const temp = Number(cleaned.temperature);
    cleaned.temperature = Number.isFinite(temp) ? temp : undefined;
  }
  if (cleaned.openai) {
    cleaned.openai = { ...cleaned.openai };
  }
  return { ai: cleaned };
}

function mergeAiConfig(baseAi, overrideAi) {
  const mergedOpenAi = {
    ...(baseAi.openai || {}),
    ...((overrideAi && overrideAi.openai) || {})
  };
  const merged = {
    ...baseAi,
    ...(overrideAi || {}),
    openai: mergedOpenAi
  };

  const requestedProvider = (overrideAi && (overrideAi.provider || overrideAi.aiProvider)) || merged.provider || '';
  const hasOpenAiKey = Boolean(mergedOpenAi.apiKey);
  const hasVertexModel = Boolean(merged.model);

  let provider = requestedProvider.trim ? requestedProvider.trim().toLowerCase() : requestedProvider;
  if (!provider || provider === 'auto') provider = '';
  if (!provider || provider === 'none') {
    if (hasOpenAiKey) provider = 'openai';
    else if (hasVertexModel) provider = 'vertex';
    else provider = 'none';
  }

  merged.provider = provider;
  merged.enabled = provider !== 'none' && ((provider === 'openai' && hasOpenAiKey) || (provider === 'vertex' && hasVertexModel));
  merged.openai = mergedOpenAi;
  return merged;
}

function buildOpenAiMessages(history, userMessage, systemPrompt) {
  const messages = [];
  if (systemPrompt && systemPrompt.trim()) {
    messages.push({ role: 'system', content: systemPrompt.trim() });
  }
  if (Array.isArray(history)) {
    history.slice(-12).forEach((entry) => {
      if (!entry || !entry.text) return;
      const role = entry.role === 'ai' ? 'assistant' : entry.role === 'system' ? 'system' : 'user';
      messages.push({ role, content: String(entry.text) });
    });
  }
  messages.push({ role: 'user', content: String(userMessage) });
  return messages;
}

export function createAiResponder(baseConfig) {
  const baseAi = (baseConfig && baseConfig.ai) || {};
  const state = {
    overrides: sanitizeOverrides({})
  };

  function setOverrides(overrides = {}) {
    state.overrides = sanitizeOverrides(overrides);
  }

  function getOverrides() {
    return { ...state.overrides };
  }

  function getEffectiveConfig() {
    const merged = mergeAiConfig(baseAi, state.overrides.ai);
    return { ai: merged };
  }

  async function generateReply({ userMessage, history }) {
    if (!userMessage || !userMessage.trim()) {
      return '';
    }
    const { ai } = getEffectiveConfig();
    if (!ai.enabled) {
      return buildFallbackResponse(userMessage);
    }

    const temperature = ai.temperature ?? 0.6;

    if (ai.provider === 'openai' && ai.openai?.apiKey) {
      try {
        const clientOptions = { apiKey: ai.openai.apiKey };
        if (ai.openai.baseUrl) clientOptions.baseURL = ai.openai.baseUrl;
        if (ai.openai.organization) clientOptions.organization = ai.openai.organization;
        const openai = new OpenAI(clientOptions);
        const messages = buildOpenAiMessages(history, userMessage, ai.systemPrompt);
        const response = await openai.chat.completions.create({
          model: ai.openai.model || 'gpt-4o-mini',
          messages,
          temperature,
          max_tokens: 800
        });
        const content = response?.choices?.[0]?.message?.content;
        return content ? content.trim() : buildFallbackResponse(userMessage);
      } catch (error) {
        console.error('OpenAI 응답 생성 오류', error);
        return buildFallbackResponse(userMessage);
      }
    }

    if (ai.provider === 'vertex' && ai.model) {
      try {
        const vertexAI = new VertexAI({
          project: baseConfig.projectId,
          location: ai.location || baseAi.location || 'us-central1'
        });
        const generativeModel = vertexAI.preview.getGenerativeModel({
          model: ai.model,
          systemInstruction: {
            parts: [{ text: ai.systemPrompt || baseAi.systemPrompt || '' }]
          }
        });
        const contents = buildVertexContents(history, userMessage);
        const result = await generativeModel.generateContent({
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens: 1024
          }
        });
        const text = result?.response?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || '')
          .join('')
          .trim();
        return text || buildFallbackResponse(userMessage);
      } catch (error) {
        console.error('AI 응답 생성 오류', error);
        return buildFallbackResponse(userMessage);
      }
    }

    return buildFallbackResponse(userMessage);
  }

  return {
    isEnabled: () => getEffectiveConfig().ai.enabled,
    getEffectiveConfig,
    getOverrides,
    setOverrides,
    async generateReply(payload) {
      return generateReply(payload);
    }
  };
}

