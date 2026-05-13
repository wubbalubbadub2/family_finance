// Layer 1 — welcome text regression suite.
//
// Locks the post-2026-05-10 welcome wording in place. The earlier wall-of-text
// version produced 27 / 30 silent customers (90% drop after the first message).
// If anyone shortens the welcome further OR reverts toward feature dumping,
// these assertions force a deliberate decision in code review instead of a
// quiet drift.
//
// Tests exercise the exported text builders directly, not the full bot — keeps
// the suite pure (no Telegram, no DB, no Anthropic).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildWelcomeText, buildWelcomeBackText } from './handlers';

describe('buildWelcomeText (fresh-user onboarding)', () => {
  test('renders name in greeting', () => {
    const out = buildWelcomeText('Сабина');
    assert.match(out, /Сабина/);
  });

  test('includes the three concrete examples', () => {
    const out = buildWelcomeText('Тест');
    assert.match(out, /кофе 500/);
    assert.match(out, /такси 2300/);
    assert.match(out, /зарплата 500 000/);
  });

  test('stays under 350 chars (anti-wall-of-text guard)', () => {
    // Old version was 1042 chars. Stay well under that. If we want to add
    // a debt disclaimer later (~80 chars) bump this to 450 deliberately.
    const out = buildWelcomeText('Тест');
    assert.ok(out.length < 350, `welcome too long (${out.length} chars): ${out}`);
  });

  test('does NOT enumerate default categories (the dropped wall-of-text behavior)', () => {
    const out = buildWelcomeText('Тест');
    // Old version listed 8 emoji+name pairs. None of these standard
    // category emoji should appear in the new welcome.
    assert.doesNotMatch(out, /🛒.*Продукты/);
    assert.doesNotMatch(out, /💊.*Здоровье/);
    assert.doesNotMatch(out, /🎲.*Разное/);
  });

  test('does NOT pitch future engagement (the dropped homework framing)', () => {
    const out = buildWelcomeText('Тест');
    // The "чем больше пишешь, тем больше ценность" line was flagged in the
    // 2026-05-10 second-opinion review as engagement-farming homework.
    assert.doesNotMatch(out, /чем больше/i);
    assert.doesNotMatch(out, /ценность/i);
  });

  test('includes the "что умеет бот" CTA and the privacy disclaimer', () => {
    // Added 2026-05-13: the welcome should nudge users into discovering
    // the help command and reassure them about data safety.
    const out = buildWelcomeText('Тест');
    assert.match(out, /спроси что умеет бот/i);
    assert.match(out, /<i>Твои данные в безопасности<\/i>/);
  });
});

describe('buildWelcomeBackText (returning-user /start)', () => {
  test('is one line, no name', () => {
    const out = buildWelcomeBackText();
    // Greeting line + optional example bullet; should not contain {name}-style
    // placeholder substitution since the function takes no args.
    assert.doesNotMatch(out, /\{[a-z]+\}/i);
  });

  test('includes the concrete example', () => {
    const out = buildWelcomeBackText();
    assert.match(out, /кофе 500/);
  });

  test('stays under 200 chars', () => {
    const out = buildWelcomeBackText();
    assert.ok(out.length < 200, `welcome-back too long (${out.length} chars)`);
  });
});
