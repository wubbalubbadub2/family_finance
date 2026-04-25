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
    handler = webhookCallback(bot, 'std/http') as (req: Request) => Promise<Response>;
  }
  return handler;
}

export async function POST(req: NextRequest) {
  try {
    const callback = getHandler();
    return await callback(req);
  } catch (error) {
    // Outer catch — only fires if grammy itself throws (malformed update, etc).
    // Per-message handler errors are caught inside handlers.ts with captureError.
    await captureError(error, { source: 'webhook:route' });
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram
  }
}

// Telegram sends GET to verify webhook
export async function GET() {
  return NextResponse.json({ status: 'Bot webhook is active' });
}
