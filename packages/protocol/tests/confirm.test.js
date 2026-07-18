import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  transitionConfirm,
  parsePendingMarkdown,
  serializePendingMarkdown,
  approvePendingMarkdown,
  rejectPendingMarkdown,
  applyPendingMarkdown,
} from '../src/confirm.js';

const samplePending = `---
status: pending
type: insight
title: 偏好更新
created: 2026-07-18
path: agent-inbox/soul/profile.md
source_paths: ["手记/随记/demo.md"]
---

用户更希望苏格拉底式追问。
`;

describe('confirm state machine', () => {
  it('allows pending→approved and pending→rejected only from pending', () => {
    assert.equal(canTransition('pending', 'approved'), true);
    assert.equal(canTransition('pending', 'rejected'), true);
    assert.equal(canTransition('pending', 'applied'), false);
    assert.equal(canTransition('rejected', 'applied'), false);
    assert.equal(canTransition('approved', 'applied'), true);
  });

  it('approvePendingMarkdown transitions pending → approved', () => {
    const r = approvePendingMarkdown(samplePending);
    assert.equal(r.ok, true);
    const parsed = parsePendingMarkdown(r.markdown);
    assert.equal(parsed.status, 'approved');
    assert.match(parsed.body, /苏格拉底/);
  });

  it('rejectPendingMarkdown transitions pending → rejected', () => {
    const r = rejectPendingMarkdown(samplePending);
    assert.equal(r.ok, true);
    assert.equal(parsePendingMarkdown(r.markdown).status, 'rejected');
  });

  it('applyPendingMarkdown only from approved', () => {
    const fail = applyPendingMarkdown(samplePending);
    assert.equal(fail.ok, false);

    const approved = approvePendingMarkdown(samplePending);
    const applied = applyPendingMarkdown(approved.markdown);
    assert.equal(applied.ok, true);
    assert.equal(parsePendingMarkdown(applied.markdown).status, 'applied');
  });

  it('serialize/parse pending preserves source_paths', () => {
    const rec = parsePendingMarkdown(samplePending);
    const md = serializePendingMarkdown(rec);
    const again = parsePendingMarkdown(md);
    assert.deepEqual(again.source_paths, ['手记/随记/demo.md']);
  });

  it('illegal transition returns error', () => {
    const r = transitionConfirm({ status: 'applied' }, 'pending');
    assert.equal(r.ok, false);
  });
});
