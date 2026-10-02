import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeTime,
  historyToTurns,
  sessionBucket,
  stripInjectedContext,
} from '../src/ui/turns.js';
import { groupSessions, isUserSession, sessionLabel, sessionPreview } from '../src/ui/sidebar.js';
import { describeTool, formatDuration, workHeadline } from '../src/ui/work-run.js';
import { enterInsertsNewline, nextComposerAction } from '../src/ui/composer.js';
import { reduceActivity } from '../src/kernel/activity.js';

describe('stripInjectedContext', () => {
  it('keeps only the text after the sentinel', () => {
    const raw = '# Obsidian Agent OS 强制上下文（每轮注入，勿忽略）\n\n身份很长\n\n## 用户本轮消息\n\n这道题怎么做';
    assert.equal(stripInjectedContext(raw), '这道题怎么做');
  });

  it('returns plain text when there is no sentinel', () => {
    assert.equal(stripInjectedContext('就这一句'), '就这一句');
  });
});

describe('historyToTurns', () => {
  it('merges tool rows into the following assistant turn and strips context', () => {
    const turns = historyToTurns({
      messages: [
        {
          id: 'u1',
          role: 'user',
          text: '# 强制上下文\n\n## 用户本轮消息\n\n比较 9.9 和 9.11',
          timestamp: 1_700_000_000_000,
        },
        { role: 'tool', toolName: 'exec', toolCallId: 'c1', title: 'node calc.js' },
        { role: 'tool', toolName: 'read', toolCallId: 'c2', title: 'notes.md' },
        {
          id: 'a1',
          role: 'assistant',
          content: [
            { type: 'thinking', text: '先看十分位' },
            { type: 'text', text: '9.9 更大。' },
          ],
          timestamp: 1_700_000_030_000,
        },
      ],
    });
    assert.equal(turns.length, 2);
    assert.equal(turns[0].text, '比较 9.9 和 9.11');
    assert.equal(turns[1].text, '9.9 更大。');
    assert.equal(turns[1].activity.tools.length, 2);
    assert.equal(turns[1].activity.reasoning, '先看十分位');
    assert.equal(workHeadline(turns[1].activity), '2 次工具调用');
  });
});

describe('time and sessions', () => {
  const now = Date.parse('2026-10-01T12:00:00');

  it('formats relative time', () => {
    assert.equal(formatRelativeTime(now - 30_000, now), '刚刚');
    assert.equal(formatRelativeTime(now - 5 * 60_000, now), '5 分钟前');
    assert.equal(formatRelativeTime(now - 26 * 3600_000, now), '昨天');
  });

  it('groups sessions by day and filters search', () => {
    const sessions = [
      { key: 'agent:main:main', derivedTitle: '主会话', updatedAt: now - 60_000, lastMessagePreview: '今天的题' },
      { key: 'agent:main:old', label: '上周', updatedAt: now - 8 * 86400_000, lastMessagePreview: '旧笔记' },
    ];
    const groups = groupSessions(sessions, { now });
    assert.deepEqual(groups.map(([name]) => name), ['今天', '更早']);
    assert.equal(sessionLabel(sessions[0]), '主会话');
    assert.equal(sessionPreview(sessions[0]), '今天的题');
    const found = groupSessions(sessions, { now, query: '旧笔' });
    assert.equal(found.length, 1);
    assert.equal(found[0][0], '更早');
    assert.equal(sessionBucket(now, now), '今天');
  });

  it('hides cron and harness sessions from the drawer', () => {
    assert.equal(isUserSession({ key: 'agent:main:main' }), true);
    assert.equal(isUserSession({ key: 'agent:main:aos-abc' }), true);
    assert.equal(isUserSession({ key: 'agent:main:cron:job:run:1' }), false);
    assert.equal(isUserSession({ key: 'agent:main:subagent:worker' }), false);
    const groups = groupSessions(
      [
        { key: 'agent:main:main', updatedAt: now },
        { key: 'agent:main:cron:job:run:1', updatedAt: now },
      ],
      { now }
    );
    assert.equal(groups[0][1].length, 1);
    assert.equal(groups[0][1][0].key, 'agent:main:main');
  });
});

describe('work run copy', () => {
  it('turns tool names into verbs and formats duration', () => {
    assert.equal(describeTool({ name: 'exec', phase: 'done', title: 'npm test' }).label, '已执行 npm test');
    assert.equal(describeTool({ name: 'read', phase: 'start', title: 'a.md' }).verb, '正在读取');
    assert.equal(formatDuration(4 * 60_000 + 52_000), '4 分 52 秒');
    const activity = {
      tools: [
        { name: 'read', phase: 'done', title: 'a.md', startedAt: 1_000, endedAt: 20_000 },
        { name: 'exec', phase: 'done', title: 'ls', startedAt: 20_000, endedAt: 293_000 },
      ],
    };
    assert.equal(workHeadline(activity), '已工作 4 分 52 秒 · 2 次工具调用');
    assert.match(workHeadline({ tools: [], status: '思考中' }, { streaming: true }), /思考中/);
  });
});

describe('composer actions', () => {
  it('stops instead of sending while busy, and phones newline on enter', () => {
    assert.equal(nextComposerAction(false, 'primary'), 'send');
    assert.equal(nextComposerAction(true, 'primary'), 'abort');
    assert.equal(nextComposerAction(true, 'submit'), 'ignore');
    assert.equal(enterInsertsNewline(true), true);
    assert.equal(enterInsertsNewline(false), false);
  });
});

describe('activity timing', () => {
  it('records start and end on a tool', () => {
    let activity = reduceActivity(null, {
      type: 'event',
      event: 'agent',
      payload: { stream: 'tool', data: { phase: 'start', name: 'read', toolCallId: 'call-9', arguments: 'notes.md' } },
    });
    const started = activity.tools[0].startedAt;
    assert.ok(started > 0);
    assert.equal(activity.tools[0].args, 'notes.md');
    activity = reduceActivity(activity, {
      type: 'event',
      event: 'agent',
      payload: { stream: 'tool', data: { phase: 'result', name: 'read', toolCallId: 'call-9' } },
    });
    assert.equal(activity.tools[0].phase, 'done');
    assert.equal(activity.tools[0].startedAt, started);
    assert.ok(activity.tools[0].endedAt >= started);
  });
});
