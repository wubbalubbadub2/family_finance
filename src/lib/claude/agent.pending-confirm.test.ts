// Layer 3 — pending_confirm context invalidation classifier.
//
// User C lost 25 minutes (2026-05-04 prod logs) because a stale goal proposal
// in `pending_confirm` kept hijacking unrelated turns. Every "Создай!" she
// typed got interpreted as a confirm of the old goal. Layer 3 added the
// `classifyPendingConfirmTransition` classifier that decides whether to
// preserve or clear pending_confirm based on what the user typed.
//
// These tests lock the three rules from the locked plan (2026-05-10):
//   Rule 1: prefix-match a confirm/cancel token → preserve. "да, создай"
//           confirms (does NOT trigger rule 2's clear).
//   Rule 2: russianStem of any token matches a context-shift verb → clear.
//   Rule 3: nothing matched → preserve (short replies like "?" stay).
//
// All cases are pure-function — no DB, no Anthropic, no bot.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPendingConfirmTransition } from './agent';

describe('Rule 1 — prefix-match confirm/cancel tokens preserve pending', () => {
  test('bare confirm tokens', () => {
    assert.equal(classifyPendingConfirmTransition('да'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('нет'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('ага'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('угу'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('ок'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('ok'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('yes'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('no'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('подтверждаю'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('отмена'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('cancel'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('confirm'), 'preserve');
  });

  test('emoji confirms', () => {
    assert.equal(classifyPendingConfirmTransition('✅'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('❌'), 'preserve');
  });

  test('compound confirms — "да" followed by a verb still preserves (rule 1 wins)', () => {
    // CRITICAL: "да, создай" is the explicit test case from the locked plan.
    // The verb "создай" must NOT clobber the confirm via rule 2.
    assert.equal(classifyPendingConfirmTransition('да, создай'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('ок добавь'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('ага удали'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('yes please'), 'preserve');
  });

  test('case insensitive', () => {
    assert.equal(classifyPendingConfirmTransition('ДА'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('Yes'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('Подтверждаю'), 'preserve');
  });

  test('whitespace tolerance', () => {
    assert.equal(classifyPendingConfirmTransition('  да  '), 'preserve');
    assert.equal(classifyPendingConfirmTransition('\nда\n'), 'preserve');
  });
});

describe('Rule 2 — context-shift verbs clear pending', () => {
  test('imperative verbs at message start', () => {
    assert.equal(classifyPendingConfirmTransition('создай категорию Кафе'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('добавь категорию Спорт'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('удали последнюю'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('переименуй Кафе в Рестораны'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('покажи итоги'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('поставь лимит 50000 на еду'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('измени категорию'), 'clear-and-proceed');
  });

  test('verb conjugations (russianStem strips endings)', () => {
    assert.equal(classifyPendingConfirmTransition('создавать новые категории'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('добавила трату'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('удаление работает'), 'clear-and-proceed');
  });

  test('question forms with verb tokens', () => {
    assert.equal(classifyPendingConfirmTransition('сколько потратил на кофе'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('итоги месяца'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('найди транзакцию про кофе'), 'clear-and-proceed');
  });

  test('English verb fallbacks', () => {
    assert.equal(classifyPendingConfirmTransition('create a new category'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('add coffee 500'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('delete the last one'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('show me last month'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('set limit 50000 on food'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('find coffee'), 'clear-and-proceed');
  });

  test('verb appearing mid-message also triggers clear', () => {
    // Even if the verb isn't first, the user clearly intends a new action.
    assert.equal(classifyPendingConfirmTransition('а ну-ка покажи мне траты'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('слушай создай категорию Машина'), 'clear-and-proceed');
  });
});

describe('Rule 3 — nothing matched, preserve pending', () => {
  test('punctuation-only / mumbles', () => {
    assert.equal(classifyPendingConfirmTransition('?'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('??'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('...'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('hm'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('хм'), 'preserve');
  });

  test('bare digits', () => {
    // User C's case: with a pending question listing options, "1" or "2"
    // should let Sonnet see both the digit AND the pending state.
    assert.equal(classifyPendingConfirmTransition('1'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('2'), 'preserve');
  });

  test('empty / whitespace', () => {
    assert.equal(classifyPendingConfirmTransition(''), 'preserve');
    assert.equal(classifyPendingConfirmTransition('   '), 'preserve');
    assert.equal(classifyPendingConfirmTransition('\n\t'), 'preserve');
  });

  test('expense-like statements without context-shift verbs preserve', () => {
    // "кофе 500" is a logging intent but doesn't include "создай/добавь" etc.
    // Sonnet will still see it AND the pending state; existing logic decides.
    assert.equal(classifyPendingConfirmTransition('кофе 500'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('такси 2500'), 'preserve');
  });

  test('non-verb words preserve', () => {
    assert.equal(classifyPendingConfirmTransition('хорошо'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('понял'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('спасибо'), 'preserve');
  });
});

describe('Edge cases', () => {
  test('rule precedence is strict — confirm prefix wins over verb', () => {
    // Even if the user types "да удали" (confirm + verb), rule 1 fires first.
    // The verb appears after the confirm token; existing flow handles confirm.
    assert.equal(classifyPendingConfirmTransition('да удали'), 'preserve');
    assert.equal(classifyPendingConfirmTransition('нет, не надо создавать'), 'preserve');
  });

  test('verb-shaped but punctuated tokens still match', () => {
    assert.equal(classifyPendingConfirmTransition('создай!'), 'clear-and-proceed');
    assert.equal(classifyPendingConfirmTransition('покажи?'), 'clear-and-proceed');
  });
});
