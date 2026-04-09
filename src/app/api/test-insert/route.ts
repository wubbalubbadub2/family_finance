import { NextResponse } from 'next/server';
import { supabase } from '@/lib/db/supabase';

export const dynamic = 'force-dynamic';

// Diagnostic: insert a test row and immediately verify it exists
export async function GET() {
  const testId = crypto.randomUUID();
  const results: string[] = [];

  try {
    // 1. Insert
    const { data: inserted, error: insertErr } = await supabase
      .from('transactions')
      .insert({
        id: testId,
        user_id: 'a8bee830-b133-4f27-afe9-eba877157287', // Shynggys
        category_id: 2, // Продукты
        type: 'expense',
        amount: 1,
        comment: 'TEST_DELETE_ME',
        source: 'web',
        transaction_date: '2026-04-09',
      })
      .select()
      .single();

    if (insertErr) {
      results.push(`INSERT FAILED: ${insertErr.message}`);
      return NextResponse.json({ results });
    }
    results.push(`INSERT OK: id=${inserted.id}, amount=${inserted.amount}`);

    // 2. Verify immediately
    const { data: verify1, error: verifyErr1 } = await supabase
      .from('transactions')
      .select('id, amount, comment')
      .eq('id', testId)
      .single();

    results.push(verifyErr1
      ? `VERIFY-1 FAILED: ${verifyErr1.message}`
      : `VERIFY-1 OK: id=${verify1.id}`
    );

    // 3. Wait 1 second and verify again
    await new Promise(r => setTimeout(r, 1000));
    const { data: verify2, error: verifyErr2 } = await supabase
      .from('transactions')
      .select('id, amount, comment')
      .eq('id', testId)
      .single();

    results.push(verifyErr2
      ? `VERIFY-2 (1s later) FAILED: ${verifyErr2.message}`
      : `VERIFY-2 (1s later) OK: id=${verify2.id}`
    );

    // 4. Clean up - soft delete
    await supabase
      .from('transactions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', testId);

    results.push('CLEANUP: soft deleted');

  } catch (e) {
    results.push(`EXCEPTION: ${e instanceof Error ? e.message : String(e)}`);
  }

  return NextResponse.json({ results });
}
