import { Readable } from 'node:stream';
// Helpers with no network calls (easy to test):
// - Arabic text: wake words, stop words, cleaning replies for speech
// - Audio: PCM conversion and WAV files

// Tashkeel (harakat), Quranic marks and tatweel.
const ARABIC_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** Lower-case, strip diacritics/punctuation and unify Arabic letter forms. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  const t = normalize(text);
  return t ? t.split(' ') : [];
}

// Arabic particles that can be glued to a name: "ياكلود", "والبوت", "لكلود"...
const PREFIXES = ['', 'يا', 'ال', 'يال', 'و', 'ويا', 'وال', 'ف', 'ب', 'ل'];
// Endings people put on a name when they talk to her: "فطومي", "فطومتي", "فطوماتي", "فطومه", "فطومو"...
const SUFFIXES = ['', 'ي', 'ه', 'تي', 'اتي', 'و', 'ها', 'نا'];

/** One word of the text is this name (with a particle before it and, for Arabic names, an ending after it). */
function isNameToken(word, name) {
  const arabic = /\p{Script=Arabic}/u.test(name) && name.length >= 4; // "بوت" stays exact ("بوته" is someone else's bot)
  for (const p of PREFIXES) {
    if (!word.startsWith(p + name)) continue;
    const ending = word.slice(p.length + name.length);
    if (ending === '' || (arabic && SUFFIXES.includes(ending))) return true;
  }
  return false;
}

/** True if the text calls the bot by one of its names. */
export function containsWakeWord(text, wakeWords) {
  const words = tokens(text);
  if (!words.length) return false;
  for (const raw of wakeWords) {
    const wake = tokens(raw);
    if (!wake.length) continue;
    for (let i = 0; i + wake.length <= words.length; i++) {
      if (!isNameToken(words[i], wake[0])) continue;
      if (wake.slice(1).every((w, j) => words[i + 1 + j] === w)) return true;
    }
  }
  return false;
}

const WAKE_EXTRAS = new Set(['يا', 'هي', 'hey', 'ok', 'اوكي']);

/** Is this word just a way of calling her ("يا", "فطوم", "يافطومتي")? */
function isWakeToken(word, wakeWords) {
  if (WAKE_EXTRAS.has(word)) return true;
  return wakeWords.some((raw) => tokens(raw).some((w) => isNameToken(word, w)));
}

/** The words that remain after removing the bot's name and "يا". */
export function withoutWakeWords(text, wakeWords) {
  return tokens(text).filter((t) => !isWakeToken(t, wakeWords));
}

/** "يا كلود" on its own (just calling the bot, no question yet). */
export function isOnlyWakeWord(text, wakeWords) {
  return containsWakeWord(text, wakeWords) && withoutWakeWords(text, wakeWords).length === 0;
}

const SALAM_WORDS = new Set(['سلام', 'السلام', 'عليكم', 'ورحمه', 'الله', 'وبركاته']);

/** "السلام عليكم" (with or without "ورحمة الله وبركاته" and her name). "وعليكم السلام" is an answer, not a greeting. */
export function isSalam(text, wakeWords = []) {
  const rest = withoutWakeWords(text, wakeWords);
  return rest.includes('عليكم') && rest.some((t) => t === 'سلام' || t === 'السلام') && rest.every((t) => SALAM_WORDS.has(t));
}

/** "اسكت" / "خلاص" / "كلود وقف" ... — every remaining word is a stop word. */
export function isStopCommand(text, stopWords, wakeWords) {
  const stop = new Set(stopWords.flatMap(tokens));
  const rest = withoutWakeWords(text, wakeWords);
  return rest.length > 0 && rest.length <= 4 && rest.every((t) => stop.has(t));
}

// Said to a woman ("اسكتي", "وقفي", "بسج"): in this room that is her, even without her name.
const TO_HER = new Set(['اسكتي', 'سكتي', 'وقفي', 'بسج', 'خلاصج']);

/** A stop command that is clearly meant for her (feminine form). */
export function isStopForHer(text) {
  return tokens(text).some((t) => TO_HER.has(t));
}

// ---------- Written chat ----------

const QUESTION_WORDS = new Set(['شو', 'وش', 'ايش', 'اش', 'شنو', 'ليش', 'لييش', 'لماذا', 'ماذا', 'كيف', 'وين', 'فين', 'متى', 'منو', 'من', 'مين', 'كم', 'هل', 'ويش', 'شلون', 'علام', 'اي', 'أي', 'ايه', 'ايهم']);

/** Does this message ask something? A question mark, or a question word at the start ("شو الطقس"). */
export function looksLikeQuestion(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  if (/[?؟]/.test(raw)) return true;
  const words = tokens(raw);
  return words.length >= 2 && words.slice(0, 2).some((w) => QUESTION_WORDS.has(w));
}

// ---------- Names, rooms and "does this need fresh info?" ----------

/** A name as it should be read aloud: decorations and emoji removed ("『MLG』 Ali ✨" → "MLG Ali"). */
export function speakableName(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .slice(0, 24);
}

/** ["منصور"] → "منصور"; two or three → "منصور وأحمد وسالم"; more → the first two and "والربع". */
export function joinNames(names) {
  const list = names.filter(Boolean);
  if (list.length > 3) return `${list[0]} و${list[1]} والربع`;
  return list.reduce((out, name, i) => (i === 0 ? name : `${out} و${name}`), '');
}

const MOVE_VERBS = new Set(['روح', 'روحي', 'رح', 'رحي', 'سير', 'سيري', 'خش', 'خشي', 'انتقل', 'انتقلي', 'ادخل', 'ادخلي', 'تعال', 'تعالي', 'اذهب', 'اذهبي', 'اطلع', 'اطلعي']);
const ROOM_WORDS = new Set(['روم', 'رووم', 'غرفه', 'قناه', 'الروم', 'الغرفه', 'القناه', 'room', 'channel', 'voice']);
const FILLER_WORDS = new Set(['صوتي', 'الصوتي', 'صوتيه', 'الصوتيه', 'حق', 'اللي', 'الي', 'علي', 'في', 'ع', 'عند', 'ل', 'اسمه', 'اسمها', 'ذاك', 'ذيك', 'هذا', 'هذي', 'لو', 'سمحت', 'بسرعه', 'الحين', 'يالله']);

/**
 * "فطوم روحي روم الألعاب" → { query: 'العاب', explicit: true }.
 * `explicit` = the sentence said "room"; without it the name has to match a real room to count.
 * Returns null when the sentence is not a "go to a room" request.
 */
export function parseMoveCommand(text, wakeWords) {
  const words = withoutWakeWords(text, wakeWords);
  const at = words.findIndex((w) => MOVE_VERBS.has(w));
  if (at < 0 || at > 2) return null;
  let explicit = false;
  const query = [];
  for (let word of words.slice(at + 1)) {
    word = word.replace(/^لل/, 'ال').replace(/^(?:علي|في|الي|ع|ل)(?=ال)/, '');
    if (ROOM_WORDS.has(word)) explicit = true;
    else if (!FILLER_WORDS.has(word)) query.push(word);
  }
  if (!query.length || query.length > 5) return null;
  return { query: query.join(' '), explicit };
}

const stripArticle = (word) => (word.startsWith('ال') && word.length > 3 ? word.slice(2) : word);
const roomKey = (text) => tokens(text).map(stripArticle).join(' ');

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return 0.9;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** The room whose name best matches what was said (null if nothing is close enough or two rooms tie). */
export function findVoiceChannel(query, channels, minScore = 0.7) {
  const wanted = roomKey(query);
  const scored = channels
    .map((channel) => ({ channel, score: similarity(wanted, roomKey(channel.name)) }))
    .sort((x, y) => y.score - x.score);
  if (!scored.length || scored[0].score < minScore) return null;
  if (scored[1] && scored[0].score - scored[1].score < 0.1) return null;
  return scored[0].channel;
}

// Questions that need today's facts (news, weather, prices, scores, prayer times...). Matched on whole words.
const FRESH_WORDS = new Set(
  [
    'اخبار', 'خبر', 'عاجل', 'طقس', 'الطقس', 'الجو', 'حراره', 'الحراره', 'رطوبه', 'مطر', 'امطار', 'غبار', 'سعر', 'اسعار',
    'بكم', 'ذهب', 'الذهب', 'دولار', 'الدولار', 'بيتكوين', 'اسهم', 'سهم', 'بورصه', 'نتيجه', 'نتايج', 'مباراه', 'مباريه',
    'دوري', 'فاز', 'اذان', 'الاذان', 'مواقيت', 'ابحث', 'ابحثي', 'قوقل', 'جوجل', 'احدث', 'ترند', 'تريند', 'رئيس', 'وزير',
  ].map(normalize),
);

/** True when the question probably needs up-to-date facts (so Google Search is worth the extra second). */
export function wantsFreshInfo(text, extraWords = []) {
  const words = tokens(text);
  const extra = new Set(extraWords.map(normalize));
  if (words.some((w) => FRESH_WORDS.has(w) || FRESH_WORDS.has(stripArticle(w)) || extra.has(w))) return true;
  const t = words.join(' ');
  if (/(?:باقي|متي|موعد|وقت).*(?:مغرب|عصر|فجر|ظهر|عشاء|صلاه)/.test(t)) return true;
  return /\b20(?:2[4-9]|3\d)\b/.test(t);
}

// Phrases Whisper-style models invent from silence or background noise.
const HALLUCINATIONS = new Set(
  [
    'ترجمة نانسي قنقر',
    'نانسي قنقر',
    'اشتركوا في القناة',
    'اشترك في القناة',
    'لا تنسوا الاشتراك في القناة',
    'شكرا للمشاهدة',
    'شكرا على المشاهدة',
    'شكرا لكم على المشاهدة',
    'موسيقى',
    'thank you',
    'thanks for watching',
    'thank you for watching',
    'you',
    'bye',
    'please subscribe',
  ].map(normalize),
);

/** True for empty transcripts and known STT hallucinations. */
export function looksLikeNoise(text) {
  const t = normalize(text);
  if (t.replace(/\s/g, '').length < 2) return true;
  if (HALLUCINATIONS.has(t)) return true;
  return t.includes('نانسي قنقر') || t.includes('amara org');
}

/**
 * Speech-to-text sometimes loops on noise ("بوت بوت بوت بوس بوت", "اعتقدت اعتقدت اعتقدت اعتقدت"):
 * one word makes up half of the text or more. Answering it only wastes the free voice limit.
 */
export function isRepetitionLoop(text) {
  const words = tokens(text);
  if (words.length < 4) return false;
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const most = Math.max(...counts.values());
  return most >= 4 && most / words.length >= 0.5;
}

/** Remove things that sound bad when read aloud (markdown, links, emoji). */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\p{Extended_Pictographic}|[\u200D\uFE0F]/gu, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/[*_`#>|~[\]{}<>]/g, ' ')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/([.!?؟،,؛])(?:\s*[.])+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function hardWrap(sentence, maxLen) {
  const parts = [];
  let rest = sentence.trim();
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    let cut = Math.max(window.lastIndexOf('،'), window.lastIndexOf(','), window.lastIndexOf('؛'));
    if (cut < maxLen * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLen - 1;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Split a reply into pieces of at most `maxLen` characters, cutting at sentence
 * ends where possible, so each piece can be sent to text-to-speech on its own.
 */
export function splitForSpeech(text, maxLen = 200) {
  const sentences = String(text ?? '').match(/[^.!?؟؛…\n]+[.!?؟؛…]*/gu) ?? [];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    for (const piece of hardWrap(sentence, maxLen)) {
      if (!piece) continue;
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= maxLen) current += ` ${piece}`;
      else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Like splitForSpeech, but the first piece is short so the voice can start sooner:
 * the first sentence(s) up to `firstLen`, then the rest in pieces up to `maxLen`.
 */
export function splitForFastStart(text, firstLen = 130, maxLen = 400) {
  const small = splitForSpeech(text, firstLen);
  if (small.length <= 1) return small;
  const [first, ...rest] = small;
  return [first, ...splitForSpeech(rest.join(' '), maxLen)];
}

/** True when the text is mostly English/Latin letters (pick an English voice). */
export function mostlyLatin(text) {
  const arabic = (String(text).match(/\p{Script=Arabic}/gu) ?? []).length;
  const latin = (String(text).match(/\p{Script=Latin}/gu) ?? []).length;
  return latin > arabic;
}

/** Replace {{NAME}} placeholders. Unknown placeholders are left as they are. */
export function fillTemplate(template, vars) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.hasOwn(vars, key) ? String(vars[key]) : match,
  );
}

// ---------- Audio ----------
export const DISCORD_RATE = 48000;
export const DISCORD_CHANNELS = 2;

/** Length in milliseconds of a 16-bit PCM buffer. */
export function pcmDurationMs(byteLength, rate = DISCORD_RATE, channels = DISCORD_CHANNELS) {
  return (byteLength / (rate * channels * 2)) * 1000;
}

/** Root-mean-square level (0 … 32768) of 16-bit PCM — a rough loudness measure. */
export function rms(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/** 48 kHz stereo → 16 kHz mono: average both channels and every 3 frames. */
export function stereo48kToMono16k(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const outFrames = Math.floor(frames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let o = 0; o < outFrames; o++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const i = (o * 3 + k) * 4;
      acc += pcm.readInt16LE(i) + pcm.readInt16LE(i + 2);
    }
    out.writeInt16LE(Math.round(acc / 6), o * 2);
  }
  return out;
}

/** Wrap raw 16-bit PCM in a WAV header. */
export function pcmToWav(pcm, rate, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Read a 16-bit PCM WAV file: { rate, channels, pcm }, or null if it is something else. */
export function readWav(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let format = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 16 <= buffer.length) {
      format = {
        code: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        rate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      // 1 = PCM, 0xFFFE = "extensible" PCM
      if (!format || ![1, 0xfffe].includes(format.code) || format.bits !== 16 || !format.channels) return null;
      // Streamed WAVs can carry an empty or too-big size: take the bytes that are really there.
      const end = size === 0 || start + size > buffer.length ? buffer.length : start + size;
      return { rate: format.rate, channels: format.channels, pcm: buffer.subarray(start, end) };
    }
    if (start + size > buffer.length) return null;
    offset = start + size + (size % 2);
  }
  return null;
}

/**
 * WAV → raw 48 kHz stereo 16-bit PCM, the format Discord plays directly
 * (no ffmpeg needed, so the voice starts sooner). null if it isn't a plain WAV.
 */
export function wavToDiscordPcm(clip) {
  const wav = readWav(clip);
  if (!wav || !wav.rate || wav.channels > 2) return null;
  const inFrames = Math.floor(wav.pcm.length / (2 * wav.channels));
  if (!inFrames) return null;
  const outFrames = Math.floor((inFrames * DISCORD_RATE) / wav.rate);
  const out = Buffer.alloc(outFrames * 4);
  const step = wav.rate / DISCORD_RATE;
  const sample = (frame, ch) => wav.pcm.readInt16LE((frame * wav.channels + Math.min(ch, wav.channels - 1)) * 2);
  for (let o = 0; o < outFrames; o++) {
    const pos = o * step;
    const i = Math.floor(pos);
    const j = Math.min(i + 1, inFrames - 1);
    const frac = pos - i;
    for (let ch = 0; ch < 2; ch++) {
      out.writeInt16LE(Math.round(sample(i, ch) * (1 - frac) + sample(j, ch) * frac), o * 4 + ch * 2);
    }
  }
  return out;
}

/**
 * Make quiet speech louder: raise it towards normal speech loudness without
 * clipping (at most ×3). Anything that isn't a 16-bit WAV is returned unchanged.
 */
export function louder(clip, targetLevel = 4000, maxGain = 3) {
  const wav = readWav(clip);
  const samples = wav ? Math.floor(wav.pcm.length / 2) : 0;
  if (!samples) return clip;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = wav.pcm.readInt16LE(i * 2);
    peak = Math.max(peak, Math.abs(s));
    sum += s * s;
  }
  const level = Math.sqrt(sum / samples);
  if (!level) return clip;
  const gain = Math.min(targetLevel / level, (0.95 * 32767) / peak, maxGain);
  if (gain <= 1.05) return clip;
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(wav.pcm.readInt16LE(i * 2) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return pcmToWav(out, wav.rate, wav.channels);
}

/**
 * Join several audio clips into one: WAV files are merged into one WAV,
 * MP3 files are put back to back. Returns null if they can't be joined.
 */
export function joinClips(clips) {
  if (clips.length === 1) return clips[0];
  const wavs = clips.map(readWav);
  if (wavs.every(Boolean)) {
    const [first] = wavs;
    if (!wavs.every((w) => w.rate === first.rate && w.channels === first.channels)) return null;
    return pcmToWav(Buffer.concat(wavs.map((w) => w.pcm)), first.rate, first.channels);
  }
  const anyRiff = clips.some((clip) => clip.toString('ascii', 0, 4) === 'RIFF');
  return anyRiff ? null : Buffer.concat(clips);
}

/**
 * Live audio: turns 24 kHz mono 16-bit PCM pieces (as they arrive) into the 48 kHz stereo
 * Discord wants. One upsampler per voice reply; `gain` makes quiet voices louder (clipped safely).
 */
export function createUpsampler(gain = 1, { targetLevel = 4000, maxGain = 3 } = {}) {
  let previous = null;
  let carry = null;
  let chosen = gain === 'auto' ? null : gain;
  const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
  return (chunk) => {
    const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    carry = usable < buf.length ? buf.subarray(usable) : null;
    const samples = usable / 2;
    if (chosen === null && samples) {
      // Loudness is judged from the first piece of audio and kept for the whole reply.
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < samples; i++) {
        const v = buf.readInt16LE(i * 2);
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
      }
      const level = Math.sqrt(sum / samples);
      chosen = level && peak ? Math.min(targetLevel / level, (0.95 * 32767) / peak, maxGain) : 1;
      if (chosen <= 1.05) chosen = 1;
    }
    const factor = chosen ?? 1;
    const out = Buffer.alloc(samples * 8);
    for (let i = 0; i < samples; i++) {
      const s = clamp(buf.readInt16LE(i * 2) * factor);
      const mid = previous === null ? s : clamp((previous + s) / 2);
      out.writeInt16LE(mid, i * 8);
      out.writeInt16LE(mid, i * 8 + 2);
      out.writeInt16LE(s, i * 8 + 4);
      out.writeInt16LE(s, i * 8 + 6);
      previous = s;
    }
    return out;
  };
}

const SILENCE_FRAME = Buffer.alloc(3840); // 20 ms of silence at 48 kHz stereo

/**
 * A stream Discord can play while the audio is still arriving. If the audio is late, short
 * silence is played instead of cutting the reply off. `source` is an async iterable of
 * 48 kHz stereo PCM; `onClose` runs when playing stops (so the download can be cancelled).
 */
export function liveAudioStream(source, onClose) {
  const queue = [];
  let ended = false;
  let waiting = false; // the player asked for audio and there was none yet
  let timer = null;
  let stream = null;
  const give = () => {
    clearTimeout(timer);
    waiting = false;
    if (!stream || stream.destroyed) return;
    if (queue.length) stream.push(queue.shift());
    else if (ended) stream.push(null);
    else stream.push(SILENCE_FRAME);
  };
  (async () => {
    try {
      for await (const piece of source) {
        queue.push(piece);
        if (waiting) give();
      }
    } catch {
      // a broken download just ends the audio
    } finally {
      ended = true;
      if (waiting) give();
    }
  })();
  stream = new Readable({
    highWaterMark: SILENCE_FRAME.length,
    read() {
      if (queue.length || ended) return give();
      waiting = true;
      timer = setTimeout(give, 20); // no audio yet: play 20 ms of silence (paced like real time)
    },
    destroy(error, callback) {
      clearTimeout(timer);
      onClose?.();
      callback(error);
    },
  });
  return stream;
}
