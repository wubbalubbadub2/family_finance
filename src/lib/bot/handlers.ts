import { Bot, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { chat, handleCallback, confirmKeyboard, type BotResponse } from '@/lib/claude/agent';
import {
  consumeFamilyInvite,
  getUserByTelegramId,
  createFamily,
  createFamilyInvite,
  resolveFamilyForChat,
  getOrCreateUserInFamily,
  getFamilyById,
  markUpdateSeen,
  setFamilyRemindersDisabled,
  setPendingConfirm,
  generateConfirmNonce,
  createFreshFamilyForExistingUser,
} from '@/lib/db/queries';
import { captureError } from '@/lib/observability';
import { enforcePaidStatus } from '@/lib/bot/paywall';

// Single support contact surfaced in error messages, so users always have a
// human to escalate to when the bot can't help itself. Removed from welcome
// messages — we want the welcome to push users into their first transaction,
// not into a support DM. They'll discover support via /help or via errors.
const SUPPORT_HANDLE = '@shynggys_islam';

/**
 * Map an API/internal error to a user-facing Russian reply. Avoids leaking
 * raw API JSON (e.g. `529 {"type":"error",…}`) into the user's chat — both
 * for UX and to not expose internal request_ids etc to end users.
 *
 * Added 2026-05-13 after Anthropic platform overload: users were seeing
 * `😔 Ошибка: 529 {"type":"error","error":{"type":"overloaded_error",…}}`
 * verbatim. Now they see a friendly "перегружен, попробуй через минуту"
 * instead. The original error_log row still captures the full detail for
 * post-incident debugging.
 */
function formatUserErrorReply(errMsg: string): string {
  if (/overloaded_error|529[^\d]/i.test(errMsg)) {
    return '😔 Сервис временно перегружен. Попробуй через 1-2 минуты.';
  }
  if (/rate[_ ]limit_error|429[^\d]/i.test(errMsg)) {
    return '⏳ Слишком много запросов сразу. Попробуй через минуту.';
  }
  if (/credit balance is too low|invalid x-api-key|authentication[_ ]failed|401[^\d]/i.test(errMsg)) {
    return `⚠️ Сервис временно недоступен. Если проблема не уйдёт — пиши ${SUPPORT_HANDLE}.`;
  }
  // Unknown error: friendly fallback, no raw API text leaked.
  return '😔 Что-то пошло не так. Попробуй переформулировать или подожди минуту.';
}

/**
 * Welcome for a brand-NEW user: just got onboarded into a fresh family.
 *
 * Concrete examples, zero abstraction. The earlier version included a
 * "Я помогу тебе разобраться с твоими финансами. Чем больше и чаще ты мне
 * пишешь, тем больше я буду приносить ценность" sentence which framed the
 * bot as homework with delayed payoff — exactly the engagement-farming tone
 * second-opinion review (Gemini + ChatGPT, 2026-05-10) flagged as an
 * activation killer. Three concrete examples covering expense / transport /
 * income demonstrate what the bot accepts, without making any claims the
 * user has to take on faith.
 */
export function buildWelcomeText(name: string): string {
  return (
    `Привет, ${name} 👋\n\n` +
    `Напиши свою трату — например:\n` +
    `  • кофе 500\n` +
    `  • такси 2300\n` +
    `  • зарплата 500 000\n\n` +
    `🔒 /приватность — как мы работаем с твоими данными`
  );
}

// Static response for /приватность slash command. Trust-foundation copy:
// honest about what we do (cohort analytics with usernames internally, no
// third-party sharing), what we don't (no advertising use). No vendor
// names — users care about the practice, not the provider stack.
export const PRIVACY_TEXT =
  `🔒 Как мы работаем с твоими данными:\n\n` +
  `📊 Аналитика — обобщённая по группам пользователей. Имена не передаются третьим лицам и не используются для рекламы.\n\n` +
  `🔧 Конкретные логи — только при расследовании багов или если ты сама обратишься за поддержкой.\n\n` +
  `🛡️ Хранение — в зашифрованной базе данных. Не передаём третьим лицам.\n\n` +
  `✂️ Удалить всё — /удалить_все\n\n` +
  `💬 Вопросы — @sabina_amangeldi`;

/**
 * Welcome-back for an EXISTING user re-tapping /start. One line, no name —
 * the user knows who they are. Just nudges them back to the action.
 */
export function buildWelcomeBackText(): string {
  return `Рад тебя снова видеть! Продолжай активно писать свои траты - например, «кофе 500».`;
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

  const result = await consumeFamilyInvite(code, telegramId, name, ctx.from?.username ?? null);
  if ('error' in result) {
    await ctx.reply(
      `❌ ${result.error}\n\nПопроси у админа семьи свежую ссылку-приглашение.`,
    );
    return;
  }

  // Success — brand new user (or idempotent re-tap).
  // No parse_mode: bot username + Russian text would trip the legacy Markdown
  // underscore-as-italic bug. Plain text is the most robust render path.
  await ctx.reply(buildWelcomeText(name));
}

/**
 * Onboard a fresh DM user with no prior registration: spin up a new family
 * (using their Telegram first_name), insert their user row, welcome them.
 * Used by the bare-/start path and also when an unregistered user sends any
 * first message in DM. The 3-day trial is set inside createFamily.
 *
 * Idempotent: callers should check the user doesn't already exist before
 * invoking this — but if a race creates a duplicate user row, the unique
 * constraint on telegram_id will surface it as an error and the second
 * attempt will hit the existing-user path on retry.
 */
async function onboardFreshDmUser(ctx: Context): Promise<void> {
  const telegramId = ctx.from?.id;
  const name = ctx.from?.first_name || 'User';
  if (!telegramId) {
    await ctx.reply(`⛔ Не могу определить твой Telegram ID. Напиши ${SUPPORT_HANDLE}.`);
    return;
  }

  let familyId: string;
  try {
    familyId = await createFamily(`${name}'s family`);
  } catch (e) {
    await captureError(e, { source: 'onboardFreshDmUser:createFamily', userTgId: telegramId });
    await ctx.reply(`😔 Не удалось создать семью. Попробуй ещё раз через минуту, или напиши ${SUPPORT_HANDLE}.`);
    return;
  }

  const userRes = await getOrCreateUserInFamily(telegramId, familyId, name, ctx.from?.username ?? null);
  if ('error' in userRes) {
    // Most common cause: this Telegram account already exists in another
    // family (e.g. user tapped a link on a wrong account, or admin manually
    // moved them). The user can't fix this themselves — escalate to support.
    await captureError(new Error(userRes.error), {
      source: 'onboardFreshDmUser:getOrCreateUser', userTgId: telegramId,
    });
    await ctx.reply(
      `😔 Не получилось добавить тебя в семью.\n\n` +
      `Возможно, ты уже зарегистрирован в другой семье. ` +
      `Напиши ${SUPPORT_HANDLE} — он разберётся.`,
    );
    return;
  }

  await ctx.reply(buildWelcomeText(name));
}

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Bot(token);

  // ── Idempotency: drop Telegram retries before any handler runs ──
  // Telegram retries on 5xx/timeout with the same update_id. Without this gate,
  // a slow Sonnet call that the webhook times out on would get the user's
  // expense logged twice. We mark each update_id in the DB; PRIMARY KEY
  // collision = retry, drop it. Fail-open if the DB is unreachable.
  bot.use(async (ctx, next) => {
    const updateId = ctx.update.update_id;
    if (typeof updateId !== 'number') return next();
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? 0;
    const messageId = ctx.msg?.message_id ?? null;
    const { alreadyProcessed } = await markUpdateSeen(updateId, chatId, messageId);
    if (alreadyProcessed) {
      console.log(`[idempotency] dropped retry update_id=${updateId} chat=${chatId}`);
      return;
    }
    return next();
  });

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

      // Path 2: bare /start in DM. Existing users get a welcome with their
      // current categories. NEW users (never seen before) auto-onboard into
      // a fresh family with a 3-day trial — no invite code needed. This is
      // the public-link entry point: just `t.me/<bot>` works, no payload.
      // In groups we ignore /start@bot specifically (let it fall through).
      if (isPrivate && /^\/start(@\w+)?$/i.test(rawText)) {
        const existing = await getUserByTelegramId(telegramId);
        if (existing) {
          await ctx.reply(buildWelcomeBackText());
        } else {
          await onboardFreshDmUser(ctx);
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
          // DM from someone we've never seen — onboard them into a fresh
          // family with a 3-day trial. They typed something other than /start
          // (e.g. "кофе 500" right out of the gate); we welcome them rather
          // than processing the message, because the welcome is more useful
          // than a guessed transaction. They can re-send after.
          //
          // In a group: silently ignore. Strangers might be in the group via
          // a member who already left; we don't auto-onboard random group
          // participants into new solo families.
          if (isPrivate) {
            await onboardFreshDmUser(ctx);
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

      // Wiped-family gate (migration 019). If the family has been soft-wiped
      // via /удалить_все, the bot ignores all messages except /start. On
      // /start, we spawn a fresh family for the user and re-link the chat.
      // Runs BEFORE paywall so wiped families don't see paywall messages.
      const familyRecord = await getFamilyById(familyId).catch(() => null);
      if (familyRecord?.deleted_at) {
        if (/^\/start(@\w+)?$/i.test(rawText.trim())) {
          try {
            const newFamilyId = await createFreshFamilyForExistingUser(telegramId, ctx.chat.id);
            const name = ctx.from?.first_name || 'друг';
            await ctx.reply(buildWelcomeText(name)).catch(() => {});
            console.error(`[wiped-family-restart] user=${telegramId} old=${familyId} new=${newFamilyId}`);
          } catch (e) {
            await captureError(e, { source: 'webhook:wipe-restart', userTgId: telegramId, familyId });
            await ctx.reply(formatUserErrorReply(e instanceof Error ? e.message : String(e))).catch(() => {});
          }
        } else {
          await ctx.reply('Твои данные были удалены ранее. Напиши /start чтобы начать заново.').catch(() => {});
        }
        return;
      }

      // Trial / paid gate. Sits before the firstTimeInChat confirmation so an
      // expired family doesn't get "🔗 linked!" followed immediately by the
      // paywall message. Invite redemption (path 1) and bare /start (path 2)
      // already returned above — they bypass the gate intentionally.
      const paid = await enforcePaidStatus(ctx, familyId, { isGroup });
      if (!paid.allowed) return;

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

      // We need the user row for transaction audit (logged_by). Per the doc's
      // group security stance, anyone writing in a bound group is authorized
      // to log into that family — auto-register them on first sight rather
      // than silently ignoring (real bug 2026-05-01: bot ignored every group
      // member except the original linker).
      // In DMs the chat link IS the user record, so this just looks them up;
      // in groups it auto-creates a user row when a new member first chats.
      const senderName = ctx.from?.first_name || 'User';
      const userResult = await getOrCreateUserInFamily(telegramId, familyId, senderName, ctx.from?.username ?? null);
      if ('error' in userResult) {
        if (isPrivate) {
          await ctx.reply(`😔 ${userResult.error}`);
        }
        return;
      }
      const user = { id: userResult.id, family_id: userResult.family_id, name: senderName };

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

      // /напоминания on|off — toggles the Day-1 re-engagement nudge for this
      // family. Stored on families.reminders_disabled (migration 018). The
      // cron also auto-flips this to TRUE if the user blocks the bot, so any
      // /напоминания on after a block is a "re-opt-in" the user is explicitly
      // making.
      const remindersMatch = rawText.match(/^\/напоминания(?:@\w+)?(?:\s+(on|off))?\s*$/i);
      if (remindersMatch) {
        const arg = (remindersMatch[1] ?? '').toLowerCase();
        if (arg === 'off') {
          await setFamilyRemindersDisabled(familyId, true).catch(() => {});
          await ctx.reply('🔕 Напоминания отключены. Передумаешь — напиши `/напоминания on`.', { parse_mode: 'Markdown' }).catch(() => {});
        } else if (arg === 'on') {
          await setFamilyRemindersDisabled(familyId, false).catch(() => {});
          await ctx.reply('🔔 Напоминания включены. Буду писать вечером, если за день не залогируешь ни одной траты.').catch(() => {});
        } else {
          await ctx.reply('Используй `/напоминания on` или `/напоминания off`.', { parse_mode: 'Markdown' }).catch(() => {});
        }
        return;
      }

      // /приватность — static response describing data handling. Trust
      // foundation surfaced in the welcome message; sends users here to
      // read it on demand.
      const privacyMatch = rawText.match(/^\/приватность(?:@\w+)?\s*$/i);
      if (privacyMatch) {
        await ctx.reply(PRIVACY_TEXT).catch(() => {});
        return;
      }

      // /удалить_все — two-tap soft-delete of the family. Wires through
      // existing pending_confirm flow. The actual wipe runs in
      // executeConfirmedAction via wipeFamilyData() when the user taps
      // ✅ Да.
      const wipeMatch = rawText.match(/^\/удалить_все(?:@\w+)?\s*$/i);
      if (wipeMatch) {
        const nonce = generateConfirmNonce();
        await setPendingConfirm(familyId, {
          nonce,
          type: 'soft_wipe_family',
          args: {},
        });
        await ctx.reply(
          `⚠️ Удалить все твои данные?\n\n` +
          `Бот забудет:\n` +
          `• Все транзакции и доходы\n` +
          `• Все категории, лимиты и цели\n` +
          `• Все записанные долги\n` +
          `• Все сообщения с ботом\n\n` +
          `Если передумаешь — напиши /start чтобы начать заново.\n\n` +
          `Точно?`,
          { reply_markup: { inline_keyboard: confirmKeyboard(nonce) } },
        ).catch(() => {});
        return;
      }

      // Path 4: registered user → normal chat() flow.
      //
      // Slash commands from the Telegram menu (BotFather /setcommands) arrive
      // here as "/summary", "/help", etc. with no payload. Stripping the
      // leading slash-word leaves an empty string and we'd silently no-op,
      // which is exactly what happened to /summary, /help, /categories on the
      // dev bot's first menu test. Map known menu commands to natural-Russian
      // phrases that Sonnet already handles well — verified by user that
      // "итоги месяца" / "мои категории" / "что умеет бот" produce correct
      // replies. Unknown bare slash commands still no-op, which is fine.
      const SLASH_COMMAND_TO_NL: Record<string, string> = {
        summary: 'итоги месяца',
        categories: 'мои категории',
        help: 'что умеет бот',
      };

      let cleanText = rawText
        .replace(/@\w+/g, '')
        .replace(/^\/\w+\s*/, '')
        .trim();

      if (!cleanText) {
        const slashMatch = rawText.trim().match(/^\/(\w+)/);
        const cmd = slashMatch?.[1].toLowerCase();
        if (cmd && SLASH_COMMAND_TO_NL[cmd]) {
          cleanText = SLASH_COMMAND_TO_NL[cmd];
        } else {
          return; // Unknown bare slash command — silent no-op
        }
      }

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
        await ctx.reply(formatUserErrorReply(errMsg));
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

    // Wiped-family gate. If the user taps an old inline button after
    // /удалить_все, the family record has deleted_at set. Short-circuit
    // with a toast — don't try to process the confirm/cancel.
    const cbFamily = await getFamilyById(familyId).catch(() => null);
    if (cbFamily?.deleted_at) {
      await ctx.answerCallbackQuery({ text: 'Данные удалены. /start чтобы начать заново' }).catch(() => undefined);
      return;
    }

    // Trial / paid gate. answerCallbackQuery first so the user sees the
    // toast, then enforcePaidStatus sends the paywall reply (rate-limited).
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const paid = await enforcePaidStatus(ctx, familyId, { isGroup });
    if (!paid.allowed) {
      await ctx.answerCallbackQuery({ text: '⏸ Подписка приостановлена' }).catch(() => undefined);
      return;
    }

    // Auto-register the tapper if they're a new group member (same logic
    // as the message handler — chat_id is the trust boundary).
    const senderName = ctx.from?.first_name || 'User';
    const userResult = await getOrCreateUserInFamily(telegramId, familyId, senderName);
    if ('error' in userResult) {
      await ctx.answerCallbackQuery({ text: '⛔ Требуется приглашение' });
      return;
    }

    const data = ctx.callbackQuery.data;
    try {
      const userName = senderName;
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
      await ctx.reply(formatUserErrorReply(errMsg));
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
