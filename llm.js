// The bot's brain: a Groq chat model (works on Groq's free plan), with short per-server memory.
import { config, log } from './config.js';
import { fillTemplate } from './helpers.js';
import { apiError, apiRequest } from './speech.js';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// guildId -> { messages: [{ role, content }], lastUsed }
const memories = new Map();

// Voice needs speed: ask reasoning models to think briefly and return only the answer.
// If a model rejects these options, stop sending them.
let sendReasoningOptions = true;

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

function reasoningOptions(model) {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', include_reasoning: false };
  if (model.startsWith('qwen/')) return { reasoning_effort: 'none' };
  return {};
}

/**
 * Ask the AI. `speaker` is the Discord display name, `text` what they said.
 * Returns the reply text ('' if the AI had nothing to say).
 */
export async function askAI({ guildId, speaker, text, vars = {} }) {
  const memory = memoryFor(guildId);
  const question = { role: 'user', content: `${speaker}: ${text}` };
  const system = fillTemplate(config.systemPrompt, {
    BOT_NAME: config.botName,
    TIMEZONE: config.timezone,
    NOW: now(),
    ...vars,
  });

  const reply = await createReply([{ role: 'system', content: system }, ...memory.messages, question]);
  if (reply) {
    memory.messages.push(question, { role: 'assistant', content: reply });
    const max = Math.max(2, config.llm.memoryTurns * 2);
    if (memory.messages.length > max) memory.messages.splice(0, memory.messages.length - max);
  }
  memory.lastUsed = Date.now();
  return reply;
}

async function createReply(messages) {
  const { apiKey, model, maxTokens } = config.llm;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      model,
      messages,
      max_completion_tokens: maxTokens,
      ...(sendReasoningOptions ? reasoningOptions(model) : {}),
    };
    const res = await apiRequest(CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      return cleanReply(data?.choices?.[0]?.message?.content);
    }
    const error = await apiError(res, 'AI');
    if (res.status === 400 && sendReasoningOptions && /reason/i.test(error.message)) {
      log.warn(`الموديل ${model} ما يقبل إعدادات التفكير — بكمل بدونها.`);
      sendReasoningOptions = false;
      continue;
    }
    throw error;
  }
  throw new Error('AI request failed');
}

/** Drop any "thinking" the model may have written into its answer. */
function cleanReply(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
}
