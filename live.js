// Gemini Live: she thinks and talks in ONE fast stream. The question goes in as text and her voice comes
// straight back while it is being made (no separate "brain, then voice" steps), so she starts talking sooner.
// The free Live tier has no daily request limit, so her voice doesn't run out like the voice (TTS) models do.
// If Live can't answer, the usual way (brain + voice) answers instead.
import { config, log } from './config.js';
import { GEMINI_API, apiRequest, geminiVoiceChoice, isResting, rest } from './speech.js';

const WS_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const SETUP_TIMEOUT_MS = 8_000;

const apiKey = () => config.tts.gemini.apiKey;

/** Live answers the voice room now (turned on, a Gemini key, and not resting after a failure). */
export const liveOn = () => Boolean(config.live.enabled && apiKey() && !isResting('live'));

/** Live failed: the usual way answers for a while. */
export function restLive(error) {
  const why = `${error?.message ?? ''} ${error?.reason ?? ''}`;
  // "You exceeded your current quota … plan and billing": this key gets no Live (free tier) — trying again soon only
  // makes answers slower, so leave it for 12 hours (it starts by itself if Google allows it later, or with billing).
  if (/quota|billing|exhausted/i.test(why)) {
    if (rest('live', { status: 429, message: why }, 12 * 60 * 60_000)) {
      log.warn('Gemini Live ما يشتغل بهالمفتاح المجاني (Google يقول خلص الحد) — بجربه بعد 12 ساعة. بالطريقة العادية لين ذاك.');
    }
    return;
  }
  rest('live', { status: error?.status ?? 503, message: why });
}

// ---------- which Live model ----------
let liveModels; // Promise<string[]>: the configured model first, then the Live models this key can use (newest first)

const version = (name) => Number(/(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);

function modelsToTry() {
  liveModels ??= (async () => {
    const list = [config.live.model];
    try {
      const res = await apiRequest(`${GEMINI_API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey() } }, 10_000);
      if (res.ok) {
        const found = ((await res.json())?.models ?? [])
          .filter((m) => (m.supportedGenerationMethods ?? m.supported_generation_methods ?? []).includes('bidiGenerateContent'))
          .map((m) => String(m.name ?? '').replace(/^models\//, ''))
          .filter((name) => /live|native-audio/i.test(name) && !/translate|transcribe/i.test(name))
          .sort((a, b) => version(b) - version(a));
        for (const name of found) if (!list.includes(name)) list.push(name);
      }
    } catch {
      // the list is only a backup: the configured model is tried anyway
    }
    return list;
  })();
  return liveModels;
}

// The ways to start a session, best first: her designed voice + Google Search, a ready voice, then the plain default.
const VARIANTS = [
  { voice: 'designed', tools: true },
  { voice: 'ready', tools: true },
  { voice: 'ready', tools: false },
  { voice: 'none', tools: false },
];

function parse(data) {
  try {
    return JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

// ---------- one answer ----------
class LiveTurn {
  constructor(firstAudioMs) {
    this.queue = [];
    this.waiters = [];
    this.ended = false;
    this.gotAudio = false;
    this.said = '';
    this.started = new Promise((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.started.catch(() => {});
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.timer = setTimeout(
      () => this.fail(new Error(`Live: ما بدا يتكلم خلال ${(firstAudioMs / 1000).toFixed(0)} ثواني`)),
      firstAudioMs,
    );
  }

  push(pcm) {
    if (this.ended || !pcm.length) return;
    if (!this.gotAudio) {
      this.gotAudio = true;
      clearTimeout(this.timer);
      this.resolveStart();
    }
    this.queue.push(pcm);
    this.wake();
  }

  wake() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** The answer is complete (or was cut short). */
  end() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    if (!this.gotAudio) this.rejectStart(new Error('Live: خلص بدون صوت'));
    this.wake();
    this.resolveDone(this.said.trim());
  }

  fail(error) {
    if (this.ended) return;
    if (!this.gotAudio) this.rejectStart(error);
    this.end();
  }

  /** Stop taking her voice for this answer (she was stopped). */
  cancel() {
    this.queue.length = 0;
    this.end();
  }

  /** Her voice as it arrives: 24 kHz 16-bit mono PCM pieces. */
  async *chunks() {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift();
        continue;
      }
      if (this.ended) return;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

// ---------- the session (one per voice room) ----------
export class LiveVoice {
  /** `instructions()` gives her persona and what she knows, read when a session starts. */
  constructor(instructions) {
    this.instructions = instructions;
    this.ws = null;
    this.openedAt = 0;
    this.leaving = false; // the server said it will close soon: the next question opens a new session
    this.handle = null; // resumes the same conversation in a new session
    this.chosen = null; // { model, variant } that worked
    this.turn = null;
    this.connecting = null;
  }

  usable() {
    return (
      this.ws?.readyState === 1 &&
      !this.leaving &&
      Date.now() - this.openedAt < config.live.maxSessionMinutes * 60_000
    );
  }

  /** Open the session ahead of the first question (so that question doesn't wait for it). */
  async warm() {
    if (this.usable()) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  /** Send a question ("الاسم: الكلام"); returns the answer as it comes (`started` fails if no voice comes). */
  async ask(text) {
    await this.warm();
    this.turn?.end(); // a new question cuts an unfinished answer short
    const turn = new LiveTurn(config.live.firstAudioMs);
    this.turn = turn;
    this.ws.send(JSON.stringify({ realtimeInput: { text } }));
    return turn;
  }

  async connect() {
    this.close();
    const tries = [];
    if (this.chosen) tries.push(this.chosen);
    for (const model of await modelsToTry()) {
      for (const variant of VARIANTS) {
        if (!tries.some((t) => t.model === model && t.variant === variant)) tries.push({ model, variant });
      }
    }
    let lastError;
    let badModel = '';
    for (const attempt of tries.slice(0, 10)) {
      if (attempt.model === badModel) continue;
      try {
        await this.open(attempt.model, attempt.variant);
        if (this.chosen?.model !== attempt.model || this.chosen?.variant !== attempt.variant) {
          log.info(`⚡ Gemini Live جاهز (${attempt.model}${attempt.variant.voice === 'designed' ? '، صوتها المصمم' : ''})`);
        }
        this.chosen = attempt;
        return;
      } catch (error) {
        lastError = error;
        if (this.handle) this.handle = null; // maybe the old conversation can't be resumed: start fresh
        if (/not found|not supported|unknown model|does not exist/i.test(`${error.message} ${error.reason ?? ''}`)) {
          badModel = attempt.model;
        }
        if (/quota|exhausted|rate limit|too many/i.test(`${error.message} ${error.reason ?? ''}`)) break;
      }
    }
    throw lastError ?? new Error('Live: ما قدرت أفتح جلسة');
  }

  async setupMessage(model, variant) {
    let speechConfig;
    if (variant.voice === 'designed') {
      const voice = await geminiVoiceChoice();
      if (!voice?.designed) throw new Error('Live: ما في صوت مصمم');
      speechConfig = { voiceConfig: { voice: voice.id } };
    } else if (variant.voice === 'ready') {
      speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.live.voice } } };
    }
    return {
      setup: {
        model: `models/${model}`,
        generationConfig: { responseModalities: ['AUDIO'], ...(speechConfig ? { speechConfig } : {}) },
        systemInstruction: { parts: [{ text: this.instructions() }] },
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: this.handle ? { handle: this.handle } : {},
        ...(variant.tools && config.live.search ? { tools: [{ googleSearch: {} }] } : {}),
      },
    };
  }

  open(model, variant) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws?.close();
        } catch {
          // already closed
        }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Live: ما رد على بداية الجلسة')), SETUP_TIMEOUT_MS);
      this.setupMessage(model, variant)
        .then((setup) => {
          if (settled) return;
          ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(apiKey())}`);
          ws.binaryType = 'arraybuffer';
          ws.addEventListener('open', () => ws.send(JSON.stringify(setup)));
          ws.addEventListener('message', (event) => {
            const msg = parse(event.data);
            if (!msg) return;
            if (!settled && msg.setupComplete) {
              settled = true;
              clearTimeout(timer);
              this.ws = ws;
              this.openedAt = Date.now();
              this.leaving = false;
              resolve();
              return;
            }
            if (settled && ws === this.ws) this.onMessage(msg);
          });
          ws.addEventListener('close', (event) => {
            if (!settled) {
              const error = new Error(`Live ${event.code}: ${event.reason || 'انقفلت الجلسة'}`);
              error.reason = event.reason;
              fail(error);
            } else if (ws === this.ws) {
              this.ws = null;
              this.turn?.fail(
                Object.assign(new Error(`Live: انقطعت الجلسة (${event.code}${event.reason ? `: ${event.reason}` : ''})`), {
                  reason: event.reason,
                }),
              );
            }
          });
          ws.addEventListener('error', () => {}); // a close event always follows
        })
        .catch(fail);
    });
  }

  onMessage(msg) {
    const update = msg.sessionResumptionUpdate;
    if (update?.resumable !== false && update?.newHandle) this.handle = update.newHandle;
    if (msg.goAway) this.leaving = true; // finish this answer; the next question opens a fresh session
    const content = msg.serverContent;
    const turn = this.turn;
    if (!content || !turn) return;
    for (const part of content.modelTurn?.parts ?? []) {
      const inline = part.inlineData ?? part.inline_data;
      if (!inline?.data) continue;
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? inline.mime_type ?? '')?.[1]) || 24000;
      if (rate !== 24000) {
        turn.fail(new Error(`Live: معدل الصوت ${rate} مب مدعوم`));
        return;
      }
      turn.push(Buffer.from(inline.data, 'base64'));
    }
    if (content.outputTranscription?.text) turn.said += content.outputTranscription.text;
    if (content.turnComplete || content.interrupted) turn.end();
  }

  /** Stop the answer she is giving now (her voice for it is dropped). */
  cancel() {
    this.turn?.cancel();
  }

  close() {
    this.turn?.end();
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // already closed
    }
  }
}

