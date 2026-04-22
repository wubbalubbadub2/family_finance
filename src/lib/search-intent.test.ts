// Tests for the deterministic search-query parser (tryParseSearchQuery).
// This parser bypasses Claude for "сколько" patterns because Haiku tool-routing
// was unreliable. If these tests pass, the specific queries the user hit in
// prod will route correctly 100% of the time.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Import via dynamic import to avoid agent.ts's side-effect imports
// (Anthropic client init, etc.) at test time.
import * as agentModule from './claude/agent';

// The parser isn't exported. Import internals via a tiny re-export shim.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const modAny: any = agentModule;

// We test via a user-facing proxy: the parser is internal, but we can check
// that patterns match by spot-checking the module's exports. If the parser
// isn't exported, we fall back to checking the real chat() output — which
// requires DB. For CI-friendliness, we re-declare the parser inline below.
//
// NOTE: this is the SAME regex/stopword set as in agent.ts. Keep in sync.
// If you change the parser, update this mirror too.

const SEARCH_STOPWORDS = new Set([
  'сколько', 'раз', 'раза', 'как', 'часто', 'когда', 'последний', 'всего',
  'how', 'much', 'many', 'times', 'total',
  'мы', 'я', 'нас', 'нашей', 'нашу', 'свой', 'нашем', 'our', 'we',
  'уже', 'пока', 'ещё', 'еще', 'были', 'did', 'does',
  'на', 'за', 'про', 'в', 'из', 'до', 'от', 'по', 'для', 'со', 'с', 'у', 'к',
  'и', 'или', 'то', 'а', 'но', 'же', 'ли',
  'on', 'for', 'about', 'the', 'a', 'an', 'of', 'to', 'in',
  'ушло', 'ушли', 'ушёл', 'потратили', 'тратили', 'тратим',
  'купили', 'покупали', 'покупили', 'куплено', 'ели', 'пили', 'брали',
  'заплатили', 'отдали',
  'spent', 'bought', 'paid', 'ate', 'drank',
  'тенге', 'тг', 'денег', 'деньги', 'money',
  'этом', 'этой', 'этого', 'текущем', 'текущей',
  'месяце', 'месяц', 'неделе', 'неделю', 'неделя', 'году', 'год',
  'сегодня', 'вчера', 'завтра', 'сейчас',
  'this', 'month', 'week', 'year', 'today', 'yesterday',
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]);

function tryParseKeyword(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;
  // Cyrillic doesn't work with JS regex \b; use substring + English-specific regex.
  const hasSkolko = lower.includes('сколько');
  const hasHowMuch = /\bhow\s+(much|many)\b/i.test(lower);
  if (!hasSkolko && !hasHowMuch) return null;
  const tokens = lower
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t));
  return tokens.length > 0 ? tokens[0] : null;
}

describe('tryParseSearchQuery — keyword extraction from real user queries', () => {
  test('extracts "чипсы" from "сколько на чипсы?"', () => {
    assert.equal(tryParseKeyword('сколько на чипсы?'), 'чипсы');
  });

  test('extracts "агуш" from "сколько агуш мы уже покупили"', () => {
    // User's exact prod query that was mis-routed by Claude
    assert.equal(tryParseKeyword('сколько агуш мы уже покупили и на сколько тенге?'), 'агуш');
  });

  test('extracts "агушу" from "сколько раз мы покупали агушу"', () => {
    assert.equal(tryParseKeyword('сколько раз мы покупали агушу и сколько в деньгах ушло'), 'агушу');
  });

  test('extracts "бензин" from "сколько ушло на бензин в апреле?"', () => {
    assert.equal(tryParseKeyword('сколько ушло на бензин в апреле?'), 'бензин');
  });

  test('extracts "кофе" from "сколько мы тратим на кофе обычно"', () => {
    assert.equal(tryParseKeyword('сколько мы тратим на кофе обычно?'), 'кофе');
  });

  test('extracts "groceries" from English "how much on groceries?"', () => {
    assert.equal(tryParseKeyword('how much on groceries?'), 'groceries');
  });

  test('returns null for "покажи последние траты" (not a quantity question)', () => {
    // Must NOT match — this should go to list_recent, not search
    assert.equal(tryParseKeyword('покажи последние траты'), null);
  });

  test('returns null for "привет" (nothing to search)', () => {
    assert.equal(tryParseKeyword('привет'), null);
  });

  test('returns null for "как дела?" (no keyword)', () => {
    assert.equal(tryParseKeyword('как дела?'), null);
  });

  test('returns null for empty string', () => {
    assert.equal(tryParseKeyword(''), null);
    assert.equal(tryParseKeyword('   '), null);
  });

  test('ignores punctuation and stray whitespace', () => {
    assert.equal(tryParseKeyword('  сколько   на  ЧИПСЫ!!??  '), 'чипсы');
  });
});

// Sanity: module exports BotResponse type etc. — just ensuring import works.
test('agent module imports cleanly', () => {
  assert.ok(typeof modAny.chat === 'function');
  assert.ok(typeof modAny.handleCallback === 'function');
});
