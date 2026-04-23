import { Bot, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { chat, handleCallback, type BotResponse } from '@/lib/claude/agent';
import {
  consumeFamilyInvite,
  getUserByTelegramId,
  createFamily,
  createFamilyInvite,
} from '@/lib/db/queries';

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

function buildInviteLink(code: string): string {
  const handle = (process.env.TELEGRAM_BOT_HANDLE ?? 'FamilyBudgetBot').replace(/^@/, '');
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
    const link = buildInviteLink(invite.code);
    await ctx.reply(
      `✅ Создал семью *${name.trim()}*.\n\n` +
      `📎 Ссылка-приглашение (14 дней, одноразовая):\n${link}\n\n` +
      `Перешли её первому члену семьи. Когда они кликнут — их аккаунт добавится автоматически.`,
      { parse_mode: 'Markdown' },
    ).catch(() => ctx.reply(`Создал семью "${name.trim()}". Ссылка: ${link}`));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await ctx.reply(`❌ ${msg}`);
  }
}

/**
 * Admin command: generate an invite link for the CALLER's own family.
 * Adds a new member (spouse, kid, etc.) to the existing family.
 */
async function handleInviteCommand(ctx: Context, callerFamilyId: string, callerUserId: string): Promise<void> {
  try {
    const invite = await createFamilyInvite({
      family_id: callerFamilyId,
      created_by_user_id: callerUserId,
      uses: 1,
      expires_in_days: 14,
    });
    const link = buildInviteLink(invite.code);
    await ctx.reply(
      `📎 Ссылка для приглашения в твою семью (14 дней, одноразовая):\n${link}\n\n` +
      `Перешли тому, кого хочешь добавить. Они кликнут и автоматически присоединятся.`,
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

  // Success — brand new user (or idempotent re-tap)
  await ctx.reply(
    `👋 Привет, ${name}! Ты теперь в семейном боте.\n\n` +
    '**Первый шаг** — создай свои категории расходов. Напиши, например:\n\n' +
    '*"создай категории: Продукты 🛒, Транспорт 🚗, Кафе ☕, Жильё 🏠, Личное 🎯, Прочее 🎲"*\n\n' +
    'Бот предложит создать их все одной кнопкой ✅ Да.\n\n' +
    'После этого записывай траты: `кофе 500`, `такси 2500`, и т.д.',
    { parse_mode: 'Markdown' },
  ).catch(async () => {
    // Fall back to plain if Markdown parse fails
    await ctx.reply(`👋 Привет, ${name}! Ты теперь в семейном боте. Напиши "создай категории: Продукты 🛒, Транспорт 🚗, Кафе ☕" чтобы начать.`);
  });
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

    try {
      // Path 1: invite deep-link — anyone can submit, no prior registration needed
      const inviteCode = parseInvitePayload(rawText);
      if (inviteCode) {
        await handleInviteArrival(ctx, inviteCode);
        return;
      }

      // Path 2: bare /start — welcome message for existing users,
      // or "ask for invite" for strangers
      if (/^\/start(@\w+)?$/i.test(rawText)) {
        const existing = await getUserByTelegramId(telegramId);
        if (existing) {
          await ctx.reply(
            `👋 Привет, ${existing.name}! Записывай траты обычным текстом: *кофе 500*, ` +
            `или спрашивай: *сколько на чипсы?* · *покажи последние 10 трат*.`,
            { parse_mode: 'Markdown' },
          ).catch(() => ctx.reply(`👋 Привет, ${existing.name}!`));
        } else {
          await ctx.reply(
            '👋 Этот бот работает по приглашению.\n' +
            'Попроси у админа семьи ссылку вида `t.me/<имя_бота>?start=invite_XXX` — после клика тебя добавят автоматически.',
          );
        }
        return;
      }

      // Path 3: unknown users get a polite gate
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        await ctx.reply(
          '👋 Этот бот работает только по приглашению.\n' +
          'Попроси у админа семьи ссылку-приглашение.',
        );
        return;
      }

      // Path 3.5: admin slash commands that can't survive the clean-text strip.
      // These must be handled with the RAW text because the stripping logic
      // below removes the leading /command from what chat() ultimately sees.
      const newFamMatch = rawText.match(/^\/newfamily(?:@\w+)?(?:\s+(.+?))?\s*$/i);
      if (newFamMatch) {
        await handleNewFamilyCommand(ctx, newFamMatch[1] ?? null, user.id);
        return;
      }
      if (/^\/invite(?:@\w+)?\s*$/i.test(rawText)) {
        await handleInviteCommand(ctx, user.family_id, user.id);
        return;
      }

      // Path 4: registered user → normal chat() flow
      const cleanText = rawText
        .replace(/@\w+/g, '')
        .replace(/^\/\w+\s*/, '')
        .trim();
      if (!cleanText) return;

      await ctx.replyWithChatAction('typing');
      const userName = ctx.from?.first_name || user.name || 'User';
      const response = await chat(cleanText, telegramId, userName, ctx.chat.id);
      await sendChunked(ctx, response);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Bot error:', errMsg);
      await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
    }
  });

  // ── Callback queries (inline keyboard taps) ──
  bot.on('callback_query:data', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }

    // Unknown users can't have pending confirmations, so fail fast
    const user = await getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.answerCallbackQuery({ text: '⛔ Требуется приглашение' });
      return;
    }

    const data = ctx.callbackQuery.data;
    try {
      const userName = ctx.from?.first_name || user.name || 'User';
      const response = await handleCallback(data, telegramId, userName, ctx.chat.id);

      await ctx.answerCallbackQuery();
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* too old */ }
      await sendChunked(ctx, response);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Callback error:', errMsg);
      try { await ctx.answerCallbackQuery({ text: '😔 Ошибка' }); } catch { /* already answered */ }
      await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
    }
  });

  return bot;
}
