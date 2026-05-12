// Layer 2 — bulk-create append-only regression suite.
//
// CRITICAL: this is @madikarim's exact failure mode. She typed 10 categories
// (overlapping with the 8 universal defaults), the bot interpreted "create"
// as "replace defaults", silently soft-deleted what she had, and she lost 25
// minutes recovering. Layer 2 removed `_replace_defaults` from both the
// propose path and the execute path. These tests lock that behavior so it
// can never silently regress.
//
// We test the agent.ts module source rather than spinning up Anthropic — the
// targeted edits are pure string operations + dead-code-removal that can be
// asserted from disk.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_SOURCE = readFileSync(join(__dirname, 'agent.ts'), 'utf8');

describe('Layer 2 — _replace_defaults removal', () => {
  test('no code path SETS _replace_defaults anywhere in agent.ts', () => {
    // The flag was set at agent.ts:1271 (`(input as Record<string, unknown>).
    // _replace_defaults = isFresh`) in the propose path. Layer 2 removed it.
    // If anyone re-adds it, this test catches it before deploy.
    assert.doesNotMatch(AGENT_SOURCE, /_replace_defaults\s*=/);
  });

  test('no code path READS _replace_defaults to branch behavior', () => {
    // The original `executeConfirmedAction` block read `a._replace_defaults`
    // to decide between replaceCategoriesForFreshFamily vs createCategoriesBulk.
    // Allow the symbol to appear in comments (the file documents why it was
    // removed) but not in runtime expressions.
    const lines = AGENT_SOURCE.split('\n');
    const codeMentions = lines.filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return /_replace_defaults/.test(t);
    });
    assert.equal(codeMentions.length, 0, `unexpected runtime mentions: ${codeMentions.join('\n')}`);
  });

  test('replaceCategoriesForFreshFamily is no longer imported or called in agent.ts', () => {
    // The function still exists in queries.ts (legacy, not deleted) but the
    // bot must not import or call it. Future power-user wipe-and-rebuild will
    // get a dedicated wipe_all_categories tool per TODOS.md.
    // We allow the name to appear in comments (the file documents *why* it
    // was removed) but not in runtime code.
    const lines = AGENT_SOURCE.split('\n');
    const codeMentions = lines.filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return /replaceCategoriesForFreshFamily/.test(t);
    });
    assert.equal(codeMentions.length, 0, `unexpected runtime mentions: ${codeMentions.join('\n')}`);
  });

  test('countActiveTransactions is no longer imported or called in agent.ts (was only used by the dead branch)', () => {
    // The propose-time fresh-family detection was the only caller. Drop the
    // import alongside the logic so we don't carry a phantom dependency.
    const lines = AGENT_SOURCE.split('\n');
    const codeMentions = lines.filter((line) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return /countActiveTransactions/.test(t);
    });
    assert.equal(codeMentions.length, 0, `unexpected runtime mentions: ${codeMentions.join('\n')}`);
  });

  test('propose_create_categories_bulk description warns AGAINST replace semantics', () => {
    // Tool description must steer Sonnet away from "wipe and rebuild" intents
    // — those flow through a different system-prompt rule now.
    const idx = AGENT_SOURCE.indexOf("name: 'propose_create_categories_bulk'");
    assert.ok(idx !== -1, 'tool definition not found');
    const block = AGENT_SOURCE.slice(idx, idx + 2000);
    assert.match(block, /Always APPENDS/i);
    assert.match(block, /[Ee]xisting categories are preserved/);
  });

  test('system prompt routes "удали все категории и оставь только X, Y, Z" to a clarification reply (NOT a tool)', () => {
    // The previous prompt routed that intent into propose_create_categories_bulk
    // (which silently replaced). New rule: refuse and ask user to delete by name.
    assert.match(AGENT_SOURCE, /Удаление категорий по одной/i);
    // The old "→ call propose_create_categories_bulk (handles replace)" line
    // must be gone.
    assert.doesNotMatch(AGENT_SOURCE, /propose_create_categories_bulk\s*\(handles replace\)/);
  });

  test('execute path branches are gone — single createCategoriesBulk call', () => {
    // The original `executeConfirmedAction` had a ternary that picked between
    // two queries based on `wantsReplace`. Now there's exactly one call.
    // The substring 'case create_categories_bulk' appears in BOTH
    // buildProposalMessage (just renders text) and executeConfirmedAction
    // (the case we care about). Anchor on the function DECLARATION
    // ('async function executeConfirmedAction') not just the symbol name,
    // because the name also appears in doc comments earlier in the file.
    const execFnIdx = AGENT_SOURCE.indexOf('async function executeConfirmedAction');
    assert.ok(execFnIdx !== -1, 'executeConfirmedAction declaration not found');
    const execCaseIdx = AGENT_SOURCE.indexOf("case 'create_categories_bulk':", execFnIdx);
    assert.ok(execCaseIdx !== -1, 'execute case not found');
    const block = AGENT_SOURCE.slice(execCaseIdx, execCaseIdx + 800);
    assert.doesNotMatch(block, /wantsReplace/);
    const calls = block.match(/createCategoriesBulk\s*\(/g) ?? [];
    assert.equal(calls.length, 1, `expected exactly one createCategoriesBulk call, got ${calls.length}`);
  });
});
