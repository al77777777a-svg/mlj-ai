// Written chat: she chats in the channels listed in TEXT_CHANNEL_IDS (the server's general chat), in her
// Emirati voice, with the same brain and the same memory of people and the server as in the voice room.
// She can also chat with a friend bot (FRIEND_BOTS, "حسون" by default), with a limit so two bots never loop forever.
import { config, log } from './config.js';
import { containsWakeWord, looksLikeQuestion, normalize } from './helpers.js';
import { askAI } from './llm.js';
import { recordChat } from './people.js';

const MAX_REPLY_CHARS = 1900; // Discord's limit is 2000
const MAX_INPUT_CHARS = 1000;
const RECENT_MINUTES = 15; // people who wrote in the last minutes count as "here" (she can save facts about them)
const MAX_RECENT = 8;
const SORRY = ['ما قدرت أجاوبك الحين، عيدها بعد شوي 🙏', 'تعبت شوي، عيد علي بعد لحظة'];
const UNKNOWN_FRIEND = ['ما أعرف {friend} لسه، خله يكتب شي هني في الشات وبعدها أقدر أكلمه'];
// "فطوم كلمي حسون" / "سولفي ويا حسون" / "ناديي حسون"
const START_WITH_FRIEND = /(كلمي|كلم|سولفي|سالفي|ناديي|نادي|ناطري|قولي ل|اسألي|تحدي|لعبي)/;

const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const textChatEnabled = () => config.textChannelIds.length > 0;

/**
 * Returns `{ handle(message) }`. `getClient()` gives the current Discord client (its `user` is the bot).
 * She answers when she is called (mention, her name, a reply to her), when the person she just answered goes on,
 * and — TEXT_REPLY_MODE — to questions nobody else was addressed in, or to everything.
 */
export function createTextChat(getClient) {
  const answered = new Map(); // `${channelId}:${userId}` -> when she last answered them
  const followUps = new Map(); // `${channelId}:${userId}` -> answers in a row without being called
  const recent = new Map(); // channelId -> Map(userId -> { name, at })
  const lastUnasked = new Map(); // channelId -> when she last answered without being called
  const botChain = new Map(); // channelId -> how many answers in a row went to a bot (a person writing resets it)
  const lastBotAnswer = new Map(); // channelId -> when she last answered a bot
  const friendIds = new Set(config.friendBots.filter((x) => /^\d{15,25}$/.test(x)));
  const friendNames = config.friendBots.filter((x) => !/^\d{15,25}$/.test(x)).map(normalize).filter(Boolean);
  let lastSorryAt = 0;

  const isFriend = (user) =>
    Boolean(user?.bot) &&
    (friendIds.has(user.id) ||
      friendNames.some((n) => [user.globalName, user.username, user.displayName].some((x) => normalize(x ?? '').includes(n))));

  function note(message, name) {
    const people = recent.get(message.channelId) ?? new Map();
    recent.set(message.channelId, people);
    people.set(message.author.id, { name, at: Date.now() });
    const cutoff = Date.now() - RECENT_MINUTES * 60_000;
    for (const [id, p] of people) if (p.at < cutoff) people.delete(id);
  }

  function whoIsHere(message, name) {
    const people = [...(recent.get(message.channelId) ?? new Map())]
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_RECENT)
      .map(([id, p]) => ({ id, name: p.name }));
    return people.some((p) => p.id === message.author.id) ? people : [...people, { id: message.author.id, name }];
  }

  const displayName = (message) =>
    message.member?.displayName ?? message.author.globalName ?? message.author.username ?? 'واحد';

  /** The message without her own mention, trimmed. */
  function cleanText(message, me) {
    return String(message.cleanContent ?? message.content ?? '')
      .replace(new RegExp(`@${escapeRegExp(message.guild?.members?.me?.displayName ?? me.username ?? '')}`, 'gi'), ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_INPUT_CHARS);
  }

  async function handle(message) {
    const me = getClient()?.user;
    if (!me || !message.author || message.author.id === me.id || !message.guildId) return;
    if (!config.textChannelIds.includes(message.channelId)) return;
    if (message.author.bot) {
      if (isFriend(message.author)) {
        friendIds.add(message.author.id); // learned: she can mention this bot from now on
        return handleFriend(message, me);
      }
      return;
    }
    botChain.delete(message.channelId); // a person is talking again: the bots may chat again

    const name = displayName(message);
    const text = cleanText(message, me);
    if (!/[\p{L}\p{N}]/u.test(text)) return; // only emoji / a picture

    note(message, name);
    // She keeps what is said in the chat and who is chatting (also what is not meant for her).
    if (config.rememberPeople) recordChat(message.guildId, { id: message.author.id, name }, text);

    const mentioned = message.mentions?.has?.(me.id, { ignoreEveryone: true, ignoreRoles: true }) ?? false;
    const others = [...(message.mentions?.users?.values?.() ?? [])].some((u) => u.id !== me.id && !u.bot);
    let repliedToMe = false;
    let repliedToOther = false;
    if (message.reference?.messageId) {
      const parent = await message.fetchReference?.().catch(() => null);
      repliedToMe = parent?.author?.id === me.id;
      repliedToOther = Boolean(parent) && !repliedToMe;
    }

    const key = `${message.channelId}:${message.author.id}`;
    const called = mentioned || repliedToMe || containsWakeWord(text, config.wakeWords);
    if (called && (await startWithFriend(message, name, text))) return;

    const toSomeoneElse = (others && !mentioned) || repliedToOther;
    // Carrying on without her name: only a question, and only a couple in a row (else she answers every line of a chat).
    const followUp =
      !toSomeoneElse &&
      Date.now() - (answered.get(key) ?? 0) < config.textFollowUpSeconds * 1000 &&
      looksLikeQuestion(text) &&
      (followUps.get(key) ?? 0) < config.textFollowUpsInARow;
    let answer = called || followUp;
    if (!answer && !toSomeoneElse) {
      if (config.textReplyMode === 'everyone') answer = true;
      // a question to everyone (3+ words), now and then
      else if (config.textReplyMode === 'questions') answer = looksLikeQuestion(text) && text.split(/\s+/).length >= 3;
    }
    if (!answer) return;
    followUps.set(key, called ? 0 : (followUps.get(key) ?? 0) + 1);
    if (!called && !followUp) {
      // Not asked: don't take over the chat.
      if (Date.now() - (lastUnasked.get(message.channelId) ?? 0) < config.textCooldownSeconds * 1000) return;
      lastUnasked.set(message.channelId, Date.now());
    }

    log.info(`💬 ${name} (#${message.channel?.name ?? message.channelId}): ${text}`);
    message.channel?.sendTyping?.().catch(() => {});
    let reply;
    try {
      reply = await ask(message, { name, text, room: whoIsHere(message, name) });
    } catch (err) {
      log.warn(`الشات: الذكاء الاصطناعي ما رد: ${err?.message ?? err}`);
      if (called && Date.now() - lastSorryAt > 60_000) {
        lastSorryAt = Date.now();
        await send(message, pickOne(SORRY));
      }
      return;
    }
    if (!reply) return;
    answered.set(key, Date.now());
    log.info(`🤖 ${config.botName} (#${message.channel?.name ?? message.channelId}): ${reply}`);
    await send(message, reply);
  }

  const ask = (message, { name, text, room, peer = false }) =>
    askAI({
      guildId: message.guildId,
      chatKey: `${message.guildId}#text#${message.channelId}`,
      medium: 'text',
      peer,
      speaker: name,
      speakerId: message.author.id,
      room,
      text,
      vars: { SERVER_NAME: message.guild?.name ?? '', CHANNEL_NAME: message.channel?.name ?? '' },
    });

  /** A friend bot wrote: she answers only when it talks to her, and only a few times in a row. */
  async function handleFriend(message, me) {
    const text = cleanText(message, me);
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    const mentioned = message.mentions?.has?.(me.id, { ignoreEveryone: true, ignoreRoles: true }) ?? false;
    let repliedToMe = false;
    if (message.reference?.messageId) {
      const parent = await message.fetchReference?.().catch(() => null);
      repliedToMe = parent?.author?.id === me.id;
    }
    if (!(mentioned || repliedToMe || containsWakeWord(text, config.wakeWords))) return;
    const chain = botChain.get(message.channelId) ?? 0;
    if (chain >= config.textBotChainMax) {
      log.info(`🤖↔️🤖 وصلت حد السوالف مع ${displayName(message)} (${chain}) — أنتظر لين يتكلم أحد.`);
      return;
    }
    if (Date.now() - (lastBotAnswer.get(message.channelId) ?? 0) < config.textBotCooldownSeconds * 1000) return;
    lastBotAnswer.set(message.channelId, Date.now());
    botChain.set(message.channelId, chain + 1);

    const name = displayName(message);
    log.info(`🤖 ${name} (#${message.channel?.name ?? message.channelId}): ${text}`);
    let reply;
    try {
      reply = await ask(message, { name, text, room: [], peer: true });
    } catch (err) {
      log.warn(`الشات: الذكاء الاصطناعي ما رد على ${name}: ${err?.message ?? err}`);
      return;
    }
    if (!reply) return;
    log.info(`🤖 ${config.botName} → ${name}: ${reply}`);
    await send(message, reply, { pingAuthor: true }); // a reply with a ping, so the other bot notices it
  }

  /** "فطوم كلمي حسون": she starts the chat with the friend bot (needs to know its id: it learns it when it writes once). */
  async function startWithFriend(message, name, text) {
    const norm = normalize(text);
    const friend = friendNames.find((n) => norm.includes(n));
    if (!friend || !START_WITH_FRIEND.test(norm)) return false;
    const id = [...friendIds].find((fid) => message.guild?.members?.cache?.get?.(fid)?.user?.bot ?? true);
    const friendName = config.friendBots.find((x) => normalize(x) === friend) ?? friend;
    if (!id) {
      await send(message, pickOne(UNKNOWN_FRIEND).replace('{friend}', friendName));
      return true;
    }
    botChain.set(message.channelId, 1); // the opening line counts: the chat has a few turns, then stops
    lastBotAnswer.set(message.channelId, Date.now());
    message.channel?.sendTyping?.().catch(() => {});
    try {
      const opener = await ask(message, {
        name,
        text: `${text}\n(اكتبي رسالة وحدة قصيرة موجهة لـ ${friendName} تبدين فيها السالفة معاه، بدون ما تذكرين إن أحد طلب منج)`,
        room: whoIsHere(message, name),
      });
      if (opener) {
        log.info(`🤖 ${config.botName} → ${friendName}: ${opener}`);
        await message.channel.send({
          content: `<@${id}> ${opener}`.slice(0, MAX_REPLY_CHARS),
          allowedMentions: { parse: [], users: [id] },
        });
      }
    } catch (err) {
      log.warn(`الشات: ما قدرت أبدي السالفة مع ${friendName}: ${err?.message ?? err}`);
    }
    return true;
  }

  async function send(message, content, { pingAuthor = false } = {}) {
    try {
      await message.reply({
        content: content.slice(0, MAX_REPLY_CHARS),
        allowedMentions: { parse: [], repliedUser: pingAuthor },
      });
    } catch (err) {
      log.warn(`الشات: ما قدرت أرسل الرد: ${err?.message ?? err} (تأكد من صلاحيات View Channel وSend Messages وRead Message History)`);
    }
  }

  return { handle };
}
