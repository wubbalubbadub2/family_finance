import { NextRequest, NextResponse } from 'next/server';
import { createBot } from '@/lib/bot/handlers';
import { webhookCallback } from 'grammy';
import { captureError } from '@/lib/observability';

// Allow up to 60 seconds for bot processing (Claude API + DB writes)
export const maxDuration = 60;

// Create handler once (reused across invocations in the same lambda)
let handler: ((req: Request) => Promise<Response>) | null = null;

function getHandler(): (req: Request) => Promise<Response> {
  if (!handler) {
    const bot = createBot();
    // grammy's default webhookCallback timeout is 10 seconds — too tight for our
    // pipeline once the DB is far from the function region. Each user message
    // triggers: getUserByTelegramId, getCategoriesForFamily, getRecentMessages,
    // saveMessage, plus 1-2 Anthropic API calls (~3-5s) and tool-driven DB
    // queries on top. Mumbai-Supabase ↔ US-East-Vercel round trip is ~250ms
    // per query, so 8-10 queries blow past 10s easily. We give grammy the full
    // Vercel maxDuration budget (60s) and rely on our own 45s loop deadline
    // inside agent.ts to short-circuit before Telegram itself times out.
    handler = webhookCallback(bot, 'std/http', { timeoutMilliseconds: 55_000 }) as (req: Request) => Promise<Response>;
  }
  return handler;
}

// Telegram includes this header on every webhook delivery when we configure
// `secret_token` via setWebhook. Without it, anyone who knows our public URL
// can POST a forged update with `from.id = <victim's Telegram ID>` and we'd
// trust it (the bot resolves family from from.id with no other auth). With it,
// only requests originating from Telegram (which holds our shared secret)
// reach the handler. Critical for paying users — see commit message.
const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function POST(req: NextRequest) {
  // Auth gate — verify Telegram's shared secret BEFORE doing anything else.
  // Constant-time compare not strictly necessary (the header value isn't
  // a credential the attacker can probe character-by-character) but cheap.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const provided = req.headers.get(TELEGRAM_SECRET_HEADER);
  if (!expected) {
    // Misconfigured: env var missing on this deployment. Fail loudly so we
    // notice — better than silently accepting forged updates.
    await captureError(new Error('TELEGRAM_WEBHOOK_SECRET not set on this deployment'), {
      source: 'webhook:auth:misconfigured',
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (provided !== expected) {
    await captureError(new Error('Webhook secret mismatch — likely forged request'), {
      source: 'webhook:auth:rejected',
      context: { provided_present: !!provided, ip: req.headers.get('x-forwarded-for') ?? null },
    });
    // 403 (not 200) so we get visibility on rejected attempts. Telegram's own
    // requests will never hit this branch — they always include the secret.
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  try {
    const callback = getHandler();
    return await callback(req);
  } catch (error) {
    // Outer catch — only fires if grammy itself throws (malformed update, etc).
    // Per-message handler errors are caught inside handlers.ts with captureError.
    await captureError(error, { source: 'webhook:route' });
    return NextResponse.json({ ok: true }); // 200 to Telegram so they don't retry-storm a malformed update
  }
}

// Telegram sends GET to verify webhook
export async function GET() {
  return NextResponse.json({ status: 'Bot webhook is active' });
}
