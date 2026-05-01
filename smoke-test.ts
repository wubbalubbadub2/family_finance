// End-to-end smoke test against the DEV DB. Creates a fresh family,
// then drives chat() through every regression case we've hit so far.
// Reports pass/fail per scenario and prints a summary.
//
// Usage: node --import tsx --env-file .env.dev.local smoke-test.ts
//
// IMPORTANT: load .env.dev.local ONLY — never .env.local. Loading both
// causes .env.local's SUPABASE_URL (which points at PROD for Next.js dev
// mode) to override the dev URL. On 2026-05-01 this misconfig caused the
// smoke test to write Smoke Family rows to PROD. We now hard-fail with a
// safety check below if SUPABASE_URL doesn't look like the dev project.
//
// Each scenario is single-turn (or sets up history then sends one turn).
// Multi-turn flows are simulated by inserting into conversation_messages
// before the call so chat()'s history fetch sees them.

import { createClient } from '@supabase/supabase-js';
import { chat } from './src/lib/claude/agent';

// Dev project ref — any other URL means we're about to write to the wrong DB.
const DEV_PROJECT_REF = 'rcpuvqjrtxyuvmnjandm';
const TG_ID = 9999990001; // synthetic — never collides with real users
const CHAT_ID = TG_ID;
const NAME = 'Smoke Tester';

const supabaseUrl = process.env.SUPABASE_URL ?? '';
if (!supabaseUrl.includes(DEV_PROJECT_REF)) {
  console.error(`SAFETY CHECK FAILED: SUPABASE_URL=${supabaseUrl}`);
  console.error(`Expected to contain "${DEV_PROJECT_REF}" (dev project).`);
  console.error('Refusing to run — load .env.dev.local ONLY (no .env.local).');
  process.exit(2);
}

const sb = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_KEY!);

interface Result {
  name: string;
  ok: boolean;
  detail?: string;
  reply?: string;
}
const results: Result[] = [];

async function setup() {
  console.log('▸ Wiping any prior smoke-test state…');
  // Find user
  const { data: u } = await sb.from('users').select('id, family_id').eq('telegram_id', TG_ID).maybeSingle();
  if (u?.family_id) {
    const fid = u.family_id;
    const tables = [
      'family_chats', 'conversation_messages', 'goal_contributions', 'goals',
      'category_overrides', 'debts', 'transactions', 'monthly_plans',
      'categories', 'family_invites', 'users',
    ];
    for (const t of tables) {
      await sb.from(t).delete().eq('family_id', fid);
    }
    await sb.from('family_chats').delete().eq('chat_id', CHAT_ID);
    await sb.from('families').delete().eq('id', fid);
  }
  // Fresh family
  const { data: fam } = await sb.from('families').insert({ name: 'Smoke Family' }).select('id').single();
  if (!fam) throw new Error('family create failed');
  await sb.rpc('seed_default_categories_for_family', { p_family_id: fam.id });
  // Create user
  const { data: user } = await sb.from('users').insert({
    telegram_id: TG_ID,
    name: NAME,
    family_id: fam.id,
  }).select('id').single();
  if (!user) throw new Error('user create failed');
  // Link DM chat
  await sb.from('family_chats').insert({
    chat_id: CHAT_ID,
    family_id: fam.id,
    chat_type: 'private',
    linked_by_user_id: user.id,
  });
  console.log(`▸ Fresh family ${fam.id} ready (categories seeded)\n`);
  return { familyId: fam.id, userId: user.id };
}

// Anthropic rate limit at our tier is 30k input tokens/min. Each chat() call
// burns 2-5k tokens (system prompt + history + tools schema). 8s gap between
// scenarios keeps us comfortably under the burst limit; if a 429 fires
// anyway, wait 30s and retry once.
async function run(name: string, fn: () => Promise<string | null>) {
  await new Promise((r) => setTimeout(r, 8000));
  const t0 = Date.now();
  const tryOnce = async () => {
    const detail = await fn();
    return detail;
  };
  try {
    let detail: string | null;
    try {
      detail = await tryOnce();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/429|rate_limit/i.test(msg)) {
        console.log(`  (rate limited; sleeping 30s and retrying once)`);
        await new Promise((r) => setTimeout(r, 30000));
        detail = await tryOnce();
      } else {
        throw e;
      }
    }
    const ms = Date.now() - t0;
    if (detail === null) {
      results.push({ name, ok: true });
      console.log(`✓ ${name} (${ms}ms)`);
    } else {
      results.push({ name, ok: false, detail });
      console.log(`✗ ${name} (${ms}ms): ${detail}`);
    }
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail: `THREW: ${msg}` });
    console.log(`✗ ${name} (${ms}ms) THREW: ${msg}`);
  }
}

async function send(text: string, familyId: string) {
  const resp = await chat(text, TG_ID, NAME, CHAT_ID, familyId);
  return resp.text;
}

async function txnCount(familyId: string, type?: 'expense' | 'income') {
  let q = sb.from('transactions').select('id', { count: 'exact', head: true }).eq('family_id', familyId).is('deleted_at', null);
  if (type) q = q.eq('type', type);
  const { count } = await q;
  return count ?? 0;
}

async function lastTxn(familyId: string) {
  const { data } = await sb.from('transactions').select('*').eq('family_id', familyId).is('deleted_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data;
}

async function debtCount(familyId: string) {
  const { count } = await sb.from('debts').select('id', { count: 'exact', head: true }).eq('family_id', familyId);
  return count ?? 0;
}

async function injectAssistantMsg(familyId: string, content: string) {
  await sb.from('conversation_messages').insert({
    family_id: familyId,
    telegram_chat_id: CHAT_ID,
    role: 'assistant',
    content,
  });
}

async function clearMessages(familyId: string) {
  await sb.from('conversation_messages').delete().eq('family_id', familyId);
}

async function main() {
  const { familyId } = await setup();

  // ── 1. Expense, simple shape ────────────────────────────────────────
  await run('expense: "кофе 500"', async () => {
    const before = await txnCount(familyId);
    const reply = await send('кофе 500', familyId);
    const after = await txnCount(familyId);
    if (after !== before + 1) return `expected +1 txn, got ${after - before}. reply=${reply.slice(0, 200)}`;
    if (!reply.includes('500')) return `reply missing amount. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 2. Akbota currency-suffix regression ────────────────────────────
  await run('expense: "Супермаркет 1762тг"', async () => {
    const before = await txnCount(familyId);
    const reply = await send('Супермаркет 1762тг', familyId);
    const after = await txnCount(familyId);
    if (after !== before + 1) return `expected +1 txn. reply=${reply.slice(0, 200)}`;
    const last = await lastTxn(familyId);
    if (last?.amount !== 1762) return `expected amount=1762, got ${last?.amount}`;
    return null;
  });

  // ── 3. Income with "зарплата" vocabulary ────────────────────────────
  await run('income: "зарплата 500000"', async () => {
    const before = await txnCount(familyId, 'income');
    const reply = await send('зарплата 500000', familyId);
    const after = await txnCount(familyId, 'income');
    if (after !== before + 1) return `expected +1 income txn. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 4. THE RECENT BUG: "зафиксируй доход 1000000" must be income ────
  await run('income: "зафиксируй доход 1000000" (recent bug)', async () => {
    const beforeI = await txnCount(familyId, 'income');
    const beforeE = await txnCount(familyId, 'expense');
    const reply = await send('зафиксируй доход 1000000', familyId);
    const afterI = await txnCount(familyId, 'income');
    const afterE = await txnCount(familyId, 'expense');
    if (afterI !== beforeI + 1) return `expected +1 INCOME, got ${afterI - beforeI}. reply=${reply.slice(0, 200)}`;
    if (afterE !== beforeE) return `BUG: logged as EXPENSE instead of income (+${afterE - beforeE} expense rows)`;
    return null;
  });

  // ── 5. Debt logging ─────────────────────────────────────────────────
  await run('debt: "взял в долг 100000 у Аидара"', async () => {
    const before = await debtCount(familyId);
    const reply = await send('взял в долг 100000 у Аидара', familyId);
    const after = await debtCount(familyId);
    if (after !== before + 1) return `expected +1 debt row. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 6. Multi-line expenses ──────────────────────────────────────────
  await run('expense: 3 lines at once', async () => {
    const before = await txnCount(familyId, 'expense');
    const reply = await send('хлеб 200\nтакси 2500\nпродукты 8400', familyId);
    const after = await txnCount(familyId, 'expense');
    if (after !== before + 3) return `expected +3 expense txns, got ${after - before}. reply=${reply.slice(0, 300)}`;
    return null;
  });

  // ── 7. NL command must NOT log as expense ───────────────────────────
  await run('limit: "поставь лимит 100000 на Продукты" must propose, not log', async () => {
    const beforeE = await txnCount(familyId, 'expense');
    const reply = await send('поставь лимит 100000 на Продукты', familyId);
    const afterE = await txnCount(familyId, 'expense');
    if (afterE !== beforeE) return `BUG: limit-set logged as expense (+${afterE - beforeE} expense rows)`;
    if (!/лимит|план|плана/i.test(reply)) return `reply doesn't mention limit. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 8. NL command: goal must NOT log as expense ─────────────────────
  await run('goal: "поставь цель накопить на отпуск 1млн до июня" must propose', async () => {
    const beforeE = await txnCount(familyId, 'expense');
    const reply = await send('поставь цель накопить на отпуск 1млн до июня', familyId);
    const afterE = await txnCount(familyId, 'expense');
    if (afterE !== beforeE) return `BUG: goal-set logged as expense (+${afterE - beforeE})`;
    if (!/цел|накопит/i.test(reply)) return `reply doesn't mention goal. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 9. Contextual reply: bot asked date, user answers ───────────────
  await run('contextual: bot asked date → user "до июня 2026" must NOT log expense', async () => {
    await clearMessages(familyId);
    await injectAssistantMsg(familyId, 'До какой даты хочешь накопить? 📅');
    const beforeE = await txnCount(familyId, 'expense');
    const reply = await send('до июня 2026', familyId);
    const afterE = await txnCount(familyId, 'expense');
    if (afterE !== beforeE) return `BUG: date-reply logged as expense (+${afterE - beforeE} rows)`;
    return null;
  });

  // ── 10. Read query: "итоги месяца" ──────────────────────────────────
  await run('read: "итоги месяца"', async () => {
    const beforeT = await txnCount(familyId);
    const reply = await send('итоги месяца', familyId);
    const afterT = await txnCount(familyId);
    if (afterT !== beforeT) return `BUG: read query created ${afterT - beforeT} txns`;
    if (!/(всего|итог)/i.test(reply)) return `reply doesn't look like summary. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 11. List categories shows REAL family cats ──────────────────────
  await run('read: "дай категории" lists actual seeded defaults', async () => {
    const reply = await send('дай категории', familyId);
    // Universal defaults from migration 011: Продукты, Жильё, Транспорт,
    // Кафе, Здоровье, Личное, Накопления, Разное. Should NOT include
    // Shynggys-specific Балапанчик / baby / credit.
    if (/балапанчик|baby|credit/i.test(reply)) return `BUG: shows old hardcoded slugs. reply=${reply.slice(0, 300)}`;
    if (!/Продукты/i.test(reply)) return `missing default category Продукты. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 12. Undo deletes the last txn ───────────────────────────────────
  await run('undo: "удали последнюю"', async () => {
    const before = await txnCount(familyId);
    if (before === 0) return 'precondition fail: no txns to undo';
    const reply = await send('удали последнюю', familyId);
    const after = await txnCount(familyId);
    if (after !== before - 1) return `expected -1 txn, got ${after - before}. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 13. Lone "?" short-circuits to "не понял" ───────────────────────
  await run('ambiguous: "?" → "не понял" (short-circuit, no LLM call)', async () => {
    await clearMessages(familyId); // clear so Sonnet has no context to hallucinate from
    const before = await txnCount(familyId);
    const reply = await send('?', familyId);
    const after = await txnCount(familyId);
    if (after !== before) return `BUG: "?" caused txn write`;
    if (!/не понял/i.test(reply)) return `reply not the expected short-circuit. reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── 14. Confirmation pass-through: "да" reaches Sonnet ──────────────
  await run('"да" passes the meaningful-input short-circuit', async () => {
    await clearMessages(familyId);
    await injectAssistantMsg(familyId, '🎯 Создать цель: *Отпуск* — 1 000 000 ₸ к 2026-06-30?');
    const reply = await send('да', familyId);
    if (/не понял/i.test(reply)) return `BUG: "да" got the lone-? short-circuit`;
    return null;
  });

  // ── 15. Sentence-form expense via Sonnet ────────────────────────────
  // Use a unique amount + description so the dedup guard doesn't fire
  // (we logged "кофе 500" earlier; the dedup window is 10 min).
  await run('expense: "купил пиццу за 4321" (sentence form, LLM tool)', async () => {
    const before = await txnCount(familyId, 'expense');
    const reply = await send('купил пиццу за 4321', familyId);
    const after = await txnCount(familyId, 'expense');
    if (after !== before + 1) return `expected +1 expense (Sonnet should call log_expense). reply=${reply.slice(0, 200)}`;
    return null;
  });

  // ── Summary ─────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log('\n═══════════════════════════════════════');
  console.log(`Smoke test: ${passed}/${results.length} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════');
  if (failed > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ✗ ${r.name}`);
      console.log(`    ${r.detail}`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
