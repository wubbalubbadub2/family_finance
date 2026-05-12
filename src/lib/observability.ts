import { supabase } from './db/supabase';

// Truncation guards: Postgres TEXT has no hard limit, but a 50KB stack from a deep
// recursion will dominate the table. 4KB is enough to identify the call site.
const MAX_STACK = 4096;
const MAX_MSG = 2048;

// ───────────────────────────────────────────────────────────────────────────
// Critical-error admin alerts
//
// On 2026-05-11, Anthropic credits ran out at 12:15 UTC. The bot returned
// raw error replies to ~263 user attempts across 103 distinct customers
// over a ~12h window before the founder noticed. error_log was capturing
// every failure (we could reconstruct the damage after the fact), but no
// active alert fired — there was no monitoring layer that screamed when the
// shape of the error indicated "everything is broken right now, refill
// credits immediately."
//
// This module adds a thin alert layer on top of captureError: any error
// whose message matches a critical pattern triggers a Telegram DM to
// ADMIN_TG_ID (defaults to the founder). Dedup is per-pattern with a
// 10-minute in-memory window so a sustained outage produces ~one alert per
// cold-started lambda instance instead of 263. The dedup intentionally
// resets across cold starts — at worst we send a small handful of
// duplicates, which is vastly better than missing the next outage.
// ───────────────────────────────────────────────────────────────────────────

interface CriticalPattern {
  /** Dedup key. Reuses across messages that match the same pattern. */
  key: string;
  /** Regex applied against the error message text. */
  test: RegExp;
  /** Russian alert text DM'd to the admin. */
  alert: string;
}

const CRITICAL_PATTERNS: readonly CriticalPattern[] = [
  {
    key: 'anthropic:credit-balance',
    test: /credit balance is too low/i,
    alert:
      '🚨 КРИТИЧНО: закончились кредиты Anthropic. Бот сейчас падает на каждом запросе.\n\n' +
      'Пополнить: https://console.anthropic.com/settings/billing\n\n' +
      '(этот алерт повторится максимум раз в 10 мин, чтобы не спамить)',
  },
  {
    key: 'anthropic:invalid-key',
    test: /invalid x-api-key|authentication[_ ]failed|401[^\d]/i,
    alert:
      '🚨 КРИТИЧНО: Anthropic API ключ невалидный. ' +
      'Проверь ANTHROPIC_API_KEY в Vercel env vars.',
  },
  {
    // Anthropic returns HTTP 529 with `overloaded_error` when their platform
    // is under heavy load (entire-platform overload, not our account). Added
    // 2026-05-13 after a real outage: every webhook:message for ~10 min was
    // 529 and we had NO alert — only noticed when a user (Shynggys) reported
    // it. The alert says it's Anthropic-side so admin doesn't go hunting in
    // our code.
    key: 'anthropic:overloaded',
    test: /overloaded_error|529[^\d]/i,
    alert:
      '🚨 Anthropic перегружен (529 overloaded_error). ' +
      'Платформа Anthropic под нагрузкой, наши запросы отбиваются. ' +
      'Обычно восстанавливается за 5–30 минут.\n\n' +
      'Статус: https://status.anthropic.com',
  },
  {
    key: 'anthropic:rate-limit',
    test: /rate[_ ]limit_error|429[^\d]/i,
    alert:
      '⚠️ Anthropic rate-limit. Часть запросов пользователей сейчас падает. ' +
      'Подожди ~1 минуту, лимит сбросится сам.',
  },
];

/** Match a message against the critical-pattern catalogue. Pure, no side effects.
 *  Exported for tests. */
export function matchCriticalPattern(message: string): CriticalPattern | null {
  for (const pat of CRITICAL_PATTERNS) {
    if (pat.test.test(message)) return pat;
  }
  return null;
}

// Module-level dedup map. Resets on cold start — that's the design: at worst
// the admin gets one alert per warm-instance during a sustained outage.
const recentAlerts = new Map<string, number>();
const ALERT_DEDUP_MS = 10 * 60 * 1000;

async function notifyAdmin(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminTg = Number(process.env.ADMIN_TG_ID ?? 173826717);
  if (!token || !Number.isFinite(adminTg) || adminTg <= 0) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminTg, text }),
    });
  } catch (e) {
    // Network failure to Telegram is non-fatal. Don't recurse into captureError
    // — that way lies infinite loops if Telegram is the thing that's broken.
    console.error('[observability] notifyAdmin failed:', e instanceof Error ? e.message : String(e));
  }
}

function maybeAlertCritical(message: string): void {
  const pat = matchCriticalPattern(message);
  if (!pat) return;
  const last = recentAlerts.get(pat.key);
  if (last && Date.now() - last < ALERT_DEDUP_MS) return;
  recentAlerts.set(pat.key, Date.now());
  // Fire-and-forget. captureError itself is not awaited beyond the DB insert.
  void notifyAdmin(pat.alert);
}

export interface ErrorContext {
  source: string;                   // 'webhook' | 'cron:<name>' | 'agent:read-tool' | etc.
  familyId?: string | null;
  userTgId?: number | null;
  context?: Record<string, unknown>;
}

/**
 * Capture an error to both Vercel logs (console.error) and the Supabase error_log
 * table. Failure to persist is non-fatal — the console.error is the floor.
 *
 * Why both: Vercel logs are easy to lose (rolling retention, `vercel logs --since`
 * windows close, no aggregation). Supabase gives us a queryable history that
 * /health and the daily error-alert cron can read.
 */
export async function captureError(err: unknown, ctx: ErrorContext): Promise<void> {
  const isError = err instanceof Error;
  const message = (isError ? err.message : String(err)).slice(0, MAX_MSG);
  const stack = isError && err.stack ? err.stack.slice(0, MAX_STACK) : null;

  // Always log to Vercel — this is the floor. If the DB insert fails (DB outage,
  // RLS surprise, schema drift), we still see the error in Vercel logs.
  console.error(`[${ctx.source}]`, message, ctx.context ? JSON.stringify(ctx.context) : '');

  // Critical-pattern admin alert. Fire-and-forget; never blocks the DB insert.
  // See header comment for the 2026-05-11 outage that motivated this.
  maybeAlertCritical(message);

  try {
    await supabase.from('error_log').insert({
      source: ctx.source,
      family_id: ctx.familyId ?? null,
      user_tg_id: ctx.userTgId ?? null,
      message,
      stack,
      context: ctx.context ?? null,
    });
  } catch (insertErr) {
    // Don't recurse into captureError — that way lies infinite loops if Supabase
    // is the thing that's broken. Just plain console.error.
    console.error('[observability] failed to persist error_log row:', insertErr);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Bot action telemetry
//
// Companion to error_log: every bot action (chat call, cron nudge, etc.)
// inserts a row capturing latency, tools invoked, reply size, token usage.
// Privacy: shape data only, no raw user text or tool-call args.
// See supabase/migrations/017_bot_actions_log.sql.
// ───────────────────────────────────────────────────────────────────────────

export interface BotActionEntry {
  source: string;                            // 'chat' | 'cron:day1_nudge' | etc.
  familyId?: string | null;
  toolNames?: string[];                      // names only — no args
  iterations?: number;
  replyLength?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  meta?: Record<string, unknown>;
}

/**
 * Fire-and-forget bot-action log. Mirrors captureError's discipline:
 * console.error floor, DB insert is best-effort, never throws to caller.
 *
 * Caller should NOT await this for correctness. Tests can await for
 * determinism; production code uses `void logBotAction(...)`.
 */
export async function logBotAction(entry: BotActionEntry): Promise<void> {
  try {
    await supabase.from('bot_actions_log').insert({
      source: entry.source,
      family_id: entry.familyId ?? null,
      tool_names: entry.toolNames ?? null,
      iterations: entry.iterations ?? null,
      reply_length: entry.replyLength ?? null,
      latency_ms: entry.latencyMs ?? null,
      input_tokens: entry.inputTokens ?? null,
      output_tokens: entry.outputTokens ?? null,
      cache_read: entry.cacheRead ?? null,
      cache_write: entry.cacheWrite ?? null,
      meta: entry.meta ?? null,
    });
  } catch (e) {
    // Same rule as captureError: never recurse into observability if the
    // observability layer itself is the thing that's broken.
    console.error('[observability] logBotAction failed:', e instanceof Error ? e.message : String(e));
  }
}

export interface ErrorLogRow {
  id: number;
  occurred_at: string;
  source: string;
  family_id: string | null;
  user_tg_id: number | null;
  message: string;
  stack: string | null;
  context: Record<string, unknown> | null;
}

/**
 * Read recent errors. Used by /health admin command + daily alert cron.
 */
export async function getRecentErrors(args: {
  windowHours?: number;
  limit?: number;
  source?: string;
} = {}): Promise<ErrorLogRow[]> {
  const since = new Date(Date.now() - (args.windowHours ?? 24) * 3600_000).toISOString();
  let q = supabase
    .from('error_log')
    .select('*')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: false })
    .limit(args.limit ?? 100);
  if (args.source) q = q.eq('source', args.source);
  const { data } = await q;
  return data ?? [];
}

/**
 * Summarize error counts grouped by source over a window. Used to detect
 * anomalies (e.g. "20 webhook errors today vs 0 yesterday").
 */
export async function getErrorSummary(windowHours = 24): Promise<{ source: string; count: number; latest_message: string }[]> {
  const errors = await getRecentErrors({ windowHours, limit: 1000 });
  const buckets = new Map<string, { count: number; latest_message: string }>();
  for (const e of errors) {
    const b = buckets.get(e.source) ?? { count: 0, latest_message: e.message };
    b.count += 1;
    buckets.set(e.source, b);
  }
  return Array.from(buckets.entries())
    .map(([source, { count, latest_message }]) => ({ source, count, latest_message }))
    .sort((a, b) => b.count - a.count);
}
