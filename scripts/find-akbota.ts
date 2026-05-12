// Find Akbota on prod by name and handle.
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

  // Try name + username matches
  const { data: byName } = await sb
    .from('users')
    .select('id, telegram_id, telegram_username, name, family_id, created_at')
    .or('name.ilike.%Akbota%,name.ilike.%Акбота%')
    .order('created_at', { ascending: false });

  const { data: byHandle } = await sb
    .from('users')
    .select('id, telegram_id, telegram_username, name, family_id, created_at')
    .or('telegram_username.ilike.%akbota%,telegram_username.ilike.%akb%')
    .order('created_at', { ascending: false });

  type UserRow = { id: string; telegram_id: number; telegram_username: string | null; name: string; family_id: string; created_at: string };
  const all = new Map<string, UserRow>();
  for (const u of (byName ?? [])) all.set(u.id, u);
  for (const u of (byHandle ?? [])) all.set(u.id, u);

  console.log(`Found ${all.size} candidate user(s):`);
  for (const u of all.values()) {
    const { data: fam } = await sb.from('families').select('name, paid_until, reminders_disabled').eq('id', u.family_id).single();
    const { data: chats } = await sb.from('family_chats').select('chat_id, chat_type').eq('family_id', u.family_id);
    const priv = chats?.find(c => c.chat_type === 'private');
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Almaty' });
    const { count: lifetime } = await sb.from('transactions').select('id', { count: 'exact', head: true }).eq('family_id', u.family_id).is('deleted_at', null);
    const { count: todayCount } = await sb.from('transactions').select('id', { count: 'exact', head: true }).eq('family_id', u.family_id).is('deleted_at', null).eq('transaction_date', today);
    console.log();
    console.log(`  ${u.name} @${u.telegram_username ?? '-'} (tg=${u.telegram_id})`);
    console.log(`    family: ${fam?.name} (${u.family_id})`);
    console.log(`    paid_until=${fam?.paid_until?.slice(0,10)} reminders_disabled=${fam?.reminders_disabled}`);
    console.log(`    chats: ${chats?.length ?? 0}, private chat_id=${priv?.chat_id ?? '-'}`);
    console.log(`    tx lifetime=${lifetime}  today=${todayCount}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });

export {};
