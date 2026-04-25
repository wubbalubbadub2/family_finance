import { supabase } from './db/supabase';

// Truncation guards: Postgres TEXT has no hard limit, but a 50KB stack from a deep
// recursion will dominate the table. 4KB is enough to identify the call site.
const MAX_STACK = 4096;
const MAX_MSG = 2048;

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
