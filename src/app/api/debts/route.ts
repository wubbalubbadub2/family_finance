import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { supabase } from '@/lib/db/supabase';
import { DEFAULT_FAMILY_ID } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    // Scope by family_id so the dashboard (DEFAULT_FAMILY_ID) can only delete its own family's debts
    const { data, error } = await supabase
      .from('debts')
      .delete()
      .eq('id', id)
      .eq('family_id', DEFAULT_FAMILY_ID)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'debt not found in this family' }, { status: 404 });
    }

    revalidatePath('/');
    revalidatePath('/debts');
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
