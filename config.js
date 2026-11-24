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

const DEFAULT_PROMPT = `أنتِ {{BOT_NAME}}، مساعدة ذكاء اصطناعي صوتية في روم صوتي في سيرفر ديسكورد "{{SERVER_NAME}}". إذا أحد سألج منو أنتِ، قولي إنج {{BOT_NAME}}.
ردودج تتحول لصوت، فخليها قصيرة وطبيعية (جملة إلى ثلاث جمل) وبدون إيموجي أو ماركداون أو روابط.
تكلمي عربي بلهجة إماراتية واضحة بس، حتى لو أحد كلمج بالإنجليزي.
الكلام يوصلج بصيغة "الاسم: الكلام" من تحويل صوت لنص، فممكن يكون فيه أخطاء؛ افهمي المقصود.
الوقت الحين: {{NOW}} ({{TIMEZONE}}).`;

// How Gemini's designed voice should sound (GEMINI_VOICE=auto).
const DEFAULT_VOICE_DESIGN =
  'A young Emirati woman in her early twenties from the United Arab Emirates who speaks natural Emirati Gulf Arabic with an authentic Emirati accent. Warm, friendly and cheerful, with a relaxed conversational pace.';

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

// With a Gemini key, Gemini thinks and speaks; Groq listens, and stands in when Gemini can't.
const llmProvider = lower('LLM_PROVIDER', geminiKey ? 'gemini' : 'groq');
const sttProvider = lower('STT_PROVIDER', 'groq');
const ttsProvider = lower('TTS_PROVIDER', geminiKey ? 'gemini' : 'groq');

/** The service that steps in when the main one fails ('' = none). */
function backupFor(name, provider) {
  const value = lower(name, 'groq');
  if (['none', 'off', 'false', 'no', 'لا', provider].includes(value)) return '';
  if (value === 'groq' && !groqKey) return '';
  return value;
}

const botName = env('BOT_NAME', 'فطوم');

export const config = {
  discordToken: env('DISCORD_TOKEN'),

  botName,
  // The bot's own name always counts as a wake word.
  wakeWords: [...new Set([botName, ...list('WAKE_WORDS', 'فطوم,فطومه,فطومي,فاطوم,بوت,bot')])],
  // What the bot says when it is only called by name.
  ackReplies: list('ACK_REPLIES', 'ها حياتي,هلا ابوي تفضل,ها عيوني شي؟'),
  stopWords: list('STOP_WORDS', 'اسكت,خلاص,بس,وقف,كفايه,stop'),
  replyMode: lower('REPLY_MODE', 'name'), // name | everyone
  followUpSeconds: num('FOLLOWUP_SECONDS', 15),
  // Talking on without the name only works when the room has at most this many people.
  followUpMaxPeople: num('FOLLOWUP_MAX_PEOPLE', 2),
  autoJoinChannelId: env('AUTO_JOIN_CHANNEL_ID'),
  leaveWhenAloneSeconds: num('LEAVE_WHEN_ALONE_SECONDS', 60),
  // The bot writes in the voice room's text chat only when this is true; otherwise everything goes to the logs.
  chatMessages: bool('CHAT_MESSAGES', false),
  postTranscripts: bool('POST_TRANSCRIPTS', true),
  avatarUpdate: bool('BOT_AVATAR_UPDATE', false), // put avatar.png on the bot even if it has a picture
  timezone: env('TIMEZONE', 'Asia/Dubai'),
  debug: bool('DEBUG', false),

  // Listening
  silenceMs: num('SILENCE_MS', 650), // pause that ends a sentence (shorter = she answers sooner)
  minSpeechMs: num('MIN_SPEECH_MS', 350), // shorter sounds are ignored
  maxSpeechSeconds: num('MAX_SPEECH_SECONDS', 30),
  minVolume: num('MIN_VOLUME', 100), // RMS level below which audio counts as silence

  // The brain: Gemini or a Groq chat model.
  llm: {
    provider: llmProvider,
    fallback: backupFor('LLM_FALLBACK', llmProvider),
    hedgeMs: num('LLM_HEDGE_MS', 1500), // if the main brain is slower than this, the backup starts too and the first answer wins (0 = off)
    gemini: {
      apiKey: geminiKey,
      model: env('GEMINI_CHAT_MODEL', 'gemini-3.8-flash'),
      thinking: lower('GEMINI_THINKING', 'auto'), // auto | minimal | low | medium | high
      maxTokens: num('GEMINI_MAX_TOKENS', 2048),
    },
    groq: {
      apiKey: groqKey,
      model: env('GROQ_CHAT_MODEL', 'openai/gpt-oss-120b'),
      maxTokens: num('MAX_REPLY_TOKENS', 1024),
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
        }
      : {
          url: 'https://api.groq.com/openai/v1/audio/transcriptions',
          apiKey: groqKey,
          model: env('STT_MODEL', 'whisper-large-v3-turbo'),
        }),
  },

  tts: {
    provider: ttsProvider,
    fallback: backupFor('TTS_FALLBACK', ttsProvider),
    louder: bool('VOICE_LOUDER', true), // raise quiet voices to a normal level
    stream: bool('TTS_STREAM', true), // Gemini voice starts playing while it is still being made
    gemini: {
      apiKey: geminiKey,
      model: env('GEMINI_TTS_MODEL', 'gemini-3.8-flash-tts'),
      // auto = design a young Emirati woman's voice once and reuse it;
      // or a ready voice (Leda, Kore, Aoede, Zephyr, Sulafat…) or a voice ID (voice_…).
      voice: env('GEMINI_VOICE', 'auto'),
      voiceDesign: env('GEMINI_VOICE_DESIGN', DEFAULT_VOICE_DESIGN),
      style: env('GEMINI_VOICE_STYLE'), // optional, e.g. "cheerful and playful"
    },
    groq: {
      apiKey: groqKey,
      modelAr: env('GROQ_TTS_MODEL_AR', 'canopylabs/orpheus-arabic-saudi'),
      modelEn: env('GROQ_TTS_MODEL_EN', 'canopylabs/orpheus-v1-english'),
      voiceAr: env('GROQ_VOICE_AR', 'noura'),
      voiceEn: env('GROQ_VOICE_EN', 'hannah'),
    },
    azure: {
      apiKey: env('AZURE_SPEECH_KEY'),
      region: env('AZURE_SPEECH_REGION', 'uaenorth'),
      voiceAr: env('AZURE_VOICE_AR', 'ar-AE-FatimaNeural'),
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
  for (const [setting, provider] of [
    ['LLM_PROVIDER', llm.provider],
    ['LLM_FALLBACK', llm.fallback],
  ]) {
    if (provider === 'gemini') need(llm.gemini.apiKey, `GEMINI_API_KEY فاضي — ${GEMINI_HELP}`);
    else if (provider === 'groq') need(llm.groq.apiKey, `GROQ_API_KEY فاضي — ${GROQ_HELP}`);
    else if (provider) problems.push(`${setting} لازم يكون gemini أو groq.`);
  }

  // The voice
  const t = config.tts;
  for (const [setting, provider] of [
    ['TTS_PROVIDER', t.provider],
    ['TTS_FALLBACK', t.fallback],
  ]) {
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
