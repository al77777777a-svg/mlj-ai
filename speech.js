// Speech services:
// - transcribe(): speech → text (Groq Whisper by default, or OpenAI)
// - synthesize(): text → speech (Gemini, Groq, Azure or ElevenLabs), returns WAV/MP3 bytes.
//   If the main voice fails (for example Gemini's free daily limit is used up),
//   the backup voice (Groq) speaks instead until the main one works again.
// - apiRequest() / apiError() / rest(): shared helpers (also used by llm.js)
import { config, log } from './config.js';
import { joinClips, louder, mostlyLatin, pcmToWav, readWav, splitForSpeech } from './helpers.js';

export const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
export const PROVIDER_NAMES = { gemini: 'Gemini', groq: 'Groq', azure: 'Azure', elevenlabs: 'ElevenLabs' };

// ---------- HTTP helpers ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch with a 30 s timeout. When the service says "too many requests" (429)
 * and asks to wait only a few seconds, wait and try once more.
 */
export async function apiRequest(url, init, timeoutMs = 30_000, { retry429 = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const header = res.headers.get('retry-after');
    const wait = header === null ? NaN : Number(header);
    if (!retry429 || res.status !== 429 || attempt > 0 || !(wait >= 0 && wait <= 8)) return res;
    await sleep(wait * 1000 + 300);
  }
}

/** Turn a failed response into an Error that carries the HTTP status. */
export async function apiError(res, label) {
  const body = await res.text().catch(() => '');
  const error = new Error(`${label} ${res.status}: ${body.slice(0, 300)}`);
  error.status = res.status;
  error.body = body.slice(0, 4000);
  return error;
}

/** A one-line version of an error for chat messages. */
export function shortError(error) {
  return String(error?.message ?? error)
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

// ---------- Letting a failing service rest ----------
// After an error (e.g. a used-up free limit) a service is left alone for a while
// and its backup is used instead, so the bot doesn't wait on a failing request every time.
const restingUntil = new Map(); // key → time
const lastNotice = new Map(); // key + status → time

export function isResting(key) {
  return (restingUntil.get(key) ?? 0) > Date.now();
}

/** The wait a service asks for ("retry in 3s", "retryDelay": "34s", "try again in 7m12.5s"), in seconds; NaN if none. */
export function askedWait(details) {
  const match = /(?:retry(?:Delay"?\s*:\s*"|\s+in\s+)|try again in\s+)(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?/i.exec(details);
  if (!match || !(match[1] || match[2] || match[3])) return NaN;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

/** How long (ms) to leave a service alone after this error. */
export function restTime(error) {
  const status = error?.status;
  const details = `${error?.message ?? ''} ${error?.body ?? ''}`;
  if (status === 429) {
    const seconds = askedWait(details);
    // A daily limit won't come back soon (unless the service says exactly when, as Groq does).
    if (/per ?day|daily/i.test(details) && !(seconds >= 60)) return 60 * 60_000;
    return Math.min(Math.max((seconds || 60) * 1000, 20_000), 60 * 60_000);
  }
  if ([400, 401, 403, 404].includes(status)) return 30 * 60_000; // a settings problem won't fix itself soon
  return 30_000; // busy server, timeout or network hiccup
}

/**
 * Let a service rest after an error. Returns true when the room should be told
 * (at most once every 3 hours for the same service and reason).
 */
export function rest(key, error) {
  restingUntil.set(key, Date.now() + restTime(error));
  const noticeKey = `${key}:${error?.status ?? 'network'}`;
  if (Date.now() - (lastNotice.get(noticeKey) ?? 0) < 3 * 60 * 60_000) return false;
  lastNotice.set(noticeKey, Date.now());
  return true;
}

// ---------- Speech to text ----------
function buildForm(audio, file, withHints, model = config.stt.model) {
  const language = config.stt.language.toLowerCase() === 'auto' ? '' : config.stt.language;
  const form = new FormData();
  form.append('file', new Blob([audio], { type: file.type }), file.name);
  form.append('model', model);
  form.append('response_format', 'json');
  if (!withHints) return form;

  // Hints help the model spell the bot's name and expect Arabic.
  const names = [...new Set([config.botName, ...config.wakeWords])];
  if (model.startsWith('gpt-transcribe')) {
    for (const name of names) form.append('keywords[]', name);
    for (const lang of new Set([language || 'ar', 'en'])) form.append('languages[]', lang);
  } else {
    if (language) form.append('language', language);
    form.append('prompt', `${names.join('، ')}.`);
  }
  return form;
}

function post(form) {
  return apiRequest(config.stt.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
  });
}

/** Sends one transcription request to one model. */
async function transcribeWith(model, audio, file, hasBackup) {
  const send = (withHints) =>
    apiRequest(config.stt.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.stt.apiKey}` },
      body: buildForm(audio, file, withHints, model),
    }, 30_000, { retry429: !hasBackup }); // with a backup model, switch at once instead of waiting
  let res = await send(true);
  // If the service rejects an optional hint, try once more without hints.
  if (res.status === 400) res = await send(false);
  if (!res.ok) throw await apiError(res, 'STT');
  const data = await res.json();
  return String(data?.text ?? '').trim();
}

/**
 * Sends audio (a WAV buffer by default) and returns the transcript ('' if nothing was understood).
 * If the model hits its limit (Groq: 20 requests a minute per model), the next model takes over.
 */
export async function transcribe(audio, file = { name: 'speech.wav', type: 'audio/wav' }) {
  const models = [config.stt.model, ...(config.stt.fallbackModels ?? [])];
  const awake = models.filter((model) => !isResting(`stt:${model}`));
  const order = awake.length ? awake : models.slice(0, 1);
  let firstError;
  for (let i = 0; i < order.length; i++) {
    try {
      return await transcribeWith(order[i], audio, file, i < order.length - 1);
    } catch (error) {
      firstError ??= error;
      rest(`stt:${order[i]}`, error);
      log.warn(`STT ${order[i]} ما رد${order[i + 1] ? ` — بيسمع ${order[i + 1]} بداله` : ''}: ${shortError(error)}`);
    }
  }
  throw firstError;
}

// ---------- Text to speech ----------
// Longest piece of text sent in one request. Groq's Arabic voice takes 200 characters at most;
// Gemini takes a whole reply at once (one request per reply saves its small free limit).
const CHUNK_LIMITS = { gemini: 1500, groq: 190, azure: 400, elevenlabs: 400 };

/** The voice that speaks now: the main one, or the backup while the main one rests. */
export function activeVoice() {
  const order = [config.tts.provider, ...config.tts.fallbacks];
  return order.find((who) => !isResting(`tts:${who}`)) ?? order[0];
}

export function ttsChunkLimit() {
  return CHUNK_LIMITS[activeVoice()] ?? 400;
}

// Short phrases ("ها حياتي") are kept, so saying them again costs no request.
const clips = new Map();
const CACHE_TEXT_MAX = 60;
const CACHE_SIZE = 40;

function remember(key, clip) {
  clips.delete(key);
  clips.set(key, clip);
  if (clips.size > CACHE_SIZE) clips.delete(clips.keys().next().value);
}

/**
 * Text → audio bytes. `onNotice(message)` is called when the main voice stops
 * working and the backup voice takes over, so the room knows why the voice changed.
 */
export async function synthesize(text, { onNotice } = {}) {
  const order = [config.tts.provider, ...config.tts.fallbacks];
  const cacheable = text.length <= CACHE_TEXT_MAX;
  const speakWith = async (who) => {
    const key = `${who}:${text}`;
    if (cacheable && clips.has(key)) return clips.get(key);
    const clip = await speakAll(who, text);
    if (cacheable) remember(key, clip);
    return clip;
  };

  if (cacheable && clips.has(`${order[0]}:${text}`)) return clips.get(`${order[0]}:${text}`);
  // A voice that is resting (its limit is used up...) is skipped; if all of them rest, try them anyway.
  let queue = order.filter((who) => !isResting(`tts:${who}`));
  if (!queue.length) queue = order;
  let failure;
  for (let i = 0; i < queue.length; i++) {
    const who = queue[i];
    try {
      return await speakWith(who);
    } catch (error) {
      failure = error;
      const next = queue[i + 1];
      const tell = rest(`tts:${who}`, error);
      if (!next) break;
      log.warn(`صوت ${PROVIDER_NAMES[who]} ما اشتغل — بكمل بصوت ${PROVIDER_NAMES[next]}: ${shortError(error)}`);
      if (tell) onNotice?.(voiceNotice(who, next, error));
    }
  }
  throw failure;
}

function voiceNotice(provider, fallback, error) {
  const from = PROVIDER_NAMES[provider];
  const to = PROVIDER_NAMES[fallback];
  if (error?.status === 429) return `⏳ خلص حد ${from} المجاني للصوت — بكمل بصوت ${to} لين يتجدد.`;
  return `⚠️ صوت ${from} ما اشتغل (\`${shortError(error)}\`) — بكمل بصوت ${to}.`;
}

/**
 * Speak text of any length with one service (long text is said in pieces and joined),
 * and make quiet voices louder.
 */
async function speakAll(provider, text) {
  const limit = CHUNK_LIMITS[provider] ?? 400;
  let clip;
  if (text.length <= limit) {
    clip = await speakOnce(provider, text);
  } else {
    const parts = [];
    for (const piece of splitForSpeech(text, limit)) parts.push(await speakOnce(provider, piece));
    clip = joinClips(parts);
    if (!clip) {
      log.warn('ما قدرت أجمع أجزاء الصوت — بشغل أول جزء بس.');
      clip = parts[0];
    }
  }
  return config.tts.louder ? louder(clip) : clip;
}

function speakOnce(provider, text) {
  const english = mostlyLatin(text);
  switch (provider) {
    case 'gemini':
      return geminiSpeech(text, english);
    case 'groq':
      return groqSpeech(text, english);
    case 'azure':
      return azureSpeech(text, english);
    case 'elevenlabs':
      return elevenLabsSpeech(text);
    default:
      throw new Error(`Unknown TTS provider "${provider}"`);
  }
}

// ---------- Gemini ----------
// The voice: GEMINI_VOICE=auto designs a young Emirati woman's voice once (Gemini keeps it
// for a year) and reuses it. If that isn't possible, a ready voice is used with an
// Emirati-accent style instead.
const READY_VOICE = 'Leda'; // youthful female voice
const ACCENT_STYLE = 'warm, friendly young Emirati woman with a natural UAE accent';
const DESIGN_NAME = 'emirati-girl-v1';
const OLD_TTS_MODELS = /^gemini-(?:2\.|3\.1-)/; // these use the 2025 request format
let oldRequestFormat = false;
let designedVoice; // Promise<string | null>

async function geminiSpeech(text, english) {
  const g = config.tts.gemini;
  for (let attempt = 0; attempt < 3; attempt++) {
    const voice = await geminiVoice();
    const style = g.style || (voice.designed || english ? '' : ACCENT_STYLE);
    const old = oldRequestFormat || OLD_TTS_MODELS.test(g.model);
    const res = await apiRequest(`${GEMINI_API}/models/${encodeURIComponent(g.model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': g.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(old ? oldSpeechBody(text, voice, style) : speechBody(text, voice, style)),
    });
    if (res.ok) return geminiAudio(await res.json());

    const error = await apiError(res, 'TTS (Gemini)');
    if (res.status === 400 && voice.designed && /voice/i.test(error.body)) {
      log.warn(`الصوت الإماراتي المصمم ما اشتغل — بستخدم صوت ${READY_VOICE}: ${shortError(error)}`);
      designedVoice = Promise.resolve(null);
      continue;
    }
    if (res.status === 400 && !old && /unknown name|invalid json|cannot find field|speech_?metadata/i.test(error.body)) {
      log.warn('Gemini طلب صيغة الطلب القديمة للصوت — بستخدمها.');
      oldRequestFormat = true;
      continue;
    }
    throw error;
  }
  throw new Error('TTS (Gemini): ما اشتغل');
}

function speechBody(text, voice, style) {
  const part = { text };
  if (style) part.speech_metadata = { style };
  return {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice: voice.id } } },
  };
}

function oldSpeechBody(text, voice, style) {
  return {
    contents: [{ role: 'user', parts: [{ text: style ? `Read aloud as a ${style}:\n${text}` : text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.designed ? READY_VOICE : voice.id } } },
    },
  };
}

let streamOffUntil = 0;

/**
 * Speak with Gemini as a live stream: resolves as soon as the FIRST piece of audio arrives
 * (the rest keeps coming in `chunks`, 24 kHz mono 16-bit PCM). Returns null when streaming
 * isn't available (so the normal, whole-clip path is used instead).
 */
export async function openSpeechStream(text, { onNotice } = {}) {
  const g = config.tts.gemini;
  if (!config.tts.stream || config.tts.provider !== 'gemini' || !g.apiKey) return null;
  if (Date.now() < streamOffUntil || isResting('tts:gemini')) return null;
  if (text.length <= CACHE_TEXT_MAX && clips.has(`gemini:${text}`)) return null; // already saved: instant
  const abort = new AbortController();
  try {
    const voice = await geminiVoice();
    const style = g.style || (voice.designed || mostlyLatin(text) ? '' : ACCENT_STYLE);
    const old = oldRequestFormat || OLD_TTS_MODELS.test(g.model);
    const res = await apiRequest(
      `${GEMINI_API}/models/${encodeURIComponent(g.model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': g.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(old ? oldSpeechBody(text, voice, style) : speechBody(text, voice, style)),
        signal: abort.signal,
      },
      20_000,
    );
    if (!res.ok || !res.body) throw await apiError(res, 'TTS (Gemini stream)');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextPiece = async () => {
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) {
          const { done, value } = await reader.read();
          if (done) {
            if (!buffer.trim()) return null;
            buffer += '\n';
          } else buffer += decoder.decode(value, { stream: true });
          continue;
        }
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        let data;
        try {
          data = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        for (const part of data?.candidates?.[0]?.content?.parts ?? []) {
          const inline = part.inlineData ?? part.inline_data;
          if (!inline?.data) continue;
          let pcm = Buffer.from(inline.data, 'base64');
          let rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? inline.mime_type ?? '')?.[1]) || 24000;
          if (pcm.toString('ascii', 0, 4) === 'RIFF') {
            const wav = readWav(pcm);
            if (!wav || wav.channels !== 1) throw new Error('TTS (Gemini stream): صيغة صوت مب مدعومة');
            ({ pcm, rate } = wav);
          }
          return { pcm, rate };
        }
      }
    };
    const first = await nextPiece();
    if (!first) throw new Error('TTS (Gemini stream): ما رجع صوت');
    if (first.rate !== 24000) throw new Error(`TTS (Gemini stream): معدل الصوت ${first.rate} مب مدعوم`);
    async function* chunks() {
      const all = [first.pcm];
      let finished = false;
      try {
        yield first.pcm;
        for (let piece = await nextPiece(); piece; piece = await nextPiece()) {
          all.push(piece.pcm);
          yield piece.pcm;
        }
        finished = true;
      } catch (error) {
        if (!abort.signal.aborted) log.warn(`بث صوت Gemini انقطع: ${shortError(error)}`);
      } finally {
        abort.abort();
        // Short phrases ("ها حياتي") are saved so next time they play at once.
        if (finished && text.length <= CACHE_TEXT_MAX) {
          remember(`gemini:${text}`, config.tts.louder ? louder(pcmToWav(Buffer.concat(all), 24000, 1)) : pcmToWav(Buffer.concat(all), 24000, 1));
        }
      }
    }
    return { chunks: chunks(), cancel: () => abort.abort() };
  } catch (error) {
    abort.abort();
    // A limited Gemini: rest it, tell the room, and let the backup voice speak (normal path).
    // Anything else means streaming doesn't work here, so don't try it again for a while.
    if (error?.status === 429) {
      const next = config.tts.fallbacks.find((who) => !isResting(`tts:${who}`)) ?? config.tts.fallbacks[0];
      if (next && rest('tts:gemini', error)) onNotice?.(voiceNotice('gemini', next, error));
    } else {
      streamOffUntil = Date.now() + 10 * 60_000;
      log.warn(`بث الصوت من Gemini ما اشتغل — بستخدم الطريقة العادية: ${shortError(error)}`);
    }
    return null;
  }
}

/** Gemini answers with base64 audio: a WAV file, or raw 16-bit PCM that needs a WAV header. */
function geminiAudio(data) {
  const candidate = data?.candidates?.[0];
  const part = (candidate?.content?.parts ?? []).find((p) => (p.inlineData ?? p.inline_data)?.data);
  const inline = part && (part.inlineData ?? part.inline_data);
  if (!inline) {
    const reason = candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? 'no audio';
    const error = new Error(`TTS (Gemini): ما رجع صوت (${reason})`);
    error.status = 502;
    throw error;
  }
  const audio = Buffer.from(inline.data, 'base64');
  if (audio.toString('ascii', 0, 4) === 'RIFF') return audio;
  const mime = inline.mimeType ?? inline.mime_type ?? '';
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1]) || 24000;
  return pcmToWav(audio, rate, 1);
}

/** { id, designed }: the voice to speak with. */
async function geminiVoice() {
  const { voice, model } = config.tts.gemini;
  if (voice.toLowerCase() !== 'auto') return { id: voice, designed: voice.startsWith('voice_') };
  if (OLD_TTS_MODELS.test(model)) return { id: READY_VOICE, designed: false };
  designedVoice ??= designEmiratiVoice().catch((error) => {
    log.warn(`ما قدرت أصمم الصوت الإماراتي — بستخدم صوت ${READY_VOICE}: ${shortError(error)}`);
    // Try again in an hour (the problem may be temporary).
    setTimeout(() => {
      designedVoice = undefined;
    }, 60 * 60_000).unref?.();
    return null;
  });
  const id = await designedVoice;
  return id ? { id, designed: true } : { id: READY_VOICE, designed: false };
}

const voiceIdOf = (voice) =>
  voice?.id ?? (typeof voice?.name === 'string' ? voice.name.replace(/^voices\//, '') : undefined);

/** Find the Emirati voice made on an earlier start, or design it now (once). */
async function designEmiratiVoice() {
  const g = config.tts.gemini;
  const headers = { 'x-goog-api-key': g.apiKey, 'Content-Type': 'application/json' };

  const listed = await apiRequest(`${GEMINI_API}/voices?type=prompted&page_size=200`, { headers });
  if (!listed.ok) throw await apiError(listed, 'Voices');
  const found = ((await listed.json())?.voices ?? []).find(
    (v) => (v.display_name ?? v.displayName) === DESIGN_NAME && voiceIdOf(v),
  );
  if (found) {
    log.info(`🎙️ صوت ${config.botName} الإماراتي جاهز (${voiceIdOf(found)}).`);
    return voiceIdOf(found);
  }

  const create = (extra) =>
    apiRequest(`${GEMINI_API}/voices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        store: true,
        voice: { type: 'prompted', display_name: DESIGN_NAME, gender: 'female', ...extra, prompted: { input: g.voiceDesign } },
      }),
    });
  let res = await create({ language_code: 'ar' });
  if (res.status === 400) res = await create({}); // in case "ar" isn't accepted as a language code
  if (!res.ok) throw await apiError(res, 'Voice design');
  const made = await res.json();
  const id = voiceIdOf(made) ?? voiceIdOf(made?.voice);
  if (!id) throw new Error('Voice design: ما رجع آيدي للصوت');
  log.info(`🎙️ صممت صوت إماراتي لـ Gemini (${id}) — ينحفظ في مشروعك وينعاد استخدامه.`);
  return id;
}

// ---------- Groq (Canopy Labs Orpheus): Saudi-dialect Arabic voices + English voices ----------
function groqSpeech(text, english) {
  const g = config.tts.groq;
  return fetchAudio('https://api.groq.com/openai/v1/audio/speech', {
    headers: { Authorization: `Bearer ${g.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: english ? g.modelEn : g.modelAr,
      voice: english ? g.voiceEn : g.voiceAr,
      input: text,
      response_format: 'wav',
    }),
  });
}

// ---------- Azure AI Speech: Emirati voices (ar-AE-FatimaNeural / ar-AE-HamdanNeural) ----------
function azureSpeech(text, english) {
  const a = config.tts.azure;
  const voice = english ? a.voiceEn : a.voiceAr;
  const lang = voice.split('-').slice(0, 2).join('-');
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
  return fetchAudio(`https://${a.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    headers: {
      'Ocp-Apim-Subscription-Key': a.apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
      'User-Agent': 'discord-voice-ai-bot',
    },
    body: ssml,
  });
}

// ---------- ElevenLabs: very natural multilingual voices (pick an Arabic voice ID) ----------
function elevenLabsSpeech(text) {
  const e = config.tts.elevenlabs;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(e.voiceId)}?output_format=mp3_44100_128`;
  return fetchAudio(url, {
    headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: e.model }),
  });
}

async function fetchAudio(url, { headers, body }) {
  const res = await apiRequest(url, { method: 'POST', headers, body });
  if (!res.ok) throw await apiError(res, 'TTS');
  return Buffer.from(await res.arrayBuffer());
}

function escapeXml(value) {
  return String(value).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}
