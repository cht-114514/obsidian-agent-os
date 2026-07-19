import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSession,
  serializeSession,
  appendMessage,
  createEmptySession,
  trimSession,
  MAX_MESSAGES,
  archiveStamp,
} from '../src/chat-history.js';

describe('chat-history', () => {
  it('parseSession returns empty on bad input', () => {
    const s = parseSession('not json');
    assert.equal(s.messages.length, 0);
    assert.equal(s.version, 1);
  });

  it('roundtrips messages', () => {
    let s = createEmptySession();
    s = appendMessage(s, {
      role: 'user',
      text: '消化六月下半',
      skill: { id: 'me-digest', label: '/me-digest' },
      chips: [{ path: '手记/日记/x.md', kind: 'ref' }],
    });
    s = appendMessage(s, {
      role: 'agent',
      text: ':::confirm type=digest path=agent-inbox/pending/a.md\ntitle: t\nbody: b\n:::',
    });
    const raw = serializeSession(s);
    const back = parseSession(raw);
    assert.equal(back.messages.length, 2);
    assert.equal(back.messages[0].role, 'user');
    assert.match(back.messages[0].text, /六月/);
    assert.equal(back.messages[0].skill?.id, 'me-digest');
    assert.equal(back.messages[1].role, 'agent');
    assert.match(back.messages[1].text, /:::confirm/);
  });

  it('trimSession caps message count', () => {
    let s = createEmptySession();
    for (let i = 0; i < MAX_MESSAGES + 20; i++) {
      s = appendMessage(s, { role: 'user', text: `m${i}` });
    }
    assert.equal(s.messages.length, MAX_MESSAGES);
    assert.equal(s.messages[0].text, `m${20}`);
  });

  it('trimSession truncates huge agent text', () => {
    const huge = 'x'.repeat(200_000);
    let s = createEmptySession();
    s = appendMessage(s, { role: 'agent', text: huge });
    assert.ok(s.messages[0].text.length < huge.length);
    assert.match(s.messages[0].text, /截断/);
  });

  it('archiveStamp is filename-safe', () => {
    assert.match(archiveStamp(new Date('2026-07-19T08:05:09')), /^\d{8}-\d{6}$/);
  });
});
