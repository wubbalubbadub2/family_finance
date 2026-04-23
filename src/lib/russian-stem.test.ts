// Tests for russianStem — the morphological fallback inside
// searchTransactionsByComment. If this breaks, "сколько потратили на агушу"
// stops matching comments that contain "агуша" and users get 0 results.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { russianStem } from './db/queries';

describe('russianStem — Russian morphology normalization', () => {
  // Short words: never trim (too risky, creates false positives)
  test('short words (≤4 chars) pass through unchanged', () => {
    assert.equal(russianStem('кот'), 'кот');
    assert.equal(russianStem('дом'), 'дом');
    assert.equal(russianStem('три'), 'три');
    assert.equal(russianStem('хлеб'), 'хлеб');
  });

  // The agusha case — 4 common forms collapse to a stem that
  // ILIKE '%агуш%' matches for all forms including the full nominative.
  test('агуша family (the prod bug that triggered this)', () => {
    assert.equal(russianStem('агушу'), 'агуш');    // accusative
    assert.equal(russianStem('агуши'), 'агуш');    // plural / genitive
    assert.equal(russianStem('агуша'), 'агуш');    // nominative
    assert.equal(russianStem('агушой'), 'агуш');   // instrumental f.
    assert.equal(russianStem('агушами'), 'агуш');  // instrumental pl.
  });

  test('чипсы / чипсов / чипсами all reduce to a common stem', () => {
    const s1 = russianStem('чипсы');
    const s2 = russianStem('чипсов');
    const s3 = russianStem('чипсами');
    // All three should start with "чипс" (the root)
    assert.ok(s1.startsWith('чипс'), `чипсы stemmed to ${s1}`);
    assert.ok(s2.startsWith('чипс'), `чипсов stemmed to ${s2}`);
    assert.ok(s3.startsWith('чипс'), `чипсами stemmed to ${s3}`);
  });

  test('кофе (indeclinable, 4 chars) is not trimmed', () => {
    assert.equal(russianStem('кофе'), 'кофе');
  });

  test('бензин / бензина / бензином reduce to a common stem', () => {
    const s1 = russianStem('бензин');
    const s2 = russianStem('бензина');
    const s3 = russianStem('бензином');
    assert.ok(s1.startsWith('бензин'), `бензин → ${s1}`);
    assert.ok(s2.startsWith('бензин'), `бензина → ${s2}`);
    assert.ok(s3.startsWith('бензин'), `бензином → ${s3}`);
  });
});
