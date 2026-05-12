// Credit-balance alert pattern coverage.
//
// On 2026-05-11, Anthropic ran out of credits at 12:15 UTC and the bot
// returned raw 400 error replies to ~263 user attempts before the founder
// noticed at 00:51 UTC the next day. matchCriticalPattern is the detector
// that drives the post-incident admin DM alert.
//
// These tests lock the exact message shapes that triggered the outage so
// future "we changed the regex and it stopped matching" silent regressions
// are caught here, not in production at 3am.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matchCriticalPattern } from './observability';

describe('matchCriticalPattern — Anthropic credit-balance', () => {
  test('exact error shape from the 2026-05-11 outage', () => {
    const msg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
    const hit = matchCriticalPattern(msg);
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:credit-balance');
  });

  test('case-insensitive match', () => {
    assert.ok(matchCriticalPattern('CREDIT BALANCE IS TOO LOW'));
    assert.ok(matchCriticalPattern('Your Credit Balance Is Too Low'));
  });

  test('matches even with surrounding noise', () => {
    assert.ok(matchCriticalPattern('Anthropic SDK error: credit balance is too low to access the API'));
  });
});

describe('matchCriticalPattern — invalid key', () => {
  test('invalid x-api-key shape', () => {
    const hit = matchCriticalPattern('invalid x-api-key');
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:invalid-key');
  });

  test('401 status code variant', () => {
    const hit = matchCriticalPattern('401 unauthorized');
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:invalid-key');
  });

  test('authentication failed variant', () => {
    const hit = matchCriticalPattern('authentication_failed: bad token');
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:invalid-key');
  });
});

describe('matchCriticalPattern — rate limit', () => {
  test('rate_limit_error type', () => {
    const hit = matchCriticalPattern('rate_limit_error: too many requests');
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:rate-limit');
  });

  test('429 status code', () => {
    const hit = matchCriticalPattern('429 too many requests');
    assert.ok(hit, 'expected match');
    assert.equal(hit!.key, 'anthropic:rate-limit');
  });
});

describe('matchCriticalPattern — non-critical errors do NOT alert', () => {
  test('user-facing 400s that are not critical', () => {
    // A user typing nonsense that fails validation should NOT page the admin.
    assert.equal(matchCriticalPattern('Сумма должна быть > 0'), null);
    assert.equal(matchCriticalPattern('Категория не найдена'), null);
    assert.equal(matchCriticalPattern('bot removed from chat'), null);
  });

  test('Supabase / network errors', () => {
    assert.equal(matchCriticalPattern('connect ETIMEDOUT'), null);
    assert.equal(matchCriticalPattern('Network request failed'), null);
    assert.equal(matchCriticalPattern('duplicate key value violates unique constraint'), null);
  });

  test('Random Anthropic 500s (transient — Anthropic\'s problem, not ours)', () => {
    assert.equal(matchCriticalPattern('500 internal_server_error'), null);
    assert.equal(matchCriticalPattern('Overloaded'), null);
  });

  test('empty / weird input', () => {
    assert.equal(matchCriticalPattern(''), null);
    assert.equal(matchCriticalPattern('   '), null);
  });
});
