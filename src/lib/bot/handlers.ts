import { Bot } from 'grammy';
import { chat } from '@/lib/claude/agent';

const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS ?? '')
  .split(',')
  .map(id => parseInt(id.trim(), 10))
  .filter(Boolean);

export function createBot(): Bot {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');

  const bot = new Bot(token);

  // Handle all text messages (DM + group)
  bot.on('message:text', async (ctx) => {
    const telegramId = ctx.from?.id;
    if (!telegramId || !ALLOWED_IDS.includes(telegramId)) return;

    const text = ctx.message.text.trim();
    if (!text) return;

    // Strip bot @mentions and /command prefix for clean input to Claude
    const cleanText = text
      .replace(/@\w+/g, '')
      .replace(/^\/\w+\s*/, '')
      .trim();
    if (!cleanText) return;

    try {
      await ctx.replyWithChatAction('typing');
      const userName = ctx.from.first_name || 'User';
      const response = await chat(cleanText, telegramId, userName, ctx.chat.id);

      const send = async (msg: string) => {
        try {
          await ctx.reply(msg, { parse_mode: 'Markdown' });
        } catch {
          await ctx.reply(msg);
        }
      };
      if (response.length > 4000) {
        const parts = response.match(/[\s\S]{1,4000}/g) ?? [response];
        for (const part of parts) await send(part);
      } else {
        await send(response);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('Bot error:', errMsg);
      await ctx.reply(`😔 Ошибка: ${errMsg.slice(0, 200)}`);
    }
  });

  return bot;
}
