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

/** True if the text calls the bot by one of its names. */
export function containsWakeWord(text, wakeWords) {
  const words = tokens(text);
  if (!words.length) return false;
  for (const raw of wakeWords) {
    const wake = tokens(raw);
    if (!wake.length) continue;
    for (let i = 0; i + wake.length <= words.length; i++) {
      const first = words[i];
      if (!PREFIXES.some((p) => first === p + wake[0])) continue;
      if (wake.slice(1).every((w, j) => words[i + 1 + j] === w)) return true;
    }
  }
  return false;
}

function wakeTokenSet(wakeWords) {
  const set = new Set(['يا', 'هي', 'hey', 'ok', 'اوكي']);
  for (const raw of wakeWords) {
    for (const w of tokens(raw)) for (const p of PREFIXES) set.add(p + w);
  }
  return set;
}

/** The words that remain after removing the bot's name and "يا". */
export function withoutWakeWords(text, wakeWords) {
  const wake = wakeTokenSet(wakeWords);
  return tokens(text).filter((t) => !wake.has(t));
}

/** "يا كلود" on its own (just calling the bot, no question yet). */
export function isOnlyWakeWord(text, wakeWords) {
  return containsWakeWord(text, wakeWords) && withoutWakeWords(text, wakeWords).length === 0;
}

/** "اسكت" / "خلاص" / "كلود وقف" ... — every remaining word is a stop word. */
export function isStopCommand(text, stopWords, wakeWords) {
  const stop = new Set(stopWords.flatMap(tokens));
  const rest = withoutWakeWords(text, wakeWords);
  return rest.length > 0 && rest.length <= 4 && rest.every((t) => stop.has(t));
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
