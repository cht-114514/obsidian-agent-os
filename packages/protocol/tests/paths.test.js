import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkWritePolicy,
  assertWritesAllowed,
  isHumanZonePath,
  isAgentInboxPath,
} from '../src/paths.js';

describe('write policy', () => {
  it('allows agent-inbox free writes', () => {
    assert.equal(checkWritePolicy('agent-inbox/wiki/x.md').allowed, true);
    assert.equal(checkWritePolicy('agent-inbox/soul/profile.md').allowed, true);
    assert.equal(checkWritePolicy('agent-inbox/pending/a.md').allowed, true);
    assert.equal(isAgentInboxPath('agent-inbox/foo'), true);
  });

  it('blocks human zones without approved pending', () => {
    for (const z of ['手记/日记/a.md', '项目库/x/00.md', '资料库/成绩/a.pdf', '基础学科/数学/t.md']) {
      const r = checkWritePolicy(z);
      assert.equal(r.allowed, false, z);
      assert.equal(isHumanZonePath(z), true);
    }
  });

  it('allows human zones only with approvedPending', () => {
    const r = checkWritePolicy('手记/日记/a.md', { approvedPending: true });
    assert.equal(r.allowed, true);
  });

  it('assertWritesAllowed reports violations', () => {
    const r = assertWritesAllowed([
      'agent-inbox/wiki/ok.md',
      '手记/bad.md',
    ]);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].path, '手记/bad.md');
  });

  it('blocks path traversal', () => {
    assert.equal(checkWritePolicy('agent-inbox/../手记/x.md').allowed, false);
  });
});
