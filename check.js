// `npm run check` — tests the setup without Discord:
// Node version, audio libraries, settings, and a real round trip through
// the AI → text-to-speech → speech-to-text. Also saves the bot's voice to a file.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { ROOT, config, validateConfig } from './config.js';

const ok = (msg) => console.log(`✅ ${msg}`);
const bad = (msg) => console.log(`❌ ${msg}`);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 12)) ok(`Node ${process.version}`);
else bad(`Node ${process.version} — لازم 22.12 أو أحدث (ننصح بـ 24 LTS)`);

console.log('\n--- مكتبات الصوت ---');
console.log(generateDependencyReport());

console.log('--- الإعدادات ---');
const problems = validateConfig();
if (problems.length) {
  for (const problem of problems) bad(problem);
  process.exit(1);
}
ok(`الإعدادات كاملة (STT: ${config.stt.provider} / TTS: ${config.tts.provider} / AI: ${config.llm.model})`);

console.log('\n--- تجربة المفاتيح ---');
const { askAI } = await import('./llm.js');
const { synthesize, transcribe } = await import('./speech.js');

let failed = false;
try {
  const reply = await askAI({
    guildId: 'self-test',
    speaker: 'اختبار',
    text: 'سلم علي بجملة وحدة قصيرة.',
    vars: { SERVER_NAME: 'تجربة', CHANNEL_NAME: 'تجربة' },
  });
  ok(`الذكاء الاصطناعي رد: ${reply}`);
} catch (err) {
  failed = true;
  bad(`الذكاء الاصطناعي: ${err.message}`);
}

let audio;
const isWav = config.tts.provider === 'groq';
const file = path.join(ROOT, isWav ? 'voice-test.wav' : 'voice-test.mp3');
try {
  audio = await synthesize('هلا والله! هذا صوتي، وإن شاء الله يعجبك.');
  writeFileSync(file, audio);
  ok(`الصوت اشتغل — اسمعه من الملف: ${file}`);
} catch (err) {
  failed = true;
  bad(`تحويل النص لصوت: ${err.message}`);
}

if (audio) {
  try {
    const text = await transcribe(
      audio,
      isWav ? { name: 'speech.wav', type: 'audio/wav' } : { name: 'speech.mp3', type: 'audio/mpeg' },
    );
    ok(`تحويل الصوت لنص سمع: "${text}"`);
  } catch (err) {
    failed = true;
    bad(`تحويل الصوت لنص: ${err.message}`);
  }
}

console.log(failed ? '\nفي شي يحتاج تصليح فوق 👆' : '\n🎉 كل شي تمام — شغّل البوت بـ npm start');
process.exit(failed ? 1 : 0);
