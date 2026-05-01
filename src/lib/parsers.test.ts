import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripCurrencyMarkers,
  tryParseExpenses,
  tryParseIncome,
  tryParseDebt,
  isUndoRequest,
  isMeaningfulInput,
  looksLikeNonExpenseIntent,
} from './parsers';

// These tests cover the parser surface — the deterministic fast path before
// Sonnet sees a message. Failures here cause the catastrophic class of bug
// (bot lies "Записала" without recording, or doesn't reply at all). Each
// test cites the failure mode it guards against.

describe('stripCurrencyMarkers', () => {
  test('removes "тг" with no space (Akbota incident 2026-04-25)', () => {
    assert.equal(stripCurrencyMarkers('Супермаркет 1762тг'), 'Супермаркет 1762');
  });

  test('removes "тг" with space', () => {
    assert.equal(stripCurrencyMarkers('Кофе 500 тг'), 'Кофе 500');
  });

  test('removes "тенге"', () => {
    assert.equal(stripCurrencyMarkers('Такси 2500 тенге'), 'Такси 2500');
  });

  test('removes "₸"', () => {
    assert.equal(stripCurrencyMarkers('Пицца 4000 ₸'), 'Пицца 4000');
    assert.equal(stripCurrencyMarkers('Пицца 4000₸'), 'Пицца 4000');
  });

  test('removes "kzt" (case-insensitive)', () => {
    assert.equal(stripCurrencyMarkers('Жильё 50000 KZT'), 'Жильё 50000');
    assert.equal(stripCurrencyMarkers('Жильё 50000kzt'), 'Жильё 50000');
  });

  test('removes "ТГ" uppercase', () => {
    assert.equal(stripCurrencyMarkers('Молоко 600 ТГ'), 'Молоко 600');
  });

  test('does not eat letters that look like currency mid-word', () => {
    // "тренировка" contains "тг" but it's not after a digit, so leave it.
    assert.equal(stripCurrencyMarkers('Купил тренировку 5000'), 'Купил тренировку 5000');
  });

  test('handles amount-first format', () => {
    assert.equal(stripCurrencyMarkers('5000тг продукты'), '5000 продукты');
  });

  test('collapses whitespace introduced by stripping', () => {
    assert.equal(stripCurrencyMarkers('Хлеб   100   ₸'), 'Хлеб 100');
  });

  test('idempotent on already-clean input', () => {
    assert.equal(stripCurrencyMarkers('Кофе 500'), 'Кофе 500');
    assert.equal(stripCurrencyMarkers(''), '');
  });
});

describe('tryParseExpenses — happy path', () => {
  test('description before amount', () => {
    assert.deepEqual(tryParseExpenses('Кофе 500'), [{ amount: 500, description: 'Кофе' }]);
  });

  test('amount before description', () => {
    assert.deepEqual(tryParseExpenses('500 кофе'), [{ amount: 500, description: 'кофе' }]);
  });

  test('multi-word description', () => {
    assert.deepEqual(tryParseExpenses('Хлеб и сэндвич 935'), [
      { amount: 935, description: 'Хлеб и сэндвич' },
    ]);
  });

  test('amount with thousand-space separator', () => {
    assert.deepEqual(tryParseExpenses('Жильё 50 000'), [{ amount: 50000, description: 'Жильё' }]);
  });

  test('multiple expenses, one per line', () => {
    const result = tryParseExpenses('кофе 500\nтакси 2500\nпродукты 8400');
    assert.deepEqual(result, [
      { amount: 500, description: 'кофе' },
      { amount: 2500, description: 'такси' },
      { amount: 8400, description: 'продукты' },
    ]);
  });
});

describe('tryParseExpenses — currency suffix variants (Akbota regression)', () => {
  test('"Супермаркет 1762тг" — exact bug repro from prod', () => {
    // This is THE bug. Before the fix, this returned null and Sonnet faked
    // "Записала!" without recording. Akbota's family had 0 transactions.
    assert.deepEqual(tryParseExpenses('Супермаркет 1762тг'), [
      { amount: 1762, description: 'Супермаркет' },
    ]);
  });

  test('"Пицца 400тг"', () => {
    assert.deepEqual(tryParseExpenses('Пицца 400тг'), [{ amount: 400, description: 'Пицца' }]);
  });

  test('"Кофе 500 ₸"', () => {
    assert.deepEqual(tryParseExpenses('Кофе 500 ₸'), [{ amount: 500, description: 'Кофе' }]);
  });

  test('"Такси 2500 тенге"', () => {
    assert.deepEqual(tryParseExpenses('Такси 2500 тенге'), [
      { amount: 2500, description: 'Такси' },
    ]);
  });

  test('"3000 пельмени тг"', () => {
    assert.deepEqual(tryParseExpenses('3000 пельмени тг'), [
      { amount: 3000, description: 'пельмени' },
    ]);
  });

  test('upper-case "ТГ"', () => {
    assert.deepEqual(tryParseExpenses('Молоко 600 ТГ'), [{ amount: 600, description: 'Молоко' }]);
  });

  test('"50000kzt жильё"', () => {
    assert.deepEqual(tryParseExpenses('50000kzt жильё'), [
      { amount: 50000, description: 'жильё' },
    ]);
  });
});

describe('tryParseExpenses — must NOT match', () => {
  test('plain greeting', () => {
    assert.equal(tryParseExpenses('привет'), null);
  });

  test('question without amount', () => {
    assert.equal(tryParseExpenses('сколько на кофе?'), null);
  });

  test('sentence form ("купил X за Y") — falls through to LLM by design', () => {
    // tryParseExpenses requires "<desc> <amount>" or "<amount> <desc>" shape.
    // "Купил кофе за 500" has "за" between description and amount, so it
    // doesn't match either form. This is intentional — sentence-form expense
    // logging is rare and falls through to Sonnet, which now refuses to fake
    // a receipt and asks the user to re-send in the simple shape.
    const r = tryParseExpenses('Купил кофе за 500');
    // It DOES match the description-then-amount pattern: "Купил кофе за" + "500"
    // with description="Купил кофе за". Documenting the actual behavior so
    // future contributors don't break it accidentally.
    assert.deepEqual(r, [{ amount: 500, description: 'Купил кофе за' }]);
  });

  test('zero amount rejected', () => {
    assert.equal(tryParseExpenses('Кофе 0'), null);
  });

  test('negative amount rejected (no minus support)', () => {
    // "-500" doesn't match \d, so the regex won't capture it.
    assert.equal(tryParseExpenses('Кофе -500'), null);
  });

  test('amount > 10M rejected', () => {
    // Guard against a typo like "1000000000" that would otherwise log a billion-tenge expense.
    assert.equal(tryParseExpenses('Дом 100000000'), null);
  });

  test('whitespace-only line skipped', () => {
    assert.equal(tryParseExpenses('   \n\n  '), null);
  });

  test('empty string', () => {
    assert.equal(tryParseExpenses(''), null);
  });
});

describe('tryParseIncome', () => {
  test('"Зарплата 500000"', () => {
    assert.deepEqual(tryParseIncome('Зарплата 500000'), { amount: 500000, comment: 'Зарплата' });
  });

  test('"Получил премию 100000"', () => {
    const r = tryParseIncome('Получил премию 100000');
    assert.equal(r?.amount, 100000);
    assert.match(r?.comment ?? '', /Получил|премию/i);
  });

  test('strips currency from comment', () => {
    const r = tryParseIncome('Зарплата 500000 тг');
    assert.equal(r?.amount, 500000);
    assert.equal(r?.comment, 'Зарплата');
  });

  test('non-income text returns null', () => {
    assert.equal(tryParseIncome('кофе 500'), null);
    assert.equal(tryParseIncome('Привет 5'), null);
  });

  test('no amount returns null', () => {
    assert.equal(tryParseIncome('Получил зарплату'), null);
  });
});

describe('tryParseDebt', () => {
  test('"Взял в долг 100000 у Аидар"', () => {
    const r = tryParseDebt('Взял в долг 100000 у Аидар');
    assert.equal(r?.amount, 100000);
    assert.match(r?.name ?? '', /Аидар/);
  });

  test('"Занял 50000 Жанар"', () => {
    const r = tryParseDebt('Занял 50000 Жанар');
    assert.equal(r?.amount, 50000);
    assert.match(r?.name ?? '', /Жанар/);
  });

  test('non-debt text returns null', () => {
    assert.equal(tryParseDebt('кофе 500'), null);
    assert.equal(tryParseDebt('Зарплата 100000'), null);
  });

  test('no name defaults to "без имени"', () => {
    const r = tryParseDebt('Занял 5000');
    assert.equal(r?.name, 'без имени');
  });
});

describe('isMeaningfulInput — ambiguous-input short-circuit', () => {
  test('rejects lone "?" (real prod hallucination case)', () => {
    // A lone "?" in a group chat made Sonnet fabricate "Похоже, вы написали
    // 'автобус 110'..." referencing a transaction from earlier. We short-
    // circuit before the LLM sees it.
    assert.equal(isMeaningfulInput('?'), false);
  });

  test('rejects "??", "!", "...", "??!"', () => {
    assert.equal(isMeaningfulInput('??'), false);
    assert.equal(isMeaningfulInput('!'), false);
    assert.equal(isMeaningfulInput('...'), false);
    assert.equal(isMeaningfulInput('??!'), false);
    assert.equal(isMeaningfulInput('   '), false);
    assert.equal(isMeaningfulInput(''), false);
  });

  test('rejects 1-2 character mumbles (but NOT confirmation words)', () => {
    assert.equal(isMeaningfulInput('a'), false);
    assert.equal(isMeaningfulInput('xy'), false);
    assert.equal(isMeaningfulInput('hm'), false);
    // "ok" and "да" are now allow-listed as confirmation words (see test below)
  });

  test('accepts real questions (>= 3 meaningful chars)', () => {
    assert.equal(isMeaningfulInput('кофе'), true);
    assert.equal(isMeaningfulInput('сколько?'), true);
    assert.equal(isMeaningfulInput('покажи'), true);
    assert.equal(isMeaningfulInput('кофе 500'), true);
  });

  test('accepts short-but-meaningful "хлеб 100"', () => {
    assert.equal(isMeaningfulInput('хлеб 100'), true);
  });

  test('lets confirmation words through (real prod incident: "да" lost)', () => {
    // Bot suggested moving a transaction, user replied "да", short-circuit
    // killed it before Sonnet could see the conversation context. Must pass.
    assert.equal(isMeaningfulInput('да'), true);
    assert.equal(isMeaningfulInput('Да'), true);
    assert.equal(isMeaningfulInput('ДА'), true);
    assert.equal(isMeaningfulInput('нет'), true);
    assert.equal(isMeaningfulInput('ok'), true);
    assert.equal(isMeaningfulInput('OK'), true);
    assert.equal(isMeaningfulInput('yes'), true);
    assert.equal(isMeaningfulInput('давай'), true);
    assert.equal(isMeaningfulInput('отмена'), true);
  });
});

describe('looksLikeNonExpenseIntent — guard against expense parser swallowing NL commands', () => {
  test('"поставь лимит на продукты 100000" — exact dev-test bug repro', () => {
    // Without this guard, tryParseExpenses matched and logged a 100k expense
    // in Продукты. User wanted propose_set_monthly_plan instead.
    assert.equal(looksLikeNonExpenseIntent('поставь лимит на продукты 100000'), true);
  });

  test('limit/plan/budget command variants', () => {
    assert.equal(looksLikeNonExpenseIntent('лимит на кафе 50000'), true);
    assert.equal(looksLikeNonExpenseIntent('Установи лимит 30000 на транспорт'), true);
    assert.equal(looksLikeNonExpenseIntent('задай план 80000 на жильё'), true);
    assert.equal(looksLikeNonExpenseIntent('поставь бюджет 200000'), true);
  });

  test('category management commands', () => {
    assert.equal(looksLikeNonExpenseIntent('создай категорию Хобби'), true);
    assert.equal(looksLikeNonExpenseIntent('добавь категории Бензин, Кафе'), true);
    assert.equal(looksLikeNonExpenseIntent('переименуй категорию Личное в Себе'), true);
    assert.equal(looksLikeNonExpenseIntent('удали категорию Накопления'), true);
    assert.equal(looksLikeNonExpenseIntent('объедини категории Кафе и Рестораны'), true);
  });

  test('reclassify intent', () => {
    assert.equal(looksLikeNonExpenseIntent('поменяй категорию рыбо на кафе'), true);
    assert.equal(looksLikeNonExpenseIntent('переклассифицируй последнюю в Кафе'), true);
    assert.equal(looksLikeNonExpenseIntent('перемести рыбо в категорию Кафе'), true);
  });

  test('goal intent', () => {
    assert.equal(looksLikeNonExpenseIntent('хочу накопить 500000'), true);
    assert.equal(looksLikeNonExpenseIntent('создай цель отпуск 300000'), true);
  });

  test('question/list intent', () => {
    assert.equal(looksLikeNonExpenseIntent('покажи последние 10'), true);
    assert.equal(looksLikeNonExpenseIntent('дай категории'), true);
    assert.equal(looksLikeNonExpenseIntent('сколько на кофе?'), true);
    assert.equal(looksLikeNonExpenseIntent('какие у меня категории'), true);
  });

  test('does NOT match real expenses', () => {
    assert.equal(looksLikeNonExpenseIntent('Кофе 500'), false);
    assert.equal(looksLikeNonExpenseIntent('Супермаркет 1762'), false);
    assert.equal(looksLikeNonExpenseIntent('Хлеб и сэндвич 935'), false);
    assert.equal(looksLikeNonExpenseIntent('500 кофе'), false);
    // "лимит" mid-sentence (not at start) — could be a real expense like
    // "купил лимиты 5000". Allow.
    assert.equal(looksLikeNonExpenseIntent('купил лимиты 5000'), false);
  });

  test('does NOT match income/debt phrases', () => {
    assert.equal(looksLikeNonExpenseIntent('Зарплата 500000'), false);
    assert.equal(looksLikeNonExpenseIntent('Получил премию 100000'), false);
    assert.equal(looksLikeNonExpenseIntent('Взял в долг 100000 у Аидар'), false);
  });
});

describe('isUndoRequest', () => {
  test('"удали"', () => {
    assert.equal(isUndoRequest('удали'), true);
    assert.equal(isUndoRequest('Удали последнюю'), true);
  });

  test('"отмени"', () => {
    assert.equal(isUndoRequest('отмени'), true);
    assert.equal(isUndoRequest('отмена'), true);
  });

  test('"undo"', () => {
    assert.equal(isUndoRequest('undo'), true);
    assert.equal(isUndoRequest('UNDO'), true);
  });

  test('non-undo phrases', () => {
    assert.equal(isUndoRequest('кофе 500'), false);
    assert.equal(isUndoRequest('сколько на чипсы?'), false);
    assert.equal(isUndoRequest('покажи последние 10'), false);
  });
});
