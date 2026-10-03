import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseSession, lastUserMessageAt } from '../src/kernel/chat-session-sync.js';

describe('chat-session-sync', () => {
  it('lastUserMessageAt uses user rows only', () => {
    const ts = lastUserMessageAt([
      { role: 'assistant', ts: 900 },
      { role: 'user', ts: 500 },
      { role: 'user', ts: 800 },
    ]);
    assert.equal(ts, 800);
  });

  it('chooseSession keeps local draft', () => {
    const pick = chooseSession({
      sessions: [{ key: 'agent:main:main' }],
      activeKey: 'agent:main:local',
      messages: [],
      composerDraft: 'hello',
      getTranscript: () => [],
      listPending: () => [],
    });
    assert.equal(pick.reason, 'keep_local');
    assert.equal(pick.key, 'agent:main:local');
  });

  it('chooseSession picks recent user session', () => {
    const pick = chooseSession({
      sessions: [
        { key: 'agent:main:main', updatedAt: 1 },
        { key: 'agent:main:other', updatedAt: 2 },
      ],
      activeKey: '',
      messages: [],
      composerDraft: '',
      getTranscript: (key) =>
        key === 'agent:main:other' ? [{ role: 'user', ts: 9999, text: 'x' }] : [],
      listPending: () => [],
    });
    assert.equal(pick.key, 'agent:main:other');
  });
});
