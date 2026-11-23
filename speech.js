// Speech services:
// - transcribe(): speech → text (Groq Whisper by default, or OpenAI)
// - synthesize(): text → speech (Groq, Azure or ElevenLabs), returns WAV/MP3 bytes
import { config } from './config.js';
import { mostlyLatin } from './helpers.js';

// ---------- Speech to text ----------
function buildForm(audio, file, withHints) {
  const { model } = config.stt;
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

async function post(form) {
  return fetch(config.stt.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * Sends audio (a WAV buffer by default) and returns the transcript
 * ('' if nothing was understood).
 */
export async function transcribe(audio, file = { name: 'speech.wav', type: 'audio/wav' }) {
  let res = await post(buildForm(audio, file, true));
  // If the service rejects an optional hint, try once more without hints.
  if (res.status === 400) res = await post(buildForm(audio, file, false));
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`STT ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return String(data?.text ?? '').trim();
}

// ---------- Text to speech ----------
/** Longest piece of text sent in one request (Groq's Arabic voice allows 200). */
export function ttsChunkLimit() {
  return config.tts.provider === 'groq' ? 190 : 400;
}

export async function synthesize(text) {
  const english = mostlyLatin(text);
  switch (config.tts.provider) {
    case 'groq':
      return groqSpeech(text, english);
    case 'azure':
      return azureSpeech(text, english);
    case 'elevenlabs':
      return elevenLabsSpeech(text);
    default:
      throw new Error(`Unknown TTS_PROVIDER "${config.tts.provider}"`);
  }
}

// Groq (Canopy Labs Orpheus): Saudi-dialect Arabic voices + English voices.
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

// Azure AI Speech: Emirati voices (ar-AE-HamdanNeural / ar-AE-FatimaNeural).
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
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'discord-voice-ai-bot',
    },
    body: ssml,
  });
}

// ElevenLabs: very natural multilingual voices (pick an Arabic voice ID).
function elevenLabsSpeech(text) {
  const e = config.tts.elevenlabs;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(e.voiceId)}?output_format=mp3_44100_128`;
  return fetchAudio(url, {
    headers: { 'xi-api-key': e.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: e.model }),
  });
}

async function fetchAudio(url, { headers, body }) {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`TTS ${res.status}: ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function escapeXml(value) {
  return String(value).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}
