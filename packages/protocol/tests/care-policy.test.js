import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaresMarkdown,
  isInQuietHours,
  canSendCare,
  selectCareItems,
  serializePendingCare,
  countPendingCareItems,
} from '../src/care-policy.js';

const sampleCares = `---
daily_cap: 3
---

# Cares

- 每日主动消息 **≤ 3**
- Quiet hours：默认 23:30–07:00 不主动

## 黑名单

| 何时 | 范围 | 原因 |
|------|------|------|
| （空） | | |
`;

describe('care policy', () => {
  it('parses daily_cap and quiet hours from cares.md', () => {
    const c = parseCaresMarkdown(sampleCares);
    assert.equal(c.dailyCap, 3);
    assert.equal(c.quietHours.start, '23:30');
    assert.equal(c.quietHours.end, '07:00');
  });

  it('detects quiet hours wrapping midnight', () => {
    const qh = { start: '23:30', end: '07:00' };
    assert.equal(isInQuietHours(new Date('2026-07-18T23:45:00'), qh), true);
    assert.equal(isInQuietHours(new Date('2026-07-18T03:00:00'), qh), true);
    assert.equal(isInQuietHours(new Date('2026-07-18T12:00:00'), qh), false);
  });

  it('enforces daily cap', () => {
    const c = parseCaresMarkdown(sampleCares);
    const gate = canSendCare(c, new Date('2026-07-18T12:00:00'), { sentToday: 3 });
    assert.equal(gate.ok, false);
    assert.match(gate.reason, /cap/);
  });

  it('suppresses on blacklist and quietToday', () => {
    const withBl = sampleCares.replace('（空）', '2026-07-18') + '\nquietToday: true\n';
    // force blacklist parse by replacing empty
    const md = `---
daily_cap: 3
quietToday: true
---
## 黑名单
| 何时 | 范围 | 原因 |
| 2026-07-18 | all | 用户说别烦 |
`;
    const c = parseCaresMarkdown(md);
    assert.equal(c.quietToday, true);
    const gate = canSendCare(c, new Date('2026-07-18T12:00:00'));
    assert.equal(gate.ok, false);
  });

  it('drops candidates without evidence and respects remaining cap', () => {
    const c = parseCaresMarkdown(sampleCares);
    const { items } = selectCareItems(
      [
        { id: 'a', message: 'no evidence', evidence: [], priority: 10 },
        { id: 'b', message: 'ok', evidence: ['agent-inbox/pending/x.md'], priority: 5 },
        { id: 'c', message: 'ok2', evidence: ['agent-inbox/pending/y.md'], priority: 1 },
        { id: 'd', message: 'ok3', evidence: ['agent-inbox/pending/z.md'], priority: 1 },
        { id: 'e', message: 'ok4', evidence: ['agent-inbox/pending/w.md'], priority: 0 },
      ],
      c,
      { sentToday: 0, now: new Date('2026-07-18T12:00:00') }
    );
    assert.equal(items.length, 3); // cap 3
    assert.ok(items.every((i) => i.evidence.length > 0));
    assert.equal(items[0].id, 'b'); // highest priority among valid
  });

  it('serializePendingCare empty and non-empty', () => {
    const empty = serializePendingCare([]);
    assert.match(empty, /无未读牵挂/);
    assert.equal(countPendingCareItems(empty), 0);

    const filled = serializePendingCare([
      { id: 'pending-pile', message: '有 4 条 pending', evidence: ['agent-inbox/pending/a.md'] },
    ]);
    assert.equal(countPendingCareItems(filled), 1);
    assert.match(filled, /pending-pile/);
  });

  it('returns empty items when in quiet hours', () => {
    const c = parseCaresMarkdown(sampleCares);
    const r = selectCareItems(
      [{ id: 'x', message: 'hi', evidence: ['agent-inbox/x.md'] }],
      c,
      { now: new Date('2026-07-18T23:45:00'), sentToday: 0 }
    );
    assert.equal(r.items.length, 0);
    assert.match(r.suppressedReason, /quiet/);
  });
});
