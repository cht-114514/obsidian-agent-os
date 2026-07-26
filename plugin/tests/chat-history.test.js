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
  sessionToCmdbarTurns,
  summarizeSession,
  sessionContentFingerprint,
  formatRecentConversation,
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

  it('sessionToCmdbarTurns maps agent → assistant', () => {
    let s = createEmptySession();
    s = appendMessage(s, { role: 'user', text: 'hi' });
    s = appendMessage(s, { role: 'agent', text: '**hello**' });
    const turns = sessionToCmdbarTurns(s);
    assert.deepEqual(turns, [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: '**hello**' },
    ]);
  });

  it('summarizeSession uses first user text', () => {
    let s = createEmptySession();
    s = appendMessage(s, { role: 'user', text: '把公式写进笔记' });
    s = appendMessage(s, { role: 'agent', text: '好的' });
    const sum = summarizeSession(s, 'agent-inbox/sessions/archive/x.json');
    assert.equal(sum.path, 'agent-inbox/sessions/archive/x.json');
    assert.equal(sum.messageCount, 2);
    assert.match(sum.title, /公式/);
  });

  it('sessionContentFingerprint ignores ids, matches same dialogue', () => {
    let a = createEmptySession();
    a = appendMessage(a, { role: 'user', text: 'hello' });
    a = appendMessage(a, { role: 'agent', text: 'world' });
    let b = createEmptySession();
    b = appendMessage(b, { role: 'user', text: 'hello' });
    b = appendMessage(b, { role: 'agent', text: 'world' });
    assert.equal(sessionContentFingerprint(a), sessionContentFingerprint(b));
    b = appendMessage(b, { role: 'user', text: 'more' });
    assert.notEqual(sessionContentFingerprint(a), sessionContentFingerprint(b));
  });

  it('recent conversation keeps meaningful math context and skips empty turns', () => {
    let s = createEmptySession();
    s = appendMessage(s, { role: 'user', text: '变式1的思路是怎样的' });
    s = appendMessage(s, {
      role: 'agent',
      text: '配对后得到 -1/((4k-1)(4k+1))，再裂项。',
    });
    for (let i = 0; i < 3; i++) {
      s = appendMessage(s, { role: 'user', text: 'lie xiang' });
      s = appendMessage(s, { role: 'agent', text: '' });
    }
    s = appendMessage(s, { role: 'user', text: '裂项之后好像也没法求和' });

    const context = formatRecentConversation(s, {
      currentUserText: '裂项之后好像也没法求和',
    });
    assert.match(context, /变式1/);
    assert.match(context, /4k-1/);
    assert.doesNotMatch(context, /裂项之后好像也没法求和/);
    assert.equal((context.match(/### 助手/g) || []).length, 1);
  });
});
