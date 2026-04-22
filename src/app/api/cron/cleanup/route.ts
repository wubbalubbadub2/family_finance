import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db/supabase';
import { cleanupStalePendingState } from '@/lib/db/queries';

function verifyCron(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return authHeader === `Bearer ${process.env.CRON_SECRET}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 1. Delete conversation messages older than 7 days (unchanged)
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error, count } = await supabase
    .from('conversation_messages')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2. Reset wedged wizards (pending_goal_step non-null for >24h).
  //    Prevents "abandoned goal-setup" from blocking future /goal new calls.
  //    Non-fatal: if this fails, still return the conv cleanup result.
  let stalePendingReset = 0;
  try {
    stalePendingReset = await cleanupStalePendingState(24);
  } catch (e) {
    console.warn('[cron/cleanup] stale pending cleanup failed:', e);
  }

  return NextResponse.json({
    ok: true,
    conversation_messages_deleted: count ?? 0,
    stale_pending_reset: stalePendingReset,
    cutoff,
  });
}
