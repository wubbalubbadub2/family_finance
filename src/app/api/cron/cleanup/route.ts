import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db/supabase';
import { cleanupStalePendingState } from '@/lib/db/queries';
import { captureError, getErrorSummary } from '@/lib/observability';

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

// Telegram ID of the admin who gets DM'd on error spikes. Currently hardcoded
// to Shynggys (resolved from the users table on initial seed). When we support
// multi-admin, move this to families.admin_telegram_ids or env.
const ADMIN_TG_ID = 173826717;

// If more than this many errors in the last 24h, DM admin.
const ERROR_ALERT_THRESHOLD = 5;

async function sendAdminDM(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ADMIN_TG_ID, text }),
    });
  } catch (e) {
    // Don't recurse into captureError — admin DM failure is itself an admin alert,
    // and we already log the full error_log on every cron tick.
    console.error('[cron/cleanup] admin DM failed:', e);
  }
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Delete conversation messages older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from('conversation_messages')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. Reset wedged wizards (pending_goal_step non-null for >24h).
  let stalePendingReset = 0;
  try {
    stalePendingReset = await cleanupStalePendingState(24);
  } catch (e) {
    await captureError(e, { source: 'cron:cleanup:pending' });
  }

  // 3. Delete error_log rows older than 90 days.
  let errorLogPurged = 0;
  try {
    const errCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { count: c } = await supabase
      .from('error_log')
      .delete({ count: 'exact' })
      .lt('occurred_at', errCutoff);
    errorLogPurged = c ?? 0;
  } catch (e) {
    await captureError(e, { source: 'cron:cleanup:error_log_purge' });
  }

  // 4. Error-spike alert. If anomalous activity in last 24h, DM admin with a
  //    summary by source. One DM/day max — this cron runs daily.
  let alertSent = false;
  try {
    const summary = await getErrorSummary(24);
    const total = summary.reduce((s, r) => s + r.count, 0);
    if (total > ERROR_ALERT_THRESHOLD) {
      const lines = summary
        .slice(0, 8)
        .map((r) => `• ${r.source} ×${r.count} — ${r.latest_message.slice(0, 80)}`);
      const text = `⚠️ Бот: ${total} ошибок за 24ч\n\n${lines.join('\n')}\n\nПроверь /health.`;
      await sendAdminDM(text);
      alertSent = true;
    }
  } catch (e) {
    await captureError(e, { source: 'cron:cleanup:error_alert' });
  }

  return NextResponse.json({
    ok: true,
    conversation_messages_deleted: count ?? 0,
    stale_pending_reset: stalePendingReset,
    error_log_purged: errorLogPurged,
    alert_sent: alertSent,
    cutoff,
  });
}
