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

const DEFAULT_PROMPT = `أنت {{BOT_NAME}}، مساعد ذكاء اصطناعي صوتي في روم صوتي في سيرفر ديسكورد "{{SERVER_NAME}}". إذا أحد سألك منو أنت، قل إنك {{BOT_NAME}}.
ردودك تتحول لصوت، فخلها قصيرة وطبيعية (جملة إلى ثلاث جمل) وبدون إيموجي أو ماركداون أو روابط.
إذا كلموك بالعربي رد بلهجة خليجية إماراتية واضحة، وإذا كلموك بالإنجليزي رد بالإنجليزي.
الكلام يوصلك بصيغة "الاسم: الكلام" من تحويل صوت لنص، فممكن يكون فيه أخطاء؛ افهم المقصود.
الوقت الحين: {{NOW}} ({{TIMEZONE}}).`;

function loadPrompt() {
  const file = path.resolve(ROOT, env('PROMPT_FILE', 'prompt.txt'));
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim();
    if (text) return text;
  }
  return DEFAULT_PROMPT;
}

const sttProvider = env('STT_PROVIDER', 'groq').toLowerCase();
const ttsProvider = env('TTS_PROVIDER', 'groq').toLowerCase();
const botName = env('BOT_NAME', 'بوت');

export const config = {
  discordToken: env('DISCORD_TOKEN'),

  botName,
  // The bot's own name always counts as a wake word.
  wakeWords: [...new Set([botName, ...list('WAKE_WORDS', 'بوت,bot')])],
  stopWords: list('STOP_WORDS', 'اسكت,خلاص,بس,وقف,كفايه,stop'),
  replyMode: env('REPLY_MODE', 'name').toLowerCase(), // name | everyone
  followUpSeconds: num('FOLLOWUP_SECONDS', 15),
  autoJoinChannelId: env('AUTO_JOIN_CHANNEL_ID'),
  leaveWhenAloneSeconds: num('LEAVE_WHEN_ALONE_SECONDS', 60),
  postTranscripts: bool('POST_TRANSCRIPTS', true),
  timezone: env('TIMEZONE', 'Asia/Dubai'),
  debug: bool('DEBUG', false),

  // Listening
  silenceMs: num('SILENCE_MS', 1000), // pause that ends a sentence
  minSpeechMs: num('MIN_SPEECH_MS', 350), // shorter sounds are ignored
  maxSpeechSeconds: num('MAX_SPEECH_SECONDS', 30),
  minVolume: num('MIN_VOLUME', 100), // RMS level below which audio counts as silence

  // The brain: a Groq chat model (same Groq key as listening and speaking).
  llm: {
    apiKey: env('GROQ_API_KEY'),
    model: env('GROQ_CHAT_MODEL', 'openai/gpt-oss-120b'),
    maxTokens: num('MAX_REPLY_TOKENS', 1024),
    // Short memory keeps each request small (Groq's free plan limits tokens per minute).
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
          apiKey: env('GROQ_API_KEY'),
          model: env('STT_MODEL', 'whisper-large-v3-turbo'),
        }),
  },

  tts: {
    provider: ttsProvider,
    groq: {
      apiKey: env('GROQ_API_KEY'),
      modelAr: env('GROQ_TTS_MODEL_AR', 'canopylabs/orpheus-arabic-saudi'),
      modelEn: env('GROQ_TTS_MODEL_EN', 'canopylabs/orpheus-v1-english'),
      voiceAr: env('GROQ_VOICE_AR', 'sultan'),
      voiceEn: env('GROQ_VOICE_EN', 'troy'),
    },
    azure: {
      apiKey: env('AZURE_SPEECH_KEY'),
      region: env('AZURE_SPEECH_REGION', 'uaenorth'),
      voiceAr: env('AZURE_VOICE_AR', 'ar-AE-HamdanNeural'),
      voiceEn: env('AZURE_VOICE_EN', 'en-US-GuyNeural'),
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

  need(config.discordToken, 'DISCORD_TOKEN فاضي — حط توكن البوت من Discord Developer Portal.');
  need(config.llm.apiKey, 'GROQ_API_KEY فاضي — سو مفتاح مجاني من https://console.groq.com/keys');

  if (!['name', 'everyone'].includes(config.replyMode)) {
    problems.push('REPLY_MODE لازم يكون name أو everyone.');
  }

  if (!['groq', 'openai'].includes(config.stt.provider)) {
    problems.push('STT_PROVIDER لازم يكون groq أو openai.');
  } else {
    need(
      config.stt.apiKey,
      config.stt.provider === 'openai'
        ? 'OPENAI_API_KEY فاضي (مطلوب لأن STT_PROVIDER=openai).'
        : 'GROQ_API_KEY فاضي — سو مفتاح مجاني من https://console.groq.com/keys',
    );
  }

  const t = config.tts;
  if (t.provider === 'groq') need(t.groq.apiKey, 'GROQ_API_KEY فاضي (مطلوب لأن TTS_PROVIDER=groq).');
  else if (t.provider === 'azure') {
    need(t.azure.apiKey, 'AZURE_SPEECH_KEY فاضي (مطلوب لأن TTS_PROVIDER=azure).');
    need(t.azure.region, 'AZURE_SPEECH_REGION فاضي (مثلاً uaenorth).');
  } else if (t.provider === 'elevenlabs') {
    need(t.elevenlabs.apiKey, 'ELEVENLABS_API_KEY فاضي (مطلوب لأن TTS_PROVIDER=elevenlabs).');
  } else {
    problems.push('TTS_PROVIDER لازم يكون groq أو azure أو elevenlabs.');
  }

  // One message per setting (Groq's key can be needed for both listening and speaking).
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
