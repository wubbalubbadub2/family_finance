// Pure-function intent parsers used by the bot agent. Lives in its own file
// (no Supabase / Anthropic / grammy imports) so unit tests can import these
// directly without bootstrapping a DB client or LLM SDK.
//
// All functions are sync, deterministic, and side-effect free. If you need
// async or DB access, the logic belongs in agent.ts, not here.

// Strip currency markers from input. Russian-speaking users routinely append
// "тг", "тенге", "₸", or "kzt" to amounts, but the expense regex requires the
// line to end with digits — unstripped suffixes break parsing.
//
// Real prod incident (2026-04-25): Akbota wrote "Супермаркет 1762тг" — bot
// fell through to Sonnet, which faked "Записала!" without recording anything.
//
// Two-pass strip:
//   1. Digit-adjacent: "1762тг", "500 ₸", "3000 тг продукты" → digit-only
//   2. Trailing standalone: "3000 пельмени тг" → "3000 пельмени"
//
// We deliberately do NOT strip mid-string standalone currency tokens (e.g.
// "купил тг и проездной"). Too risky, real Russian words could collide.
const CURRENCY_DIGIT_ADJACENT = /(\d)\s*(?:тенге|тг|kzt|₸)/giu;
const CURRENCY_TRAILING = /\s+(?:тенге|тг|kzt|₸)\s*$/giu;

export function stripCurrencyMarkers(line: string): string {
  return line
    .replace(CURRENCY_DIGIT_ADJACENT, '$1')
    .replace(CURRENCY_TRAILING, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tryParseExpenses(text: string): { amount: number; description: string }[] | null {
  const lines = text.split('\n').map((l) => stripCurrencyMarkers(l)).filter(Boolean);
  const results: { amount: number; description: string }[] = [];

  for (const line of lines) {
    const match1 = line.match(/^(.+?)\s+(\d[\d\s]*\d|\d+)\s*$/);
    const match2 = line.match(/^(\d[\d\s]*\d|\d+)\s+(.+?)$/);

    if (match1) {
      const amount = parseInt(match1[2].replace(/\s/g, ''), 10);
      if (amount > 0 && amount <= 10_000_000) results.push({ amount, description: match1[1].trim() });
    } else if (match2) {
      const amount = parseInt(match2[1].replace(/\s/g, ''), 10);
      if (amount > 0 && amount <= 10_000_000) results.push({ amount, description: match2[2].trim() });
    }
  }

  if (results.length > 0) return results;
  return null;
}

export function tryParseIncome(text: string): { amount: number; comment: string } | null {
  const lower = text.toLowerCase();
  const incomeWords = /зарплат|доход|получил|премия|бонус|фриланс|перевод|вернули/;
  if (!incomeWords.test(lower)) return null;

  const amountMatch = text.match(/(\d[\d\s]*\d|\d+)/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  if (amount <= 0) return null;

  const comment = text.replace(amountMatch[0], '').replace(/тенге|тг|₸/gi, '').trim();
  return { amount, comment: comment || 'доход' };
}

export function tryParseDebt(text: string): { amount: number; name: string } | null {
  const lower = text.toLowerCase();
  if (!/взял в долг|занял|одолжил|кредит взял/i.test(lower)) return null;

  const amountMatch = text.match(/(\d[\d\s]*\d|\d+)/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/\s/g, ''), 10);
  if (amount <= 0) return null;

  // Extract name: everything after the amount, after stripping verbs and currency.
  let name = text
    .replace(amountMatch[0], '')
    .replace(/взял в долг|занял|одолжил|кредит взял|тенге|тг|₸|у\s/gi, '')
    .trim();
  if (!name) name = 'без имени';
  return { amount, name };
}

/**
 * @deprecated Unused since the Phase 1 intent refactor (2026-05-08). Undo
 * intent now flows through Sonnet → `delete_last_transaction` tool. The
 * regex matched "удали" anywhere in the message, which produced the
 * "Удалить все категории и оставить только X, Y, Z" → "🗑️ Удалено: 1500 ₸ —
 * кофе" bug (silently deleted a transaction). Kept as dead code for one
 * release cycle in case a downstream caller needs it; delete in Phase 4.
 */
export function isUndoRequest(text: string): boolean {
  return /удали|отмени|undo|убери последн|верни назад|отмена/i.test(text);
}

// Intents the deterministic parsers must NOT swallow as expenses. These read
// like "<verb-phrase> <number>" and trivially match tryParseExpenses, so without
// this short-circuit Sonnet never sees them.
//
// Real prod incident (2026-04-29, dev test): "поставь лимит на продукты 100000"
// got logged as a 100 000 ₸ expense in the Продукты category. The user wanted
// propose_set_monthly_plan, not an expense.
//
// Keep this list narrow — false positives here mean a real expense gets routed
// to the LLM (slow, costs tokens) instead of being recorded directly.
//
// NOTE: do NOT use \b boundary anchors around Cyrillic words — JS regex treats
// Cyrillic letters as non-word chars, so \b matches BETWEEN them. We use \s
// or end-of-string anchors instead.
export function looksLikeNonExpenseIntent(text: string): boolean {
  return /^\s*(поставь|установи|сделай|задай)\s+лимит(\s|$)/i.test(text)
    || /^\s*лимит\s+на(\s|$)/i.test(text)
    || /^\s*(установи|задай|сделай|поставь)\s+(план|бюджет)(\s|$)/i.test(text)
    || /^\s*(создай|добавь|сделай|заведи)\s+(категор|цел)/i.test(text)
    || /^\s*(переименуй|удали|объедини)\s+категор/i.test(text)
    || /^\s*переклассифицируй(\s|$)/i.test(text)
    || /^\s*(поменяй|измени|перенеси|перемести)\s.*катего[рp]/i.test(text)
    || /^\s*(хочу\s+)?(накопить|накоплю)(\s|$)/i.test(text)
    || /^\s*(покажи|дай|выведи|сколько|где|какие|какой|какая)(\s|\?|$)/i.test(text);
}

/**
 * Empty-input guard. Returns false ONLY when the message has zero non-
 * whitespace characters. Everything else — including "1", "?", "hm" — flows
 * through to Sonnet which can interpret it against the open conversation.
 *
 * Why this is permissive: previously the function rejected anything under 3
 * meaningful characters to dodge a hallucination case where Sonnet
 * confronted with "?" anchored on the last expense in history and faked
 * "Похоже, вы написали 'автобус 110'…". The cure was worse than the
 * disease: it also blocked legitimate replies like "1" / "2" to a
 * clarifying question the bot itself just asked. The right fix is at the
 * Sonnet-context layer (pending_question + conversation history), not a
 * char-count gate.
 */
export function isMeaningfulInput(text: string): boolean {
  return text.trim().length > 0;
}
