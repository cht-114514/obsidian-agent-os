import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contentVersionHash,
  snapshotStillValid,
  formatSnapshotForPrompt,
} from '../src/context-snapshot-pure.js';

describe('context-snapshot', () => {
  it('contentVersionHash changes when body changes', () => {
    const a = contentVersionHash('hello');
    const b = contentVersionHash('hello!');
    assert.notEqual(a, b);
  });

  it('snapshotStillValid detects version mismatch', () => {
    const snap = { attached: true, path: 'a.md', contentVersion: contentVersionHash('v1') };
    assert.equal(snapshotStillValid(snap, 'v2').ok, false);
    assert.equal(snapshotStillValid(snap, 'v1').ok, true);
  });

  it('formatSnapshotForPrompt marks unattached', () => {
    assert.match(formatSnapshotForPrompt({ attached: false }), /未附带/);
  });
});
