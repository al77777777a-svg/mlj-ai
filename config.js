// Reads every setting from the .env file (or the host's environment variables).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Node's built-in .env loader. Real environment variables (Railway, Docker…) win.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file: use the environment as it is.
}

const env = (name, fallback = '') => (process.env[name] ?? '').trim() || fallback;
const lower = (name, fallback = '') => env(name, fallback).toLowerCase();
const num = (name, fallback) => {
  const value = Number(env(name));
  return env(name) !== '' && Number.isFinite(value) ? value : fallback;
};
const bool = (name, fallback) => {
  const value = env(name).toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on', 'نعم'].includes(value);
};
const list = (name, fallback) =>
  env(name, fallback)
    .split(/[,،]/)
    .map((s) => s.trim())
    .filter(Boolean);
/** A list of model names; "none" means no models. */
const models = (name, fallback) => list(name, fallback).filter((m) => !['none', 'off', 'false', 'no'].includes(m.toLowerCase()));

const DEFAULT_PROMPT = `أنتِ {{BOT_NAME}}، مساعدة ذكاء اصطناعي صوتية في روم صوتي في سيرفر ديسكورد "{{SERVER_NAME}}". إذا أحد سألج منو أنتِ، قولي إنج {{BOT_NAME}}.
ردودج تتحول لصوت، فخليها قصيرة وطبيعية (جملة إلى ثلاث جمل) وبدون إيموجي أو ماركداون أو روابط.
تكلمي عربي بلهجة إماراتية واضحة بس، حتى لو أحد كلمج بالإنجليزي.
الكلام يوصلج بصيغة "الاسم: الكلام" من تحويل صوت لنص، فممكن يكون فيه أخطاء؛ افهمي المقصود.
الوقت الحين: {{NOW}} ({{TIMEZONE}}).`;

// How Gemini's designed voice should sound (GEMINI_VOICE=auto).
const DEFAULT_VOICE_DESIGN =
  'A young Emirati woman in her early twenties from the United Arab Emirates who speaks natural Emirati Gulf Arabic with an authentic Emirati accent. ' +
  'Bright, lively and energetic, smiling and playful while she talks, with a brisk, upbeat conversational pace and crisp, clear articulation. Never sleepy, slow or monotone.';
// How she should deliver every line (Gemini voices): awake and quick, not sleepy.
const DEFAULT_VOICE_STYLE = 'lively, upbeat and energetic, smiling, with a brisk natural pace — never sleepy or slow';

function loadPrompt() {
  const file = path.resolve(ROOT, env('PROMPT_FILE', 'prompt.txt'));
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    if (text) return text;
  }
  return DEFAULT_PROMPT;
}

const groqKey = env('GROQ_API_KEY');
const geminiKey = env('GEMINI_API_KEY') || env('GOOGLE_API_KEY');

const azureKey = env('AZURE_SPEECH_KEY');

// Groq listens. The brains are many models (Groq, Gemini and the extra services), each with its own free limit;
// they are asked in a fast order for the voice and in another order for the written chat (so the chat never eats the voice's limits).
// LLM_PROVIDER / LLM_FALLBACK set by hand replace that order with your own.
const llmChosen = lower('LLM_PROVIDER');
const llmProvider = llmChosen || (geminiKey ? 'gemini' : 'groq');
const sttProvider = lower('STT_PROVIDER', 'groq');
// The voice: Azure's Emirati voice is the clearest and fastest, so it speaks first when its key is set; then Gemini, then Groq.
const ttsProvider = lower('TTS_PROVIDER', azureKey ? 'azure' : geminiKey ? 'gemini' : 'groq');

/** Several backups in order ("azure,groq"); with `none` there are none. */
function backupsFor(name, provider, fallback) {
  const out = [];
  for (const item of list(name, fallback).map((s) => s.toLowerCase())) {
    if (['none', 'off', 'false', 'no', 'لا'].includes(item)) return [];
    if (item === provider || out.includes(item) || (item === 'groq' && !groqKey)) continue;
    out.push(item);
  }
  return out;
}

// Voice backups, in order: Gemini, Azure, Groq (each one only when its key is there).
const ttsBackups = backupsFor(
  'TTS_FALLBACK',
  ttsProvider,
  [geminiKey && 'gemini', azureKey && 'azure', groqKey && 'groq'].filter(Boolean).join(',') || 'none',
);

// More brains that speak the OpenAI chat format. Each one joins the backup chain by itself as soon as its key is set.
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_CHAT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const EXTRA_BRAINS = {
  // Groq and Gemini count their free limits per model, so each of these models has its own limit
  // (with the same GROQ_API_KEY / GEMINI_API_KEY, no new key). <NAME>_CHAT_MODEL=none turns one off.
  groq20b: { label: 'Groq gpt-oss-20b', url: GROQ_CHAT, model: 'openai/gpt-oss-20b', shares: 'groq' },
  groqqwen: { label: 'Groq Qwen', url: GROQ_CHAT, model: 'qwen/qwen3.8-27b', shares: 'groq' },
  geminilite: { label: 'Gemini 3.1 Flash-Lite', url: GEMINI_CHAT, model: 'gemini-3.1-flash-lite', shares: 'gemini' },
  geminiflash: { label: 'Gemini 3.6 Flash', url: GEMINI_CHAT, model: 'gemini-3.6-flash', shares: 'gemini' },
  gemini38: { label: 'Gemini 3.8 Flash', url: GEMINI_CHAT, model: 'gemini-3.8-flash', shares: 'gemini' },
  cerebras: { label: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', model: 'gpt-oss-120b' },
  openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free' },
  mistral: { label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', model: 'mistral-small-latest' },
  sambanova: { label: 'SambaNova', url: 'https://api.sambanova.ai/v1/chat/completions', model: 'Meta-Llama-3.3-70B-Instruct' },
  // Any other OpenAI-compatible service: CUSTOM_LLM_URL (the full .../chat/completions address), CUSTOM_LLM_API_KEY, CUSTOM_LLM_MODEL.
  custom: { label: 'Custom', url: env('CUSTOM_LLM_URL'), model: env('CUSTOM_LLM_MODEL') },
};
const extraBrains = Object.fromEntries(
  Object.entries(EXTRA_BRAINS).map(([name, brain]) => {
    const upper = name.toUpperCase();
    return [
      name,
      {
        label: brain.label,
        keyName: name === 'custom' ? 'CUSTOM_LLM_API_KEY' : `${upper}_API_KEY`,
        url: env(`${upper}_CHAT_URL`, brain.url),
        apiKey:
          env(name === 'custom' ? 'CUSTOM_LLM_API_KEY' : `${upper}_API_KEY`) ||
          (brain.shares === 'groq' ? groqKey : brain.shares === 'gemini' ? geminiKey : ''),
        model: env(name === 'custom' ? 'CUSTOM_LLM_MODEL' : `${upper}_CHAT_MODEL`, brain.model),
        shares: brain.shares ?? '',
        maxTokens: num('EXTRA_MAX_TOKENS', 0), // 0 = the usual size for the voice / the chat
      },
    ];
  }),
);
const geminiChatModel = env('GEMINI_CHAT_MODEL', 'gemini-3.5-flash-lite');
const groqChatModel = env('GROQ_CHAT_MODEL', 'openai/gpt-oss-120b');
const mainModel = { gemini: geminiChatModel, groq: groqChatModel };
const extraNames = Object.keys(extraBrains).filter((name) => {
  const brain = extraBrains[name];
  if (!brain.apiKey || !brain.url || !brain.model || brain.model.toLowerCase() === 'none') return false;
  return !brain.shares || brain.model !== mainModel[brain.shares]; // the same model twice would share one limit
});

// Voice: Gemini Flash-Lite first (fast, and the best Emirati dialect for its speed); if it is slow, Groq joins and the
// first answer wins; then the other models.
const VOICE_ORDER = ['gemini', 'groq', 'geminilite', 'groq20b', 'groqqwen', 'mistral', 'geminiflash', 'cerebras', 'openrouter', 'sambanova', 'gemini38', 'custom'];
// Written chat: other models first, so the voice keeps its limits.
// (the strongest Arabic first; OpenRouter's random free models last: they wrote nonsense in the chat)
const TEXT_ORDER = ['geminilite', 'gemini', 'geminiflash', 'groq', 'groq20b', 'groqqwen', 'mistral', 'cerebras', 'sambanova', 'gemini38', 'openrouter', 'custom'];
const hasBrain = (name) => (name === 'gemini' ? !!geminiKey : name === 'groq' ? !!groqKey : extraNames.includes(name));

function brainChain(order) {
  if (!llmChosen && !env('LLM_FALLBACK')) return order.filter(hasBrain);
  // Chosen by hand: the main brain first, then LLM_FALLBACK (or the usual order).
  const backups = env('LLM_FALLBACK')
    ? backupsFor('LLM_FALLBACK', llmProvider, env('LLM_FALLBACK'))
    : order.filter((name) => name !== llmProvider && hasBrain(name));
  return [llmProvider, ...backups];
}
const voiceBrains = brainChain(VOICE_ORDER);
const textBrains = brainChain(TEXT_ORDER);
const llmBackups = voiceBrains.slice(1);

const botName = env('BOT_NAME', 'فطوم');

export const config = {
  discordToken: env('DISCORD_TOKEN'),

  botName,
  // The bot's own name always counts as a wake word.
  wakeWords: [...new Set([botName, ...list('WAKE_WORDS', 'فطوم,فطومه,فطومي,فاطوم,بوت,bot')])],
  // What the bot says when it is only called by name.
  ackReplies: list('ACK_REPLIES', 'ها حياتي,هلا ابوي تفضل,ها عيوني شي؟'),
  // Words that make her stop talking. Said to her (her name, or "اسكتي/وقفي"), by the one she is answering, or in a room of two;
  // "بس" / "خلاص" between other people in a big room doesn't stop her.
  stopWords: list('STOP_WORDS', 'اسكتي,سكتي,اسكت,وقفي,وقف,خلاص,بس,بسج,كفايه,stop'),
  replyMode: lower('REPLY_MODE', 'name'), // name | everyone
  // Written chat: the channels she chats in (IDs, comma separated; 'none' = no written chat). Needs "Message Content Intent".
  textChannelIds: list('TEXT_CHANNEL_IDS', '1557103411579850852').filter((id) => /^\d{15,25}$/.test(id)),
  textReplyMode: lower('TEXT_REPLY_MODE', 'questions'), // name = only when called | questions = also questions | everyone = every message
  textFollowUpSeconds: num('TEXT_FOLLOWUP_SECONDS', 20), // after she answers someone, their next messages need no name
  textCooldownSeconds: num('TEXT_COOLDOWN_SECONDS', 90), // minimum gap between answers nobody asked her for
  textFollowUpsInARow: num('TEXT_FOLLOWUPS_IN_A_ROW', 2), // follow-ups without her name before she needs to be called again
  // Bots she chats with (names or IDs): they get an answer only when they talk to her, a few turns in a row at most.
  friendBots: list('FRIEND_BOTS', 'حسون,hassoun'),
  textBotChainMax: num('TEXT_BOT_CHAIN_MAX', 3),
  textBotCooldownSeconds: num('TEXT_BOT_COOLDOWN_SECONDS', 6),
  followUpSeconds: num('FOLLOWUP_SECONDS', 15),
  // Talking on without the name only works when the room has at most this many people.
  followUpMaxPeople: num('FOLLOWUP_MAX_PEOPLE', 2),
  // In a bigger room, the one she just answered can ask one more question without her name within this time.
  followUpBigSeconds: num('FOLLOWUP_BIG_SECONDS', 10),
  // A question still waiting this long (she was busy) is dropped instead of being answered late.
  staleSeconds: num('STALE_SECONDS', 40),
  // "السلام عليكم": she answers it in any room, once in this time per person.
  salamCooldownSeconds: num('SALAM_COOLDOWN_SECONDS', 600),
  autoJoinChannelId: env('AUTO_JOIN_CHANNEL_ID'),
  leaveWhenAloneSeconds: num('LEAVE_WHEN_ALONE_SECONDS', 60),
  // The bot writes in the voice room's text chat only when this is true; otherwise everything goes to the logs.
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')), // where what she remembers is saved
  rememberPeople: bool('REMEMBER_PEOPLE', true), // remember people / the server between conversations
  quietDays: num('QUIET_DAYS', 3), // someone not seen for this many days counts as "gone quiet"
  chatMessages: bool('CHAT_MESSAGES', false),
  postTranscripts: bool('POST_TRANSCRIPTS', true),
  // Say hello by name when someone comes into the room.
  welcome: bool('WELCOME', true),
  welcomeReplies: list('WELCOME_REPLIES', 'هلا والله {name},يا هلا والله {name},هلا {name} مرحبا'),
  welcomeCooldownSeconds: num('WELCOME_COOLDOWN_SECONDS', 180), // no second hello to the same person within this time
  welcomeDelayMs: num('WELCOME_DELAY_MS', 1200), // wait a moment so people who come in together get one hello
  // Stop talking when someone talks over her. Off: she finishes her sentence; "فطوم اسكتي" still stops her.
  bargeIn: bool('BARGE_IN', false),
  bargeInMs: num('BARGE_IN_MS', 500), // how long they must speak before she stops (ignores coughs and clicks)
  // "فطوم روحي روم القهوة": move to another voice room on request.
  moveByVoice: bool('MOVE_BY_VOICE', true),
  avatarUpdate: bool('BOT_AVATAR_UPDATE', false), // put avatar.png on the bot even if it has a picture
  timezone: env('TIMEZONE', 'Asia/Dubai'),
  debug: bool('DEBUG', false),

  // Listening
  silenceMs: num('SILENCE_MS', 500), // pause that ends a sentence (shorter = she answers sooner)
  minSpeechMs: num('MIN_SPEECH_MS', 350), // shorter sounds are ignored
  maxSpeechSeconds: num('MAX_SPEECH_SECONDS', 30),
  minVolume: num('MIN_VOLUME', 100), // RMS level below which audio counts as silence

  // The brain: Gemini or a Groq chat model.
  llm: {
    provider: voiceBrains[0] ?? llmProvider,
    fallbacks: llmBackups, // tried in this order when the main brain fails or is slow
    fallback: llmBackups[0] ?? '',
    chain: voiceBrains, // the voice's order
    textChain: textBrains, // the written chat's order
    extras: extraBrains,
    hedgeMs: num('LLM_HEDGE_MS', 500), // if the main brain is slower than this, the backup starts too and the first answer wins (0 = off)
    // Fresh facts (news, weather, prices...) from Google Search through Gemini: auto = only for questions that need it, always, or off.
    webSearch: lower('WEB_SEARCH', 'auto'),
    searchWords: list('SEARCH_WORDS', ''), // extra words that make her search
    searchHedgeMs: num('SEARCH_HEDGE_MS', 8000), // a search takes longer, so the backup brain (no search) waits longer
    gemini: {
      apiKey: geminiKey,
      // Flash-Lite: fast, and its free limit is about 500 a day (3.8 Flash only gets 20, so it is a late backup).
      model: geminiChatModel,
      thinking: lower('GEMINI_THINKING', 'auto'), // auto | minimal | low | medium | high
      maxTokens: num('GEMINI_MAX_TOKENS', 2048),
    },
    groq: {
      apiKey: groqKey,
      model: groqChatModel,
      // Groq counts the reply's room against its per-minute limit, so short voice replies get a small room.
      maxTokens: num('MAX_REPLY_TOKENS', 400),
      textMaxTokens: num('TEXT_MAX_REPLY_TOKENS', 700),
    },
    // Short memory keeps each request small (free plans limit tokens per minute).
    memoryTurns: num('MEMORY_TURNS', 6),
    memoryMinutes: num('MEMORY_MINUTES', 30),
  },

  stt: {
    provider: sttProvider,
    language: env('STT_LANGUAGE', 'ar'),
    ...(sttProvider === 'openai'
      ? {
          url: 'https://api.openai.com/v1/audio/transcriptions',
          apiKey: env('OPENAI_API_KEY'),
          model: env('STT_MODEL', 'gpt-transcribe'),
          fallbackModels: list('STT_FALLBACK_MODELS', ''),
        }
      : {
          url: 'https://api.groq.com/openai/v1/audio/transcriptions',
          apiKey: groqKey,
          model: env('STT_MODEL', 'whisper-large-v3-turbo'),
          // Groq counts the free limit (20 requests a minute) per model, so a second model doubles it.
          fallbackModels: models('STT_FALLBACK_MODELS', 'whisper-large-v3'),
        }),
    // Last backup ears: Mistral's Voxtral (with MISTRAL_API_KEY; STT_MISTRAL=false turns it off).
    mistral: {
      apiKey: bool('STT_MISTRAL', true) ? env('MISTRAL_API_KEY') : '',
      url: 'https://api.mistral.ai/v1/audio/transcriptions',
      model: env('MISTRAL_STT_MODEL', 'voxtral-mini-latest'),
    },
  },

  tts: {
    provider: ttsProvider,
    fallbacks: ttsBackups, // tried in this order when the main voice fails (used-up limit...)
    fallback: ttsBackups[0] ?? '',
    louder: bool('VOICE_LOUDER', true), // raise quiet voices to a normal level
    // Cut the silence before/after her words and shorten long pauses (voices that pause a lot sound sleepy and slow).
    tight: bool('VOICE_TIGHT', true),
    maxPauseMs: num('VOICE_MAX_PAUSE_MS', 280),
    stream: bool('TTS_STREAM', true), // Gemini voice starts playing while it is still being made
    gemini: {
      apiKey: geminiKey,
      model: env('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts'),
      // Each Gemini voice model has its own free limit: when one is used up, the next one speaks (same voice).
      fallbackModels: models('GEMINI_TTS_FALLBACK_MODELS', 'gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview').filter(
        (model) => model !== env('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts'),
      ),
      // auto = design a young Emirati woman's voice once and reuse it;
      // or a ready voice (Leda, Kore, Aoede, Zephyr, Sulafat…) or a voice ID (voice_…).
      voice: env('GEMINI_VOICE', 'auto'),
      voiceDesign: env('GEMINI_VOICE_DESIGN', DEFAULT_VOICE_DESIGN),
      style: env('GEMINI_VOICE_STYLE', DEFAULT_VOICE_STYLE), // how she delivers each line (none = the voice's own way)
    },
    groq: {
      apiKey: groqKey,
      modelAr: env('GROQ_TTS_MODEL_AR', 'canopylabs/orpheus-arabic-saudi'),
      modelEn: env('GROQ_TTS_MODEL_EN', 'canopylabs/orpheus-v1-english'),
      voiceAr: env('GROQ_VOICE_AR', 'noura'),
      voiceEn: env('GROQ_VOICE_EN', 'hannah'),
    },
    azure: {
      apiKey: azureKey,
      region: env('AZURE_SPEECH_REGION', 'uaenorth'),
      voiceAr: env('AZURE_VOICE_AR', 'ar-AE-FatimaNeural'),
      rate: env('AZURE_RATE', '+10%'), // a bit quicker than the default (sounds awake, not sleepy)
      voiceEn: env('AZURE_VOICE_EN', 'en-US-JennyNeural'),
    },
    elevenlabs: {
      apiKey: env('ELEVENLABS_API_KEY'),
      voiceId: env('ELEVENLABS_VOICE_ID', 'JBFqnCBsd6RMkjVDRZzb'),
      model: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
    },
  },

  systemPrompt: loadPrompt(),
};

/** Returns a list of problems (in Arabic) that stop the bot from starting. */
export function validateConfig() {
  const problems = [];
  const need = (value, message) => {
    if (!value) problems.push(message);
  };
  const GROQ_HELP = 'سو مفتاح مجاني من https://console.groq.com/keys';
  const GEMINI_HELP = 'سو مفتاح مجاني من https://aistudio.google.com/apikey';

  need(config.discordToken, 'DISCORD_TOKEN فاضي — حط توكن البوت من Discord Developer Portal.');

  if (!['name', 'questions', 'everyone'].includes(config.textReplyMode)) {
    problems.push('TEXT_REPLY_MODE لازم يكون name أو questions أو everyone.');
  }
  if (!['name', 'everyone'].includes(config.replyMode)) {
    problems.push('REPLY_MODE لازم يكون name أو everyone.');
  }

  // Listening
  if (!['groq', 'openai'].includes(config.stt.provider)) {
    problems.push('STT_PROVIDER لازم يكون groq أو openai.');
  } else if (config.stt.provider === 'openai') {
    need(config.stt.apiKey, 'OPENAI_API_KEY فاضي (مطلوب لأن STT_PROVIDER=openai).');
  } else {
    need(config.stt.apiKey, `GROQ_API_KEY فاضي — ${GROQ_HELP} (البوت يسمعكم عن طريقه).`);
  }

  // The brain
  const { llm } = config;
  for (const [setting, provider] of [['LLM_PROVIDER', llm.provider], ...llm.fallbacks.map((name) => ['LLM_FALLBACK', name])]) {
    if (provider === 'gemini') need(llm.gemini.apiKey, `GEMINI_API_KEY فاضي — ${GEMINI_HELP}`);
    else if (provider === 'groq') need(llm.groq.apiKey, `GROQ_API_KEY فاضي — ${GROQ_HELP}`);
    else if (llm.extras[provider]) {
      const brain = llm.extras[provider];
      need(brain.apiKey, `${brain.keyName} فاضي (مطلوب لأن ${setting}=${provider}).`);
      need(brain.url, `${provider.toUpperCase()}_CHAT_URL فاضي.`);
      need(brain.model, `${provider.toUpperCase()}_CHAT_MODEL فاضي.`);
    } else if (provider) {
      problems.push(`${setting} لازم يكون gemini أو groq أو ${Object.keys(llm.extras).join(' أو ')}.`);
    }
  }

  // The voice
  const t = config.tts;
  for (const [setting, provider] of [['TTS_PROVIDER', t.provider], ...t.fallbacks.map((name) => ['TTS_FALLBACK', name])]) {
    if (!provider) continue;
    if (provider === 'gemini') need(t.gemini.apiKey, `GEMINI_API_KEY فاضي — ${GEMINI_HELP}`);
    else if (provider === 'groq') need(t.groq.apiKey, `GROQ_API_KEY فاضي — ${GROQ_HELP}`);
    else if (provider === 'azure') {
      need(t.azure.apiKey, `AZURE_SPEECH_KEY فاضي (مطلوب لأن ${setting}=azure).`);
      need(t.azure.region, 'AZURE_SPEECH_REGION فاضي (مثلاً uaenorth).');
    } else if (provider === 'elevenlabs') {
      need(t.elevenlabs.apiKey, `ELEVENLABS_API_KEY فاضي (مطلوب لأن ${setting}=elevenlabs).`);
    } else {
      problems.push(`${setting} لازم يكون gemini أو groq أو azure أو elevenlabs.`);
    }
  }

  // One message per setting (one key can be needed for listening, thinking and speaking).
  const seen = new Set();
  return problems.filter((problem) => {
    const setting = problem.split(' ')[0];
    if (seen.has(setting)) return false;
    seen.add(setting);
    return true;
  });
}

// ---------- Console log with time ----------
let clock;
try {
  clock = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', hour12: false, timeZone: config.timezone });
} catch {
  clock = new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium', hour12: false });
}
const time = () => clock.format(new Date());

export const log = {
  info: (...args) => console.log(`[${time()}]`, ...args),
  warn: (...args) => console.warn(`[${time()}] ⚠️`, ...args),
  error: (...args) => console.error(`[${time()}] ❌`, ...args),
  debug: (...args) => {
    if (config.debug) console.log(`[${time()}] 🐞`, ...args);
  },
};
