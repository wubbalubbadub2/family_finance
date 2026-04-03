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

    // In groups, only respond if bot is mentioned or message starts with /
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    if (isGroup) {
      const botInfo = await bot.api.getMe();
      const botUsername = botInfo.username ?? '';
      const isMentioned = text.includes(`@${botUsername}`);
      const isReply = ctx.message.reply_to_message?.from?.id === botInfo.id;
      const isCommand = text.startsWith('/');

      if (!isMentioned && !isReply && !isCommand) return;
    }

    // Strip bot mention from text
    const cleanText = text.replace(/@\w+/g, '').trim();
    if (!cleanText) return;

    try {
      await ctx.replyWithChatAction('typing');
      const userName = ctx.from.first_name || 'User';
      const response = await chat(cleanText, telegramId, userName, ctx.chat.id);

      // Split long messages (Telegram limit is 4096)
      if (response.length > 4000) {
        const parts = response.match(/[\s\S]{1,4000}/g) ?? [response];
        for (const part of parts) {
          await ctx.reply(part, { parse_mode: 'Markdown' });
        }
      } else {
        await ctx.reply(response, { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('Bot error:', error);
      await ctx.reply('😔 Произошла ошибка. Попробуйте ещё раз.');
    }
  });

  return bot;
}
