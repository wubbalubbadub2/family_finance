import { Bot, type Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { chat, handleCallback, type BotResponse } from '@/lib/claude/agent';

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS ?? '')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

function isAllowed(telegramId: number | undefined): boolean {
  if (!telegramId) return false;
  // Allowlist is OR-based: either the env-configured global allowlist,
  // or any user in the users table (lookup happens inside chat()).
  // For now the env list is the only gate — chat() also rejects unknown users.
  if (ALLOWED_IDS.length === 0) return true;  // no allowlist configured → anyone passes the env gate
  return ALLOWED_IDS.includes(telegramId);
}

async function sendResponse(ctx: Context, response: BotResponse) {
  const replyOpts: {
    parse_mode?: 'Markdown';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  } = {};
  if (response.keyboard && response.keyboard.length > 0) {
    replyOpts.reply_markup = { inline_keyboard: response.keyboard };
  }

  // Try Markdown first; fall back to plain text if Telegram rejects the markup
  // (common when user comments contain unbalanced *, _, [, etc.)
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
  // Telegram max message is 4096 chars. Split conservatively, put the
  // keyboard on the FINAL chunk only so the user doesn't see a button
  // mid-stream.
  const parts = response.text.match(/[\s\S]{1,4000}/g) ?? [response.text];
  for (let i = 0; i < parts.length - 1; i++) {
    await sendResponse(ctx, { text: parts[i] });
  }
  await sendResponse(ctx, { text: parts[parts.length - 1], keyboard: response.keyboard });
}

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Bot(token);

  // ── Text messages ──
  bot.on('message:text', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!isAllowed(telegramId)) return;
    if (!telegramId) return;

    const text = ctx.message.text.trim();
    if (!text) return;

    const cleanText = text
      .replace(/@\w+/g, '')
      .replace(/^\/\w+\s*/, '')
      .trim();
    if (!cleanText) return;

    try {
      await ctx.replyWithChatAction('typing');
      const userName = ctx.from?.first_name || 'User';
      const response = await chat(cleanText, telegramId, userName, ctx.chat.id);
      await sendChunked(ctx, response);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Bot error:', errMsg);
      await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
    }
  });

  // ── Callback queries (inline keyboard taps: ✅ Да / ❌ Отмена) ──
  bot.on('callback_query:data', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!isAllowed(telegramId)) {
      await ctx.answerCallbackQuery({ text: '⛔ Доступ запрещён' });
      return;
    }
    if (!telegramId || !ctx.chat) {
      await ctx.answerCallbackQuery();
      return;
    }

    const data = ctx.callbackQuery.data;
    try {
      const userName = ctx.from?.first_name || 'User';
      const response = await handleCallback(data, telegramId, userName, ctx.chat.id);

      // Acknowledge the tap (clears the spinner on the button)
      await ctx.answerCallbackQuery();
      // Remove the buttons from the original message so the user can't re-tap
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }); } catch { /* message may be too old to edit */ }
      // Send the result as a new message
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
