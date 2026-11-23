// The bot's brain: Claude via the Anthropic API, with short per-server memory.
import Anthropic from '@anthropic-ai/sdk';
import { config, log } from './config.js';
import { fillTemplate } from './helpers.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey, timeout: 60_000, maxRetries: 2 });

// guildId -> { messages: [{ role, content }], lastUsed }
const memories = new Map();

// Voice needs speed: try thinking off + low effort. If a model rejects
// one of these options, stop sending it (the reply still works without it).
let sendThinkingOff = true;
let sendEffort = Boolean(config.anthropic.effort);
let sendWebSearch = config.anthropic.webSearch;

export function resetMemory(guildId) {
  memories.delete(guildId);
}

function memoryFor(guildId) {
  const maxAge = config.anthropic.memoryMinutes * 60_000;
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
 * Ask Claude. `speaker` is the Discord display name, `text` what they said.
 * Returns the reply text ('' if Claude had nothing to say).
 */
export async function askClaude({ guildId, speaker, text, vars = {} }) {
  const memory = memoryFor(guildId);
  const question = { role: 'user', content: `${speaker}: ${text}` };
  const system = fillTemplate(config.systemPrompt, {
    BOT_NAME: config.botName,
    TIMEZONE: config.timezone,
    NOW: now(),
    ...vars,
  });

  const reply = await createReply(system, [...memory.messages, question]);
  if (reply) {
    memory.messages.push(question, { role: 'assistant', content: reply });
    const max = Math.max(2, config.anthropic.memoryTurns * 2);
    if (memory.messages.length > max) memory.messages.splice(0, memory.messages.length - max);
  }
  memory.lastUsed = Date.now();
  return reply;
}

async function createReply(system, messages) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const params = {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      system,
      messages,
    };
    if (sendThinkingOff) params.thinking = { type: 'disabled' };
    // Thinking tokens count toward max_tokens, so leave room when it stays on.
    else params.max_tokens = Math.max(params.max_tokens, 2000);
    if (sendEffort) params.output_config = { effort: config.anthropic.effort };
    if (sendWebSearch) {
      params.tools = [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 2,
          user_location: {
            type: 'approximate',
            country: config.anthropic.searchCountry,
            timezone: config.timezone,
          },
        },
      ];
    }

    try {
      return await runTurn(params);
    } catch (err) {
      const message = String(err?.message ?? '');
      if (err?.status === 400 && params.thinking && /thinking/i.test(message)) {
        log.warn(`الموديل ${params.model} ما يقبل إيقاف التفكير — بكمل بدونه.`);
        sendThinkingOff = false;
        continue;
      }
      if (err?.status === 400 && params.output_config && /effort|output_config/i.test(message)) {
        log.warn(`الموديل ${params.model} ما يقبل إعداد effort — بكمل بدونه.`);
        sendEffort = false;
        continue;
      }
      if (err?.status === 400 && params.tools && /web.?search/i.test(message)) {
        log.warn('البحث في النت مو مفعّل لحسابك في Claude Console — بكمل بدونه.');
        sendWebSearch = false;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Claude request failed');
}

async function runTurn(params) {
  let messages = params.messages;
  let response;
  // Web search can pause a long turn; send it back to let Claude continue.
  for (let i = 0; i < 3; i++) {
    response = await client.messages.create({ ...params, messages });
    if (response.stop_reason !== 'pause_turn') break;
    messages = [...messages, { role: 'assistant', content: response.content }];
  }
  return spokenText(response.content);
}

/** The text Claude wrote after its last web search (or all text if it didn't search). */
function spokenText(content = []) {
  let start = 0;
  content.forEach((block, i) => {
    if (String(block.type).endsWith('tool_result')) start = i + 1;
  });
  const join = (blocks) =>
    blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  return join(content.slice(start)) || join(content);
}
