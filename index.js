// Entry point: logs in to Discord, registers the slash commands and manages voice sessions.
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  OAuth2Scopes,
  PermissionFlagsBits,
  SlashCommandBuilder,
  escapeMarkdown,
} from 'discord.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { generateDependencyReport } from '@discordjs/voice';
import { ROOT, config, log, validateConfig } from './config.js';
import { VoiceSession, getMode, setMode } from './voice-session.js';
import { askAI, forgetAll, resetMemory } from './llm.js';

const problems = validateConfig();
if (problems.length) {
  console.error('\n❌ الإعدادات ناقصة:\n');
  for (const problem of problems) console.error(`  • ${problem}`);
  console.error('\nعلى جهازك: انسخ .env.example باسم .env وعبّي القيم.');
  console.error('على Railway: حط القيم في Variables.\n');
  process.exit(1);
}
log.debug(`\n${generateDependencyReport()}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const sessions = new Map(); // guildId -> VoiceSession
const aloneTimers = new Map(); // guildId -> timeout
const VOICE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];
const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

// ---------- Slash commands shown in Discord ----------

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('البوت يدش الروم الصوتي اللي أنت فيه ويسمعكم'),

  new SlashCommandBuilder().setName('leave').setDescription('البوت يطلع من الروم'),

  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('اسأل البوت كتابة ويرد عليك (وبصوت إذا هو في الروم)')
    .addStringOption((option) =>
      option.setName('question').setDescription('سؤالك').setRequired(true).setMaxLength(1000),
    ),

  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('متى يرد البوت؟')
    .addStringOption((option) =>
      option
        .setName('when')
        .setDescription('اختر طريقة الرد')
        .setRequired(true)
        .addChoices(
          { name: 'بس لما أناديه باسمه', value: 'name' },
          { name: 'على أي كلام في الروم', value: 'everyone' },
        ),
    ),

  new SlashCommandBuilder().setName('stop').setDescription('يسكت البوت ويلغي الردود اللي بالانتظار'),

  new SlashCommandBuilder().setName('reset').setDescription('البوت ينسى السالفة ويبدأ من جديد'),

  new SlashCommandBuilder().setName('forget').setDescription('البوت ينسى اللي يعرفه عن الناس والسيرفر'),
].map((command) => command.toJSON());

// ---------- Startup ----------

client.once(Events.ClientReady, async (ready) => {
  log.info(`✅ ${ready.user.tag} شغال في ${ready.guilds.cache.size} سيرفر`);
  const invite = ready.generateInvite({
    scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
    permissions: [
      ...VOICE_PERMISSIONS,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.UseVAD,
      PermissionFlagsBits.ChangeNickname,
    ],
  });
  log.info(`🔗 رابط إضافة البوت لسيرفرك:\n${invite}`);
  await Promise.all(ready.guilds.cache.map(registerCommands));
  await Promise.all(ready.guilds.cache.map(useBotName));
  await setAvatar(ready);
  if (config.autoJoinChannelId) await autoJoin();
});

client.on(Events.GuildCreate, (guild) => {
  registerCommands(guild);
  useBotName(guild);
});

/** Show the bot as BOT_NAME in each server (its nickname there). */
async function useBotName(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe?.().catch(() => null));
  if (!me || me.nickname === config.botName) return;
  try {
    await me.setNickname(config.botName);
    log.info(`📛 اسمي في "${guild.name}" صار ${config.botName}`);
  } catch (err) {
    log.debug(`ما قدرت أغير اسمي في "${guild.name}": ${err?.message ?? err}`);
  }
}

/** Give the bot its face (avatar.png) if it has no picture yet, or once when BOT_AVATAR_UPDATE=true. */
async function setAvatar(ready) {
  const file = path.join(ROOT, 'avatar.png');
  if (!existsSync(file) || (ready.user.avatar && !config.avatarUpdate)) return;
  try {
    await ready.user.setAvatar(file);
    log.info('🖼️ حطيت صورة البوت من avatar.png');
  } catch (err) {
    log.warn(`ما قدرت أغير صورة البوت: ${err?.message ?? err}`);
  }
}

async function registerCommands(guild) {
  try {
    await guild.commands.set(commands);
    log.debug(`سجلت الأوامر في "${guild.name}"`);
  } catch (err) {
    log.warn(`ما قدرت أسجل أوامر / في "${guild.name}": ${err.message} — أعد إضافة البوت بالرابط اللي فوق.`);
  }
}

// ---------- Joining and leaving ----------

async function joinChannel(channel) {
  const guildId = channel.guild.id;
  const current = sessions.get(guildId);
  if (current && !current.destroyed) {
    if (current.channel.id === channel.id) return current;
    current.leftOnPurpose = true;
    current.destroy();
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const session = new VoiceSession(channel, { onEnd: onSessionEnd });
  sessions.set(guildId, session);
  await session.connect(); // throws if the voice connection fails
  session.announce();
  log.info(`🎙️  دشيت "${channel.name}" في "${channel.guild.name}"`);
  checkAlone(session);
  return session;
}

function onSessionEnd(session) {
  const guildId = session.guild.id;
  if (sessions.get(guildId) === session) sessions.delete(guildId);
  clearTimeout(aloneTimers.get(guildId));
  aloneTimers.delete(guildId);
  if (!session.connected) return;
  log.info(`👋 طلعت من "${session.channel.name}"`);
  // In the auto-join room: come back if we were dropped by accident.
  if (config.autoJoinChannelId && !session.leftOnPurpose && session.channel.id === config.autoJoinChannelId) {
    setTimeout(() => autoJoin(), 10_000);
  }
}

async function autoJoin() {
  const channel = await client.channels.fetch(config.autoJoinChannelId).catch(() => null);
  if (!channel?.isVoiceBased()) {
    log.warn('AUTO_JOIN_CHANNEL_ID مو آيدي روم صوتي البوت يقدر يشوفه.');
    return;
  }
  if (sessions.get(channel.guild.id)?.channel.id === channel.id) return;
  await joinChannel(channel).catch(logJoinError);
}

function logJoinError(err) {
  if (err?.message === 'VOICE_CONNECT_TIMEOUT') {
    log.error('الاتصال الصوتي ما اكتمل خلال 20 ثانية.');
    log.error('غالباً الاستضافة أو الجدار الناري يمنع UDP اللي يحتاجه صوت ديسكورد — جرّب جهاز أو سيرفر ثاني.');
    if (err.details) log.error(`آخر رسائل الاتصال:\n${err.details}`);
  } else {
    log.error('ما قدرت أدش الروم:', err?.message ?? err);
  }
}

// Leave when the room is empty (except the auto-join room), and follow the bot if it gets moved.
function checkAlone(session) {
  const guildId = session.guild.id;
  const humans = session.channel.members.filter((m) => !m.user.bot).size;
  const stay = session.channel.id === config.autoJoinChannelId || config.leaveWhenAloneSeconds <= 0;
  if (humans > 0 || stay) {
    clearTimeout(aloneTimers.get(guildId));
    aloneTimers.delete(guildId);
    return;
  }
  if (aloneTimers.has(guildId)) return;
  const timer = setTimeout(() => {
    aloneTimers.delete(guildId);
    if (sessions.get(guildId) !== session) return;
    if (session.channel.members.filter((m) => !m.user.bot).size === 0) {
      log.info('الروم فاضي — بطلع.');
      session.leftOnPurpose = true;
      session.destroy();
    }
  }, config.leaveWhenAloneSeconds * 1000);
  aloneTimers.set(guildId, timer);
}

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = newState.guild.id;
  const session = sessions.get(guildId);

  if (session && newState.id === client.user.id && newState.channel) {
    session.channel = newState.channel; // someone moved the bot
  }
  if (session) checkAlone(session);

  const joinedAutoRoom =
    config.autoJoinChannelId &&
    newState.channelId === config.autoJoinChannelId &&
    oldState.channelId !== newState.channelId &&
    !newState.member?.user.bot;
  if (joinedAutoRoom && !sessions.has(guildId)) joinChannel(newState.channel).catch(logJoinError);
});

// ---------- Slash commands ----------

const handlers = {
  async join(interaction) {
    const channel = interaction.member.voice.channel;
    if (!channel) return interaction.reply(ephemeral('🎧 ادخل روم صوتي أول، وبعدين اكتب /join'));
    if (channel.type === ChannelType.GuildStageVoice) {
      return interaction.reply(ephemeral('رومات الـ Stage مو مدعومة — جرّب روم صوتي عادي.'));
    }
    if (!channel.permissionsFor(interaction.guild.members.me)?.has(VOICE_PERMISSIONS)) {
      return interaction.reply(
        ephemeral(`ما عندي صلاحية أدش **${escapeMarkdown(channel.name)}** وأتكلم فيه (View Channel + Connect + Speak).`),
      );
    }
    await interaction.deferReply();
    try {
      await joinChannel(channel);
    } catch (err) {
      logJoinError(err);
      return interaction.editReply(
        err.message === 'VOICE_CONNECT_TIMEOUT'
          ? '⚠️ دشيت بس الاتصال الصوتي ما اكتمل. غالباً الاستضافة تمنع UDP — شوف رسائل الكونسول.'
          : `⚠️ ما قدرت أدش: ${err.message}`,
      );
    }
    const how =
      getMode(interaction.guildId) === 'name'
        ? `قل **"يا ${escapeMarkdown(config.botName)}"** وبعدها سؤالك 🎙️`
        : 'تكلموا وأنا أرد على أي كلام 🎙️';
    return interaction.editReply(`✅ دشيت **${escapeMarkdown(channel.name)}** — ${how}`);
  },

  async leave(interaction) {
    const session = sessions.get(interaction.guildId);
    if (!session) return interaction.reply(ephemeral('أنا مب داخلة أي روم 🙂'));
    session.leftOnPurpose = true;
    session.destroy();
    return interaction.reply('👋 طلعت من الروم.');
  },

  async ask(interaction) {
    const question = interaction.options.getString('question', true);
    const session = sessions.get(interaction.guildId);
    await interaction.deferReply();
    let notice = '';
    const reply = await askAI({
      guildId: interaction.guildId,
      speaker: interaction.member.displayName,
      speakerId: interaction.member.id,
      room: session?.humans() ?? [],
      text: question,
      vars: { SERVER_NAME: interaction.guild.name, CHANNEL_NAME: session?.channel.name ?? '' },
      onNotice: (message) => {
        notice = message;
      },
    });
    const answer = `🗣️ **${escapeMarkdown(interaction.member.displayName)}:** ${question}\n🤖 **${escapeMarkdown(config.botName)}:** ${reply || '…'}`;
    await interaction.editReply({
      content: (notice ? `${answer}\n-# ${notice}` : answer).slice(0, 2000),
      allowedMentions: { parse: [] },
    });
    if (session && reply) session.enqueue((gen) => session.speak(reply, gen));
  },

  async mode(interaction) {
    const value = interaction.options.getString('when', true);
    setMode(interaction.guildId, value);
    return interaction.reply(
      value === 'name'
        ? `👌 بأرد بس لما تنادوني باسمي (${escapeMarkdown(config.botName)}).`
        : '👌 بأرد على أي كلام في الروم.',
    );
  },

  async stop(interaction) {
    sessions.get(interaction.guildId)?.stop();
    return interaction.reply(ephemeral('🤐 سكتت.'));
  },

  async forget(interaction) {
    const count = forgetAll(interaction.guildId);
    return interaction.reply(count ? `🧹 نسيت ${count} معلومة عن الناس والسيرفر.` : 'ما كنت أعرف شي أنساه 🙂');
  },

  async reset(interaction) {
    resetMemory(interaction.guildId);
    return interaction.reply('🧹 نسيت السالفة — نبدأ من جديد.');
  },
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply(ephemeral('الأوامر تشتغل داخل السيرفر بس.')).catch(() => {});
    return;
  }
  try {
    await handlers[interaction.commandName]?.(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName}:`, err?.message ?? err);
    const content = `⚠️ صار خطأ: ${String(err?.message ?? err).slice(0, 300)}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply(ephemeral(content)).catch(() => {});
  }
});

// ---------- Run ----------

process.on('unhandledRejection', (err) => log.error('خطأ غير متوقع:', err?.message ?? err));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log.info('🛑 جاري الإيقاف…');
    for (const session of sessions.values()) {
      session.leftOnPurpose = true;
      session.destroy();
    }
    Promise.resolve(client.destroy()).finally(() => process.exit(0));
  });
}

client.login(config.discordToken).catch((err) => {
  log.error('ما قدرت أسجل دخول في ديسكورد:', err.message);
  log.error('تأكد إن DISCORD_TOKEN صحيح (Developer Portal → Bot → Reset Token).');
  process.exit(1);
});
