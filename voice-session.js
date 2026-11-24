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
import { ChannelType, PermissionFlagsBits, escapeMarkdown } from 'discord.js';
import OpusScript from 'opusscript';
import { config, log } from './config.js';
import { askAI, pickOption } from './llm.js';
import { recordVoice } from './people.js';
import { activeVoice, isResting, openSpeechStream, synthesize, transcribe, ttsChunkLimit } from './speech.js';
import {
  DISCORD_CHANNELS,
  DISCORD_RATE,
  cleanForSpeech,
  containsWakeWord,
  createUpsampler,
  findVoiceChannel,
  isOnlyWakeWord,
  isRepetitionLoop,
  isSalam,
  isStopCommand,
  isStopForHer,
  hasStrongStop,
  isClearQuestion,
  tightenLive,
  joinNames,
  liveAudioStream,
  looksLikeNoise,
  parseMoveCommand,
  pcmDurationMs,
  pcmToWav,
  rms,
  speakableName,
  splitForFastStart,
  stereo48kToMono16k,
  wavToDiscordPcm,
} from './helpers.js';

/** What the bot needs in a voice room: see it, join it and talk in it. */
export const VOICE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const MOVING = ['تمام، رايحة {room}', 'أبشر، الحين أروح {room}', 'زين، ثواني وأكون في {room}'];
const NOT_FOUND = ['ما لقيت روم بهذا الاسم، عيدها لي', 'أي روم؟ ما عرفته، قول لي اسمه مرة ثانية'];
const SORRY = ['ما قدرت أجاوبك الحين، عيدها بعد شوي', 'تعبت شوي، عيد علي بعد لحظة'];
const SAME_ROOM = ['أنا موجودة في نفس الروم!', 'أنا هنا في نفس الروم يالغالي'];
const NO_ACCESS = ['ما أقدر أدخل ذاك الروم، ما عندي صلاحية'];
// "السلام عليكم" gets one of these straight away, without the AI (short and fixed, so the voice is kept ready after the first time).
const SALAM_REPLIES = ['وعليكم السلام ورحمة الله وبركاته', 'وعليكم السلام، هلا والله', 'هلا والله، وعليكم السلام'];

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
  constructor(channel, { onEnd, moveTo } = {}) {
    this.channel = channel;
    this.guild = channel.guild;
    this.onEnd = onEnd;
    this.moveTo = moveTo; // async (channel, backChannel): leave this room and join another one
    this.welcomed = new Map(); // userId -> when she last said hello to them
    this.welcomeNames = new Map(); // userId -> name, waiting for the hello
    this.welcomeTimer = null;
    this.currentSpeaker = null; // the person she is talking to right now (only they can stop her in a busy room)
    this.lastSorryAt = 0;
    this.connection = null;
    this.player = createAudioPlayer();
    this.player.on('error', (err) => log.error('مشغل الصوت:', err.message));
    this.generation = 0; // goes up on "stop" to cancel answers in progress
    this.queue = Promise.resolve();
    this.pending = 0;
    this.listening = new Set(); // users being recorded right now
    this.lastAnswer = new Map(); // userId -> when the bot last answered them
    this.salamAnswered = new Map(); // userId -> when she last answered their "السلام عليكم"
    this.lastSalamAt = 0;
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
    let interrupted = false; // this person talked over her, so she stopped
    let nextBargeCheckMs = config.bargeInMs;

    const finish = () => {
      if (done) return;
      done = true;
      this.listening.delete(userId);
      decoder.free();
      if (!stream.destroyed) stream.destroy();
      const pcm = Buffer.concat(chunks);
      this.onUtterance(userId, pcm, startedWhileTalking && !interrupted).catch((err) =>
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
      else if (pcm && startedWhileTalking && !interrupted && pcmDurationMs(bytes) >= nextBargeCheckMs) {
        // They began talking while she was talking and keep going: she stops and listens
        // (a cough or a click is too short to count).
        if (this.isTalking() && this.canBargeIn(userId) && rms(Buffer.concat(chunks)) >= config.minVolume) {
          interrupted = true;
          this.stop();
          log.info(`✋ ${this.guild.members.cache.get(userId)?.displayName ?? userId} قاطعها — سكتت`);
        } else {
          nextBargeCheckMs += 250;
        }
      }
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

    const heardAt = Date.now(); // the moment her ears had the whole sentence (after the short pause)
    let text;
    try {
      text = await transcribe(pcmToWav(stereo48kToMono16k(pcm), 16000, 1));
    } catch (err) {
      this.reportError('stt', 'تحويل الصوت لنص', err);
      return;
    }
    if (!text || looksLikeNoise(text) || this.destroyed) return;
    const timing = { heardAt, sttMs: Date.now() - heardAt };
    log.info(`🗣️  ${member.displayName}: ${text}`);
    if (config.rememberPeople) recordVoice(this.guild.id, { id: member.id, name: member.displayName });

    const called = containsWakeWord(text, config.wakeWords);
    const stopCommand =
      isStopCommand(text, config.stopWords, config.wakeWords) || ((called || isStopForHer(text)) && hasStrongStop(text));
    if (stopCommand) {
      // "بس" / "خلاص" between other people in a big room is not for her: she carries on.
      const forHer = called || isStopForHer(text) || userId === this.currentSpeaker || this.smallRoom();
      if (this.isBusy()) {
        if (forHer) {
          this.stop();
          log.info('⏹️  سكتت');
        } else {
          log.info(`🙉 "${text}" مب لي — كملت كلامي`);
        }
      }
      return;
    }

    // Noise the speech-to-text turned into a loop of one word: not worth an answer (and a voice request).
    if (isRepetitionLoop(text) && !isOnlyWakeWord(text, config.wakeWords)) {
      log.debug('كلام مكرر (غالباً ضوضاء) — تجاهلته');
      return;
    }

    const salam = isSalam(text, config.wakeWords);
    // Carrying on without her name: in a small room for a while; in a big room only the one she just answered,
    // for a few seconds, with a question.
    const since = Date.now() - (this.lastAnswer.get(userId) ?? 0);
    const followUp = this.smallRoom()
      ? since < config.followUpSeconds * 1000
      : since < config.followUpBigSeconds * 1000 && isClearQuestion(text);
    // While the bot talks, only react when called by name (avoids echo and cross-talk).
    if (startedWhileTalking && !called) return;
    // "السلام عليكم" gets "وعليكم السلام" in any room (once in a while per person).
    const greeting = salam && this.canGreet(userId);
    if (getMode(this.guild.id) === 'name' && !called && !followUp && !greeting) {
      log.info(`🙈 ما ذكر اسمي (${config.botName}) — تجاهلته`);
      return;
    }

    if (isOnlyWakeWord(text, config.wakeWords)) {
      this.enqueue(async (gen) => {
        await this.speakTo(userId, pickOne(ACKS), gen);
        this.lastAnswer.set(userId, Date.now());
      });
      return;
    }
    if (salam) {
      this.salamAnswered.set(userId, Date.now());
      this.lastSalamAt = Date.now();
      this.enqueue(async (gen) => {
        await this.speakTo(userId, pickOne(SALAM_REPLIES), gen);
        this.lastAnswer.set(userId, Date.now());
      });
      return;
    }
    if (config.moveByVoice && called) {
      const move = parseMoveCommand(text, config.wakeWords);
      if (move) {
        this.enqueue((gen) => this.handleMove(member, text, move, gen));
        return;
      }
    }
    // She starts thinking right away, even if she is still talking: the answer is ready the moment she finishes.
    const thinking = this.isBusy() ? this.think(member, text) : null;
    this.enqueue((gen) => this.answer(member, text, gen, timing, thinking));
  }

  /** "فطوم روحي روم القهوة": say OK, then join that room. */
  async handleMove(member, text, move, gen) {
    const rooms = this.voiceRooms();
    // A clear name match is enough; for a spoken oddity (an English room name in Arabic letters) the AI picks.
    let target = findVoiceChannel(move.query, rooms, move.explicit ? 0.7 : 0.9);
    if (!target && move.explicit && rooms.length) {
      try {
        target = rooms[await pickOption(move.query, rooms.map((room) => room.name))] ?? null;
      } catch (err) {
        log.debug('اختيار الروم:', err?.message ?? err);
      }
    }
    if (gen !== this.generation || this.destroyed) return;
    if (!target) {
      // "روح العب" is not about rooms: answer it like any other sentence.
      if (!move.explicit) return this.answer(member, text, gen);
      log.info(`🚪 ما لقيت روم اسمه "${move.query}"`);
      return this.speak(pickOne(NOT_FOUND), gen);
    }
    if (target.id === this.channel.id) return this.speak(pickOne(SAME_ROOM), gen);
    const me = this.guild.members?.me;
    if (!this.moveTo || !target.permissionsFor?.(me)?.has(VOICE_PERMISSIONS)) {
      log.info(`🚪 ما أقدر أدخل "${target.name}" (ما عندي صلاحية)`);
      return this.speak(pickOne(NO_ACCESS), gen);
    }
    const label = speakableName(target.name) || 'الروم';
    await this.speak(pickOne(MOVING).replace('{room}', label), gen);
    if (gen !== this.generation || this.destroyed) return;
    log.info(`🚪 رايحة "${target.name}" بطلب ${member.displayName}`);
    await this.moveTo(target, this.channel);
  }

  /** Every voice room in the server that she can see (the ones she can't join are told apart later). */
  voiceRooms() {
    const me = this.guild.members?.me;
    try {
      return [...(this.guild.channels?.cache?.values?.() ?? [])]
        .filter((c) => c.type === ChannelType.GuildVoice && (c.permissionsFor?.(me)?.has(PermissionFlagsBits.ViewChannel) ?? true))
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    } catch {
      return [];
    }
  }

  /**
   * Say hello by name to people who just came in (or who are in the room when she arrives).
   * `people` = [{ id, name }]. People who come in together get one hello.
   */
  welcome(people) {
    // A hello is a luxury: with the main voice resting, the backup's small free limit is kept for answers.
    if (!config.welcome || this.destroyed || isResting(`tts:${config.tts.provider}`)) return;
    const cooldown = config.welcomeCooldownSeconds * 1000;
    for (const person of people) {
      if (!person?.id || Date.now() - (this.welcomed.get(person.id) ?? 0) < cooldown) continue;
      this.welcomed.set(person.id, Date.now());
      this.welcomeNames.set(person.id, person.name);
    }
    if (!this.welcomeNames.size || this.welcomeTimer) return;
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = null;
      const here = new Set(this.humans().map((p) => p.id));
      const waiting = [...this.welcomeNames].filter(([id]) => here.has(id)); // somebody may have left again
      this.welcomeNames.clear();
      if (!waiting.length || this.destroyed) return;
      const names = joinNames(waiting.map(([, name]) => speakableName(name)));
      const text = pickOne(config.welcomeReplies.length ? config.welcomeReplies : ['هلا والله {name}'])
        .replace('{name}', names)
        .replace(/\s{2,}/g, ' ')
        .trim();
      log.info(`👋 رحبت بـ ${names || 'اللي دخل'}`);
      this.enqueue(async (gen) => {
        await this.speak(text, gen);
        // They can answer her hello without saying her name.
        for (const [id] of waiting) this.lastAnswer.set(id, Date.now());
      });
    }, config.welcomeDelayMs);
  }

  /** Answer this "السلام عليكم"? Alone with her: always. In a busy room: once in a while per person, one answer for a group. */
  canGreet(userId) {
    if (this.humans().length <= 1) return true;
    if (Date.now() - (this.salamAnswered.get(userId) ?? 0) < config.salamCooldownSeconds * 1000) return false;
    return Date.now() - this.lastSalamAt > 15_000;
  }

  /**
   * Does talking over her make her stop? In a room of two, anyone can. In a bigger room only the person
   * she is talking to can (everyone else is chatting with each other, and that must not cut her off).
   */
  canBargeIn(userId) {
    if (!config.bargeIn) return false;
    return this.smallRoom() || this.currentSpeaker === userId;
  }

  /** Speak to one person (so they are the one who can interrupt her). */
  async speakTo(userId, text, gen, onStart) {
    this.currentSpeaker = userId;
    try {
      await this.speak(text, gen, onStart);
    } finally {
      if (this.currentSpeaker === userId) this.currentSpeaker = null;
    }
  }

  /** The AI could not answer: say so out loud (once in a while), instead of staying silent. */
  async sorry(gen) {
    if (Date.now() - this.lastSorryAt < 30_000 || gen !== this.generation || this.destroyed) return;
    if (this.pending > 1) return; // others are waiting for an answer: answer them instead of apologising
    this.lastSorryAt = Date.now();
    await this.speak(pickOne(SORRY), gen);
  }

  /** Ask the brain now; the promise never fails (it carries the error instead). */
  think(member, text) {
    const startedAt = Date.now();
    const promise = askAI({
      guildId: this.guild.id,
      speaker: member.displayName,
      speakerId: member.id,
      room: this.humans(),
      text,
      vars: { SERVER_NAME: this.guild.name, CHANNEL_NAME: this.channel.name },
      onNotice: (notice) => this.say(notice),
    }).then(
      (reply) => ({ reply, doneAt: Date.now() }),
      (error) => ({ error, doneAt: Date.now() }),
    );
    return { startedAt, promise };
  }

  async answer(member, text, gen, timing, thinking = null) {
    // She was busy so long that the answer would come far too late (and confuse everyone): drop it.
    if (timing && Date.now() - timing.heardAt > config.staleSeconds * 1000) {
      log.info(`⌛ سؤال ${member.displayName} انتظر أكثر من ${config.staleSeconds} ثانية — تركته`);
      return;
    }
    this.currentSpeaker = member.id;
    try {
      await this.answerNow(member, text, gen, timing, thinking);
    } finally {
      if (this.currentSpeaker === member.id) this.currentSpeaker = null;
    }
  }

  async answerNow(member, text, gen, timing, thinking = null) {
    const asked = thinking ?? this.think(member, text);
    const { reply, error, doneAt } = await asked.promise;
    if (error) {
      this.reportError('llm', 'الذكاء الاصطناعي', error);
      await this.sorry(gen);
      return;
    }
    if (!reply || gen !== this.generation || this.destroyed) return;
    log.info(`🤖 ${config.botName}: ${reply}`);
    // The written answer shows up when she starts talking (or right away if the voice fails).
    const transcript = `🗣️ **${escapeMarkdown(member.displayName)}:** ${text}\n🤖 **${escapeMarkdown(config.botName)}:** ${reply}`;
    const brainMs = doneAt - asked.startedAt;
    await this.speak(reply, gen, () => {
      if (timing) {
        const sec = (ms) => (ms / 1000).toFixed(1);
        const total = Date.now() - timing.heardAt;
        log.info(`⏱️ سمع ${sec(timing.sttMs)}ث · فكر ${sec(brainMs)}ث · الصوت ${sec(total - timing.sttMs - brainMs)}ث · الكل ${sec(total)}ث (بعد صمتك ${config.silenceMs}م.ث)`);
      }
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
          // heard from the first word, without sleepy pauses
          const pieces = config.tts.tight ? tightenLive(live.chunks, { maxPauseMs: config.tts.maxPauseMs }) : live.chunks;
          for await (const piece of pieces) yield up(piece);
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
    clearTimeout(this.welcomeTimer);
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
