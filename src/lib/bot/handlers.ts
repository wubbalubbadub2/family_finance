import { Bot, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { chat, handleCallback, type BotResponse } from '@/lib/claude/agent';
import {
  consumeFamilyInvite,
  getUserByTelegramId,
  createFamily,
  createFamilyInvite,
  getCategoriesForFamily,
  resolveFamilyForChat,
  getFamilyById,
} from '@/lib/db/queries';
import { captureError } from '@/lib/observability';
import type { Category } from '@/types';

/**
 * Single source of truth for the welcome message. Used by both:
 *   - handleInviteArrival (brand new user just consumed an invite)
 *   - bare /start (existing user re-greeting)
 *
 * Shows the family's CURRENT categories (not hardcoded defaults) so an
 * existing user who has customized sees their real setup, and a fresh
 * user sees the auto-seeded universal defaults.
 */
function buildWelcomeText(name: string, categories: Category[]): string {
  const catList = categories.length > 0
    ? categories.map((c) => `${c.emoji} ${c.name}`).join(' · ')
    : '(пока нет — создадутся автоматически на первой трате)';

  return (
    `👋 Привет, ${name}!\n\n` +
    `Я веду семейный бюджет — пиши траты обычным текстом, я разберусь сам.\n\n` +
    `📋 Сейчас у тебя такие категории:\n${catList}\n\n` +
    `Хочешь свои? Напиши, например:\n` +
    `«создай категории: Продукты, Бензин, Рестораны, Хобби»\n` +
    `Можно добавлять, переименовывать, удалять в любой момент. ` +
    `При удалении категории её траты переедут в Разное.\n\n` +
    `Что попробовать:\n` +
    `• кофе 500 — записать трату\n` +
    `• зарплата 500 000 — записать доход\n` +
    `• взял в долг 100 000 у Аидара — записать долг\n` +
    `• поставь лимит 80 000 на Продукты — план на категорию\n` +
    `• сколько на кофе? — поиск\n` +
    `• итоги месяца — общая сводка\n` +
    `• хочу накопить 1 000 000 к декабрю — поставить цель\n\n` +
    `Просто начни писать.`
  );
}

// NOTE: we removed ALLOWED_TELEGRAM_IDS. Allowlist is the `users` table now.
// Anyone can DM the bot — if they're not in the table, they get a welcome
// message telling them to get an invite link from their family admin. If
// they are, they go through normal chat(). The invite flow (/start invite_X)
// handles new-user onboarding without requiring env changes.

async function sendResponse(ctx: Context, response: BotResponse) {
  const replyOpts: {
    parse_mode?: 'Markdown';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  } = {};
  if (response.keyboard && response.keyboard.length > 0) {
    replyOpts.reply_markup = { inline_keyboard: response.keyboard };
  }
  try {
    await ctx.reply(response.text, { ...replyOpts, parse_mode: 'Markdown' });
  } catch {
    await ctx.reply(response.text, replyOpts);
  }
}

async function sendChunked(ctx: Context, response: BotResponse) {
  if (response.text.length <= 4000) {
    await sendResponse(ctx, response);
    return;
  }
  const parts = response.text.match(/[\s\S]{1,4000}/g) ?? [response.text];
  for (let i = 0; i < parts.length - 1; i++) {
    await sendResponse(ctx, { text: parts[i] });
  }
  await sendResponse(ctx, { text: parts[parts.length - 1], keyboard: response.keyboard });
}

// Telegram deep links: t.me/<bot>?start=<payload> → Telegram sends `/start <payload>`.
// We use `invite_<code>` as the payload for family onboarding.
function parseInvitePayload(text: string): string | null {
  const m = text.match(/^\/start(?:@\w+)?\s+invite_([a-z0-9]+)\s*$/i);
  return m ? m[1].toLowerCase() : null;
}

// Derive the handle from the BOT'S OWN TOKEN via getMe(). The token IS the
// bot's identity, so this is the only source of truth that cannot produce a
// link pointing at the wrong bot. Cached per lambda instance.
//
// We had an incident (2026-04) where TELEGRAM_BOT_HANDLE wasn't set on Vercel
// and the old fallback was a hardcoded string that happened to be another
// real bot — users tapped "their" invite link and talked to a stranger's bot.
// Never again: no env var, no default, no silent divergence.
let cachedBotHandle: string | null = null;

async function resolveBotHandle(ctx: Context): Promise<string> {
  if (cachedBotHandle) return cachedBotHandle;
  const me = await ctx.api.getMe();
  if (!me.username) throw new Error('Bot has no @username set in BotFather');
  cachedBotHandle = me.username;
  return cachedBotHandle;
}

async function buildInviteLink(ctx: Context, code: string): Promise<string> {
  const handle = await resolveBotHandle(ctx);
  return `https://t.me/${handle}?start=invite_${code}`;
}

/**
 * Admin command: create a new EMPTY family + invite link.
 * The caller is NOT added to the new family — first person to tap the
 * returned link becomes the first member.
 */
async function handleNewFamilyCommand(
  ctx: Context,
  name: string | null,
  callerUserId: string,
): Promise<void> {
  if (!name || !name.trim()) {
    await ctx.reply(
      '📝 Использование: `/newfamily Название семьи`\n\n' +
      'Пример: `/newfamily Psychologist Family`\n\n' +
      'Создаст новую пустую семью и вернёт ссылку-приглашение (действует 14 дней, одноразовая). ' +
      'Вы НЕ становитесь членом новой семьи — первый, кто кликнет ссылку, будет первым участником.',
      { parse_mode: 'Markdown' },
    ).catch(() => ctx.reply('Использование: /newfamily <название>'));
    return;
  }
  try {
    const familyId = await createFamily(name.trim());
    const invite = await createFamilyInvite({
      family_id: familyId,
      created_by_user_id: callerUserId,
      uses: 1,
      expires_in_days: 14,
    });
    const link = await buildInviteLink(ctx, invite.code);
    // NO parse_mode here: bot usernames and invite codes contain underscores,
    // which legacy Markdown treats as italic markers — they get eaten and the
    // link breaks. Plain text preserves the URL verbatim and Telegram still
    // auto-links it client-side.
    // Phase 2: clearer message that explains the full flow — admin creates
    // the family, customer taps the link to register, and after that they
    // can add the bot to a Telegram group to share with the rest of the
    // household. No /invite step needed.
    await ctx.reply(
      `✅ Создал семью "${name.trim()}".\n\n` +
      `📎 Перешли клиенту эту ссылку (14 дней, одноразовая):\n${link}\n\n` +
      `Когда они кликнут — они станут первым членом семьи. ` +
      `Дальше они могут писать боту в личке ИЛИ добавить бота в свою семейную Telegram-группу — ` +
      `всё попадёт в один и тот же бюджет.`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`❌ ${msg}`);
  }
}

/**
 * Handle a new user arriving via `/start invite_<code>` deep link.
 * Creates their user row, links them to the family, welcomes them.
 */
async function handleInviteArrival(ctx: Context, code: string): Promise<void> {
  const telegramId = ctx.from?.id;
  const name = ctx.from?.first_name || 'User';
  if (!telegramId) { await ctx.reply('⛔ Не могу определить твой Telegram ID.'); return; }

  const result = await consumeFamilyInvite(code, telegramId, name);
  if ('error' in result) {
    await ctx.reply(
      `❌ ${result.error}\n\nПопроси у админа семьи свежую ссылку-приглашение.`,
    );
    return;
  }

  // Success — brand new user (or idempotent re-tap).
  // Fetch the family's actual categories so the welcome reflects whatever was
  // auto-seeded at family creation (or whatever the user has since customized).
  const cats = await getCategoriesForFamily(result.familyId).catch(() => [] as Category[]);
  // No parse_mode: bot username + Russian text would trip the legacy Markdown
  // underscore-as-italic bug. Plain text is the most robust render path.
  await ctx.reply(buildWelcomeText(name, cats));
}

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Bot(token);

  // ── Text messages ──
  bot.on('message:text', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId) return;

    const rawText = ctx.message.text.trim();
    if (!rawText) return;

    // Phase 2: chat-based scope. The chat (DM or group) decides which family
    // these messages write to. We resolve the chat AFTER handling onboarding
    // paths (invite arrival, bare /start) because those create the user row
    // that the auto-link path depends on.
    const chatType = ctx.chat.type;  // 'private' | 'group' | 'supergroup' | 'channel'
    const isPrivate = chatType === 'private';
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    try {
      // Path 1: invite deep-link — only valid in private chat (Telegram only
      // delivers /start with a payload via the deep-link click, which always
      // opens a DM). Anyone can submit; no prior registration needed.
      const inviteCode = parseInvitePayload(rawText);
      if (inviteCode) {
        if (!isPrivate) return;  // ignore in groups — not a real flow
        await handleInviteArrival(ctx, inviteCode);
        return;
      }

      // Path 2: bare /start in DM — welcome for existing users, or invite gate.
      // In groups Telegram lets users type /start@bot but we don't treat it as
      // anything special; let it fall through to the normal flow.
      if (isPrivate && /^\/start(@\w+)?$/i.test(rawText)) {
        const existing = await getUserByTelegramId(telegramId);
        if (existing) {
          // Same welcome shape as handleInviteArrival, with the user's CURRENT
          // categories (which may differ from defaults if they've customized).
          const cats = await getCategoriesForFamily(existing.family_id).catch(() => [] as Category[]);
          await ctx.reply(buildWelcomeText(existing.name, cats));
        } else {
          await ctx.reply(
            '👋 Этот бот работает по приглашению.\n' +
            'Попроси у админа семьи ссылку вида `t.me/<имя_бота>?start=invite_XXX` — после клика тебя добавят автоматически.',
          );
        }
        return;
      }

      // Path 3: chat-based family resolution. This is the new central gate.
      //   - Existing chat → returns the linked family
      //   - DM from a registered user that hasn't been linked yet → auto-links
      //   - Group with a registered family member sending the first message
      //     → auto-links the group to their family
      //   - Anyone unregistered → 'unregistered_sender' error
      const resolved = await resolveFamilyForChat({
        chatId: ctx.chat.id,
        telegramId,
        chatType: chatType as 'private' | 'group' | 'supergroup' | 'channel',
      });

      if ('error' in resolved) {
        if (resolved.error === 'unregistered_sender') {
          // In DM: show the polite invite gate (existing behaviour).
          // In a group: silently ignore — strangers might be in the group with
          // the bot via a member who already left, and we don't want to spam
          // the group with "you need an invite" on every message.
          if (isPrivate) {
            await ctx.reply(
              '👋 Этот бот работает только по приглашению.\n' +
              'Попроси у админа семьи ссылку-приглашение.',
            );
          }
          return;
        }
        // Other errors (DB failure inserting the link, etc.) — log + bail
        // quietly in groups; surface in DM so the user knows something broke.
        await captureError(new Error(resolved.error), {
          source: 'webhook:resolveFamilyForChat',
          userTgId: telegramId,
          context: { chat_id: ctx.chat.id, chat_type: chatType },
        });
        if (isPrivate) await ctx.reply(`😔 ${resolved.error}`);
        return;
      }

      const { familyId, firstTimeInChat } = resolved;

      // First-time group link: confirm to the group so members know it's
      // wired up. We deliberately DON'T do this in DM because the welcome
      // message from handleInviteArrival already explains things, and a
      // backfilled DM (existing user pre-Phase 2) shouldn't suddenly get
      // a "linked!" message out of nowhere.
      if (firstTimeInChat && isGroup) {
        const fam = await getFamilyById(familyId).catch(() => null);
        const famName = fam?.name ?? 'вашей семьёй';
        await ctx.reply(
          `🔗 Связал эту группу с семьёй "${famName}". ` +
          `Любой участник может писать траты — всё попадёт в один и тот же бюджет.`,
        ).catch(() => { /* group might restrict bot replies — ignore */ });
        // Fall through and process the message itself too; the user might
        // already be writing "кофе 500" expecting the bot to log it.
      }

      // We still need the user row for the audit trail (userId on transactions
      // etc.). resolveFamilyForChat already validated the sender is registered
      // (otherwise we'd have hit the error branch above) — but in the
      // pre-existing-link case we never looked them up. Fetch now.
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        // Edge case: chat is linked to a family, but the sender isn't a
        // registered user. Could happen in a group when a non-member chats.
        // Silently ignore in groups; politely gate in DM (shouldn't happen).
        if (isPrivate) {
          await ctx.reply(
            '👋 Этот бот работает только по приглашению.\n' +
            'Попроси у админа семьи ссылку-приглашение.',
          );
        }
        return;
      }

      // Path 3.5: admin slash commands. These must be handled with the RAW
      // text because the clean-text strip below removes the leading /command.
      // /newfamily is the only admin command in Phase 2 — /invite was removed
      // because adding the bot to a group is the new way to share access.
      const newFamMatch = rawText.match(/^\/newfamily(?:@\w+)?(?:\s+(.+?))?\s*$/i);
      if (newFamMatch) {
        // Only the caller's identity matters — chat resolution above is fine.
        await handleNewFamilyCommand(ctx, newFamMatch[1] ?? null, user.id);
        return;
      }

      // Path 4: registered user → normal chat() flow
      const cleanText = rawText
        .replace(/@\w+/g, '')
        .replace(/^\/\w+\s*/, '')
        .trim();
      if (!cleanText) return;

      await ctx.replyWithChatAction('typing').catch(() => { /* groups can disallow */ });
      const userName = ctx.from?.first_name || user.name || 'User';
      const response = await chat(cleanText, telegramId, userName, ctx.chat.id, familyId);
      await sendChunked(ctx, response);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await captureError(error, {
        source: 'webhook:message',
        userTgId: telegramId,
        context: { text: rawText.slice(0, 200), chat_type: ctx.chat?.type },
      });
      // In groups, swallow user-facing error noise to avoid spamming the group
      // when something internal breaks. The error is captured server-side.
      if (isPrivate) {
        await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
      }
    }
  });

  // ── Callback queries (inline keyboard taps) ──
  bot.on('callback_query:data', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Phase 2: scope by the chat the keyboard lives in. The user might tap
    // a confirm button from a group's expense proposal; that confirm needs
    // to write to the group's linked family, not the user's personal family.
    const resolved = await resolveFamilyForChat({
      chatId: ctx.chat.id,
      telegramId,
      chatType: ctx.chat.type as 'private' | 'group' | 'supergroup' | 'channel',
    });
    if ('error' in resolved) {
      await ctx.answerCallbackQuery({ text: '⛔ Требуется приглашение' });
      return;
    }
    const { familyId } = resolved;

    // Still need the user row for the audit trail.
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCallbackQuery({ text: '⛔ Требуется приглашение' });
      return;
    }

    const data = ctx.callbackQuery.data;
    try {
      const userName = ctx.from?.first_name || user.name || 'User';
      const response = await handleCallback(data, telegramId, userName, ctx.chat.id, familyId);

      await ctx.answerCallbackQuery();
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* too old */ }
      await sendChunked(ctx, response);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      await captureError(error, {
        source: 'webhook:callback',
        userTgId: telegramId,
        context: { data: ctx.callbackQuery.data?.slice(0, 200) },
      });
      try { await ctx.answerCallbackQuery({ text: '😔 Ошибка' }); } catch { /* already answered */ }
      await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
    }
  });

  // ── my_chat_member: bot was added/removed from a chat ──
  // We don't auto-link here (we still need a registered family member to
  // send the first message — that's the canonical "claim this group for
  // family X" signal). But we log the events so we have visibility into
  // when groups appear/disappear, and we send a friendly nudge when the
  // bot is added to a group so members know what to do next.
  bot.on('my_chat_member', async (ctx) => {
    try {
      const update = ctx.myChatMember;
      const newStatus = update.new_chat_member.status;
      const oldStatus = update.old_chat_member.status;
      const chatType = ctx.chat.type;

      // Bot was just added to a group (status went from left/kicked → member/admin).
      const wasAbsent = oldStatus === 'left' || oldStatus === 'kicked';
      const nowPresent = newStatus === 'member' || newStatus === 'administrator';
      if (wasAbsent && nowPresent && (chatType === 'group' || chatType === 'supergroup')) {
        await ctx.reply(
          '👋 Привет! Я веду семейный бюджет.\n' +
          'Любой зарегистрированный член семьи может написать сюда первое сообщение — ' +
          'и я свяжу эту группу с вашим бюджетом. После этого все участники смогут писать траты.',
        ).catch(() => { /* might lack send permissions until promoted */ });
      }

      // Bot was kicked/removed — capture for visibility (no DB cleanup;
      // family_chats row stays so re-add Just Works).
      const wasPresent = oldStatus === 'member' || oldStatus === 'administrator';
      const nowAbsent = newStatus === 'left' || newStatus === 'kicked';
      if (wasPresent && nowAbsent) {
        await captureError(new Error('bot removed from chat'), {
          source: 'webhook:my_chat_member:removed',
          context: { chat_id: ctx.chat.id, chat_type: chatType, by_user: ctx.from?.id ?? null },
        });
      }
    } catch (error) {
      await captureError(error, { source: 'webhook:my_chat_member' });
    }
  });

  return bot;
}
