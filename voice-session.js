// One VoiceSession = the bot sitting in one voice channel:
// it listens to each person, turns speech into text, asks the AI, and speaks the reply.
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { escapeMarkdown } from 'discord.js';
import OpusScript from 'opusscript';
import { config, log } from './config.js';
import { askAI } from './llm.js';
import { activeVoice, openSpeechStream, synthesize, transcribe, ttsChunkLimit } from './speech.js';
import {
  DISCORD_CHANNELS,
  DISCORD_RATE,
  cleanForSpeech,
  containsWakeWord,
  createUpsampler,
  isOnlyWakeWord,
  isStopCommand,
  liveAudioStream,
  looksLikeNoise,
  pcmDurationMs,
  pcmToWav,
  rms,
  splitForFastStart,
  stereo48kToMono16k,
  wavToDiscordPcm,
} from './helpers.js';

// What the bot says when someone only calls its name (ACK_REPLIES, "ها حياتي" by default).
const ACKS = config.ackReplies.length ? config.ackReplies : ['هلا'];

// Reply mode per server: 'name' (only when called) or 'everyone'.
const modes = new Map();
export const getMode = (guildId) => modes.get(guildId) ?? config.replyMode;
export const setMode = (guildId, mode) => modes.set(guildId, mode);

function createOpusDecoder() {
  const decoder = new OpusScript(DISCORD_RATE, DISCORD_CHANNELS, OpusScript.Application?.AUDIO ?? 2049);
  return {
    // A damaged packet is skipped instead of ending the whole recording.
    decode(packet) {
      try {
        return Buffer.from(decoder.decode(packet));
      } catch {
        return null;
      }
    },
    free() {
      try {
        decoder.delete();
      } catch {
        // already freed
      }
    },
  };
}

export class VoiceSession {
  constructor(channel, { onEnd } = {}) {
    this.channel = channel;
    this.guild = channel.guild;
    this.onEnd = onEnd;
    this.connection = null;
    this.player = createAudioPlayer();
    this.player.on('error', (err) => log.error('مشغل الصوت:', err.message));
    this.generation = 0; // goes up on "stop" to cancel answers in progress
    this.queue = Promise.resolve();
    this.pending = 0;
    this.listening = new Set(); // users being recorded right now
    this.lastAnswer = new Map(); // userId -> when the bot last answered them
    this.lastErrorAt = new Map();
    this.debugLines = [];
    this.connected = false;
    this.leftOnPurpose = false;
    this.destroyed = false;
  }

  async connect() {
    const connection = joinVoiceChannel({
      channelId: this.channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false, // the bot has to hear the room
      selfMute: false,
      debug: true,
    });
    this.connection = connection;

    connection.on('debug', (line) => {
      this.debugLines.push(line);
      if (this.debugLines.length > 20) this.debugLines.shift();
      log.debug('[voice]', line);
    });
    connection.on('stateChange', (before, after) => log.debug(`voice: ${before.status} → ${after.status}`));
    connection.on('error', (err) => log.error('اتصال الصوت:', err.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Being moved to another channel looks like a short disconnect.
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
    connection.on(VoiceConnectionStatus.Destroyed, () => this.destroy());

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      const error = new Error('VOICE_CONNECT_TIMEOUT');
      error.details = this.debugLines.slice(-6).join('\n');
      this.destroy();
      throw error;
    }

    this.connected = true;
    connection.subscribe(this.player);
    connection.receiver.speaking.on('start', (userId) => this.listen(userId));
  }

  /** Record one person until they pause, then handle what they said. */
  listen(userId) {
    if (this.destroyed || !this.connected || this.listening.has(userId)) return;
    if (userId === this.guild.members.me?.id) return;
    const receiver = this.connection.receiver;
    if (receiver.subscriptions.has(userId)) return;

    this.listening.add(userId);
    const startedWhileTalking = this.isTalking();
    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs },
    });
    const decoder = createOpusDecoder();
    const maxBytes = config.maxSpeechSeconds * DISCORD_RATE * DISCORD_CHANNELS * 2;
    const chunks = [];
    let bytes = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      this.listening.delete(userId);
      decoder.free();
      if (!stream.destroyed) stream.destroy();
      const pcm = Buffer.concat(chunks);
      this.onUtterance(userId, pcm, startedWhileTalking).catch((err) =>
        log.error('معالجة الكلام:', err?.message ?? err),
      );
    };

    stream.on('data', (packet) => {
      if (done) return;
      const pcm = decoder.decode(packet);
      if (pcm) {
        chunks.push(pcm);
        bytes += pcm.length;
      }
      if (bytes >= maxBytes) finish();
    });
    stream.once('end', finish);
    stream.once('close', finish);
    stream.on('error', (err) => {
      log.debug('receive stream:', err.message);
      finish();
    });
  }

  async onUtterance(userId, pcm, startedWhileTalking) {
    if (this.destroyed) return;
    if (pcmDurationMs(pcm.length) < config.minSpeechMs) return;
    const level = rms(pcm);
    if (level < config.minVolume) {
      log.debug(`صوت واطي جداً (${Math.round(level)}) — تجاهلته`);
      return;
    }

    const member =
      this.guild.members.cache.get(userId) ?? (await this.guild.members.fetch(userId).catch(() => null));
    if (!member || member.user.bot) return;

    let text;
    try {
      text = await transcribe(pcmToWav(stereo48kToMono16k(pcm), 16000, 1));
    } catch (err) {
      this.reportError('stt', 'تحويل الصوت لنص', err);
      return;
    }
    if (!text || looksLikeNoise(text) || this.destroyed) return;
    log.info(`🗣️  ${member.displayName}: ${text}`);

    if (isStopCommand(text, config.stopWords, config.wakeWords)) {
      if (this.isBusy()) {
        this.stop();
        log.info('⏹️  سكتت');
      }
      return;
    }

    const called = containsWakeWord(text, config.wakeWords);
    const followUp =
      this.smallRoom() && Date.now() - (this.lastAnswer.get(userId) ?? 0) < config.followUpSeconds * 1000;
    // While the bot talks, only react when called by name (avoids echo and cross-talk).
    if (startedWhileTalking && !called) return;
    if (getMode(this.guild.id) === 'name' && !called && !followUp) return;

    if (isOnlyWakeWord(text, config.wakeWords)) {
      this.enqueue(async (gen) => {
        await this.speak(ACKS[Math.floor(Math.random() * ACKS.length)], gen);
        this.lastAnswer.set(userId, Date.now());
      });
      return;
    }
    this.enqueue((gen) => this.answer(member, text, gen));
  }

  async answer(member, text, gen) {
    let reply;
    try {
      reply = await askAI({
        guildId: this.guild.id,
        speaker: member.displayName,
        speakerId: member.id,
        room: this.humans(),
        text,
        vars: { SERVER_NAME: this.guild.name, CHANNEL_NAME: this.channel.name },
        onNotice: (notice) => this.say(notice),
      });
    } catch (err) {
      this.reportError('llm', 'الذكاء الاصطناعي', err);
      return;
    }
    if (!reply || gen !== this.generation || this.destroyed) return;
    log.info(`🤖 ${config.botName}: ${reply}`);
    // The written answer shows up when she starts talking (or right away if the voice fails).
    const transcript = `🗣️ **${escapeMarkdown(member.displayName)}:** ${text}\n🤖 **${escapeMarkdown(config.botName)}:** ${reply}`;
    await this.speak(reply, gen, () => {
      if (config.postTranscripts) this.say(transcript);
    });
    this.lastAnswer.set(member.id, Date.now());
  }

  /**
   * Turn text into speech and play it, piece by piece (the next piece is prepared while one plays).
   * `onStart` runs once: when the voice starts, or when it can't.
   */
  async speak(text, gen = this.generation, onStart) {
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      onStart?.();
    };
    const begun = Date.now();
    const pieces = splitForFastStart(cleanForSpeech(text), 130, ttsChunkLimit()).slice(0, 15);
    const clips = [];
    const prepare = (i) => {
      if (i >= pieces.length || clips[i]) return;
      clips[i] = synthesize(pieces[i], { onNotice: (notice) => this.say(notice) }).catch((err) => {
        start();
        this.reportError('tts', 'تحويل النص لصوت', err);
        return null;
      });
    };
    try {
      // Gemini voice: start talking as soon as the first bit of audio arrives (no waiting for the whole clip).
      const opening = pieces.length ? openSpeechStream(pieces[0], { onNotice: (notice) => this.say(notice) }).catch(() => null) : null;
      if (!opening) prepare(0);
      prepare(1);
      const live = opening ? await opening : null;
      let first = 0;
      if (live) {
        first = 1;
        if (gen !== this.generation || this.destroyed) return live.cancel();
        log.info(`🔊 الصوت بدا بعد ${((Date.now() - begun) / 1000).toFixed(1)} ثانية (${activeVoice()}، بث مباشر)`);
        start();
        const up = createUpsampler(config.tts.louder ? 'auto' : 1);
        const pcm = (async function* () {
          for await (const piece of live.chunks) yield up(piece);
        })();
        await this.playResource(() =>
          createAudioResource(liveAudioStream(pcm, live.cancel), { inputType: StreamType.Raw }),
        );
        live.cancel();
      } else if (opening) prepare(0);
      for (let i = first; i < pieces.length; i++) {
        prepare(i + 2);
        const clip = await clips[i];
        if (!clip || gen !== this.generation || this.destroyed) return;
        if (i === 0 && !live) log.info(`🔊 الصوت جهز بعد ${((Date.now() - begun) / 1000).toFixed(1)} ثانية (${activeVoice()})`);
        start();
        await this.play(clip);
      }
    } finally {
      start();
    }
  }

  /**
   * Play one audio clip and wait until it finishes. WAV goes to Discord as raw PCM
   * (no ffmpeg, so it starts sooner); MP3 goes through ffmpeg.
   */
  play(clip) {
    return this.playResource(() => {
      const pcm = wavToDiscordPcm(clip);
      return pcm
        ? createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw })
        : createAudioResource(Readable.from([clip]), { inputType: StreamType.Arbitrary });
    });
  }

  /** Play an audio resource (made by `makeResource`) and wait until it finishes. */
  playResource(makeResource) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.player.off(AudioPlayerStatus.Idle, finish);
        this.player.off('error', finish);
        resolve();
      };
      const timer = setTimeout(finish, 120_000);
      this.player.on(AudioPlayerStatus.Idle, finish);
      this.player.on('error', finish);
      try {
        this.player.play(makeResource());
      } catch (err) {
        log.error('تشغيل الصوت:', err.message);
        finish();
      }
    });
  }

  /** Run tasks one after another so replies never talk over each other. */
  enqueue(task) {
    const gen = this.generation;
    this.pending++;
    this.queue = this.queue
      .then(() => (gen === this.generation && !this.destroyed ? task(gen) : undefined))
      .catch((err) => log.error('مهمة:', err?.message ?? err))
      .finally(() => {
        this.pending--;
      });
  }

  /**
   * In a busy room people chat with each other, so carrying on without the name
   * would make the bot answer everything (and use up the free limits).
   */
  smallRoom() {
    const people = this.channel.members?.filter?.((member) => !member.user?.bot).size;
    return people === undefined || people <= config.followUpMaxPeople;
  }

  isTalking() {
    const status = this.player.state.status;
    return status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
  }

  isBusy() {
    return this.isTalking() || this.pending > 0;
  }

  /** Stop talking now and drop answers that are still waiting. */
  stop() {
    this.generation++;
    this.player.stop(true);
  }

  announce() {
    const how =
      getMode(this.guild.id) === 'name'
        ? `نادوني باسمي (**${escapeMarkdown(config.botName)}**) وأرد عليكم بصوت.`
        : 'أرد على أي كلام في الروم.';
    this.say(`🎙️ دشيت الروم وأسمعكم — ${how}\n-# الصوت يتحول لنص عشان أفهمكم، وما ينحفظ.`);
  }

  /** The people in the voice room right now: [{ id, name }]. */
  humans() {
    try {
      const people = this.channel.members?.filter?.((m) => !m.user?.bot);
      return people?.map ? people.map((m) => ({ id: m.id, name: m.displayName })) : [];
    } catch {
      return [];
    }
  }

  /** Post in the voice channel's text chat (or only write it to the logs, when CHAT_MESSAGES is off). */
  say(content) {
    if (!config.chatMessages) {
      log.info(`💬 ${content.replace(/\s*\n\s*/g, ' · ').slice(0, 300)}`);
      return;
    }
    this.channel
      .send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } })
      .catch((err) => log.debug('رسالة نصية:', err.message));
  }

  /** Log an error and show it in the chat (once a minute per kind; limits every 10 minutes). */
  reportError(kind, label, err) {
    const message = String(err?.message ?? err).replace(/`/g, "'");
    log.error(`${label}:`, message);
    const quietFor = err?.status === 429 ? 10 * 60_000 : 60_000;
    if (Date.now() - (this.lastErrorAt.get(kind) ?? 0) < quietFor) return;
    this.lastErrorAt.set(kind, Date.now());
    if (err?.status === 429) {
      const service = /gemini/i.test(message) ? 'Gemini' : 'Groq';
      this.say(`⏳ وصلنا حد ${service} المجاني في ${label} — جربوا بعد شوي، ولو خلص حد اليوم يرجع بكرة.`);
      return;
    }
    this.say(`⚠️ صار خطأ في ${label}: \`${message.slice(0, 200)}\``);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    try {
      this.player.stop(true);
    } catch {
      // ignore
    }
    try {
      if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
        this.connection.destroy();
      }
    } catch {
      // ignore
    }
    this.onEnd?.(this);
  }
}
