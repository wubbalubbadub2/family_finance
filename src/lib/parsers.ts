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

export function isUndoRequest(text: string): boolean {
  return /удали|отмени|undo|убери последн|верни назад|отмена/i.test(text);
}

/**
 * Has the user actually said anything meaningful, or is this just punctuation?
 *
 * Background: with Sonnet handling fallback NL queries, ambiguous inputs like
 * "?", "??", "!", "...", "hmm" cause the model to anchor on recent
 * conversation history and hallucinate a response. Real prod incident: a
 * lone "?" in a group chat got back "Похоже, вы написали 'автобус 110'..."
 * referencing a transaction from 30min earlier. We short-circuit these
 * before they reach the LLM and ask the user to be more specific instead.
 */
export function isMeaningfulInput(text: string): boolean {
  const meaningfulChars = text.replace(/[\s?!.,;:()\[\]{}<>—–-]/g, '');
  return meaningfulChars.length >= 3;
}
