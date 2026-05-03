// Trial / paid gate for the bot. Imported by handlers.ts at the two places we
// know the family but haven't yet handed off to business logic / Sonnet.
//
// Hard cutoff at expiry: bot refuses ALL messages with a paywall reply.
// Group vs DM messages are different (groups omit the family name for privacy
// — anyone in the group can see it). Per-chat 24h rate limit prevents a chatty
// group from looping the paywall message on every member's reply.

import type { Context } from 'grammy';
import { getPaidStatus } from '@/lib/db/queries';

export type PaidStatus =
  | { allowed: true }
  | { allowed: false; paidUntil: Date; daysExpired: number; familyName: string };

export async function checkPaidStatus(familyId: string): Promise<PaidStatus> {
  const row = await getPaidStatus(familyId);
  if (!row) {
    // Missing row = treat as blocked (safest). Should be impossible since the
    // caller resolved the family, but defensive.
    return { allowed: false, paidUntil: new Date(0), daysExpired: 0, familyName: '?' };
  }
  const now = Date.now();
  const exp = row.paidUntil.getTime();
  if (exp > now) return { allowed: true };
  const daysExpired = Math.floor((now - exp) / (24 * 60 * 60 * 1000));
  return { allowed: false, paidUntil: row.paidUntil, daysExpired, familyName: row.familyName };
}

// Per-chat rate limit. Keeps a chatty group from receiving the paywall on every
// member's reply. In-memory; resets on Vercel cold start. At most one extra
// duplicate per cold start per chat — acceptable.
const PAYWALL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const lastPaywallSentAt = new Map<number, number>();

function shouldSend(chatId: number): boolean {
  const last = lastPaywallSentAt.get(chatId);
  if (last !== undefined && Date.now() - last < PAYWALL_COOLDOWN_MS) return false;
  lastPaywallSentAt.set(chatId, Date.now());
  return true;
}

const ADMIN_HANDLE = '@shynggys_islam';

function pluralizeDays(n: number): string {
  // Russian plural: 1 день, 2-4 дня, 5+ дней. Numbers 11-19 are "дней" regardless.
  const tens = Math.abs(n) % 100;
  const ones = n % 10;
  if (tens >= 11 && tens <= 19) return 'дней';
  if (ones === 1) return 'день';
  if (ones >= 2 && ones <= 4) return 'дня';
  return 'дней';
}

function buildPaywallMessage(opts: {
  isGroup: boolean;
  familyName: string;
  daysExpired: number;
}): string {
  if (opts.isGroup) {
    // Privacy: anyone in the group can see this. No family name, no expiry math.
    return `⏸ Семейный бюджет приостановлен. Свяжитесь с администратором: ${ADMIN_HANDLE}`;
  }
  // DM — full context for the paying customer.
  const days = opts.daysExpired;
  const ago = days <= 0 ? 'сегодня' : `${days} ${pluralizeDays(days)} назад`;
  return (
    `⏸ Подписка семьи "${opts.familyName}" истекла ${ago}.\n\n` +
    `Чтобы продолжить пользоваться ботом, оплатите доступ и напишите ${ADMIN_HANDLE} со скриншотом — он продлит подписку.`
  );
}

/**
 * Gate helper. Call after the family is resolved. If allowed, returns immediately.
 * If blocked, sends the paywall message (rate-limited per chat) and returns the
 * status so the caller can `return` and skip business logic.
 */
export async function enforcePaidStatus(
  ctx: Context,
  familyId: string,
  opts: { isGroup: boolean },
): Promise<PaidStatus> {
  const status = await checkPaidStatus(familyId);
  if (status.allowed) return status;

  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    // Structured log for observability — Vercel logs are queryable. Always log
    // every block (not gated by rate limit) so we can see real frequency.
    console.log(
      JSON.stringify({
        event: 'paywall_block',
        family_id: familyId,
        family_name: status.familyName,
        paid_until: status.paidUntil.toISOString(),
        days_expired: status.daysExpired,
        chat_id: chatId,
        is_group: opts.isGroup,
      }),
    );

    if (shouldSend(chatId)) {
      const text = buildPaywallMessage({
        isGroup: opts.isGroup,
        familyName: status.familyName,
        daysExpired: status.daysExpired,
      });
      // .catch() because groups can restrict bot replies; missing the paywall is
      // not worth crashing over.
      await ctx.reply(text).catch(() => undefined);
    }
  }

  return status;
}
