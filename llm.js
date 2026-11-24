// The bot's brain: Gemini (when GEMINI_API_KEY is set) or a Groq chat model, with short per-server memory.
// If Gemini can't answer (for example its free limit is used up), Groq answers instead for a while.
import { config, log } from './config.js';
import { fillTemplate } from './helpers.js';
import { GEMINI_API, PROVIDER_NAMES, apiError, apiRequest, isResting, rest, shortError } from './speech.js';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// guildId -> { messages: [{ role, content }], lastUsed }
const memories = new Map();

// Voice needs speed: ask thinking models to think briefly and return only the answer.
// If a model rejects these options, stop sending them.
let sendGroqReasoning = true;
const rejectedLevels = new Set(); // thinking levels this model refused

export function resetMemory(guildId) {
  memories.delete(guildId);
}

function memoryFor(guildId) {
  const maxAge = config.llm.memoryMinutes * 60_000;
  const memory = memories.get(guildId);
  if (memory && Date.now() - memory.lastUsed < maxAge) return memory;
  const fresh = { messages: [], lastUsed: Date.now() };
  memories.set(guildId, fresh);
  return fresh;
}

function now() {
  const options = { dateStyle: 'full', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('ar-AE', { ...options, timeZone: config.timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('ar-AE', options).format(new Date());
  }
}

/**
 * Ask the AI. `speaker` is the Discord display name, `text` what they said.
 * `onNotice(message)` is called if the backup brain has to step in.
 * Returns the reply text ('' if the AI had nothing to say).
 */
export async function askAI({ guildId, speaker, text, vars = {}, onNotice }) {
  const memory = memoryFor(guildId);
  const question = { role: 'user', content: `${speaker}: ${text}` };
  const system = fillTemplate(config.systemPrompt, {
    BOT_NAME: config.botName,
    TIMEZONE: config.timezone,
    NOW: now(),
    ...vars,
  });

  const reply = stripNamePrefix(await createReply(system, [...memory.messages, question], onNotice), [speaker, config.botName]);
  if (reply) {
    memory.messages.push(question, { role: 'assistant', content: reply });
    const max = Math.max(2, config.llm.memoryTurns * 2);
    if (memory.messages.length > max) memory.messages.splice(0, memory.messages.length - max);
  }
  memory.lastUsed = Date.now();
  return reply;
}

async function createReply(system, messages, onNotice) {
  const { provider, fallback } = config.llm;
  if (!fallback || !isResting(`llm:${provider}`)) {
    try {
      return await replyFrom(provider, system, messages);
    } catch (error) {
      if (!fallback) throw error;
      log.warn(`${PROVIDER_NAMES[provider]} ما رد — بيرد ${PROVIDER_NAMES[fallback]} بداله: ${shortError(error)}`);
      if (rest(`llm:${provider}`, error)) onNotice?.(brainNotice(provider, fallback, error));
    }
  }
  return replyFrom(fallback, system, messages);
}

function brainNotice(provider, fallback, error) {
  const from = PROVIDER_NAMES[provider];
  const to = PROVIDER_NAMES[fallback];
  if (error?.status === 429) return `⏳ خلص حد ${from} المجاني للردود — بيرد ${to} لين يتجدد.`;
  return `⚠️ ${from} ما رد (\`${shortError(error)}\`) — بيرد ${to} بداله.`;
}

function replyFrom(provider, system, messages) {
  return provider === 'gemini' ? geminiReply(system, messages) : groqReply(system, messages);
}

// ---------- Gemini ----------
function thinkingLevel(model, setting) {
  if (['minimal', 'low', 'medium', 'high'].includes(setting)) return rejectedLevels.has(setting) ? null : setting;
  if (['off', 'none'].includes(setting) || /^gemini-[12]\./.test(model)) return null;
  // Flash-Lite already thinks very little; Flash thinks "medium" unless told otherwise.
  // Voice wants the fastest answer, so "minimal" (retried without it if the model refuses).
  // Fastest first; if the model refuses a level, the next one is tried.
  if (/lite/.test(model)) return null;
  return ['minimal', 'low'].find((level) => !rejectedLevels.has(level)) ?? null;
}

async function geminiReply(system, messages) {
  const { apiKey, model, thinking, maxTokens } = config.llm.gemini;
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  for (let attempt = 0; attempt < 3; attempt++) {
    const level = thinkingLevel(model, thinking);
    const generationConfig = { maxOutputTokens: maxTokens };
    if (level) generationConfig.thinkingConfig = { thinkingLevel: level };
    const res = await apiRequest(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }),
    });
    if (res.ok) return geminiText(await res.json());
    const error = await apiError(res, 'AI (Gemini)');
    if (res.status === 400 && level && /think/i.test(error.body)) {
      log.warn(`الموديل ${model} ما يقبل thinkingLevel=${level} — بكمل بدونه.`);
      rejectedLevels.add(level);
      continue;
    }
    throw error;
  }
  throw new Error('AI (Gemini) request failed');
}

function geminiText(data) {
  const candidate = data?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (!text.trim()) {
    log.warn(`Gemini رجع رد فاضي (${data?.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'empty'}).`);
  }
  return cleanReply(text);
}

// ---------- Groq ----------
function reasoningOptions(model) {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false };
  if (model.startsWith('qwen/')) return { reasoning_effort: 'none' };
  return {};
}

async function groqReply(system, messages) {
  const { apiKey, model, maxTokens } = config.llm.groq;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_completion_tokens: maxTokens,
      ...(sendGroqReasoning ? reasoningOptions(model) : {}),
    };
    const res = await apiRequest(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return cleanReply(data?.choices?.[0]?.message?.content);
    }
    const error = await apiError(res, 'AI (Groq)');
    if (res.status === 400 && sendGroqReasoning && /reason/i.test(error.message)) {
      log.warn(`الموديل ${model} ما يقبل إعدادات التفكير — بكمل بدونها.`);
      sendGroqReasoning = false;
      continue;
    }
    throw error;
  }
  throw new Error('AI (Groq) request failed');
}

/** The model sometimes copies the "Name: text" format of the question into its answer; drop that. */
function stripNamePrefix(text, names) {
  let out = String(text ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const hit = names.find((n) => n && out.toLowerCase().startsWith(`${n.toLowerCase()}:`));
    if (!hit) break;
    out = out.slice(hit.length + 1).trim();
  }
  return out;
}

/** Drop any "thinking" the model may have written into its answer. */
function cleanReply(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}
