// Smoke test — verifies node:test + tsx + TypeScript imports work.
// If this passes, the test runner is set up correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('test runner smoke test', () => {
  assert.equal(1 + 1, 2);
});
