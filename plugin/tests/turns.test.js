import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeTime,
  historyToTurns,
  mergeTranscript,
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

  it('joins later assistant fragments and tool batches into that same turn', () => {
    const turns = historyToTurns({
      messages: [
        { id: 'u1', role: 'user', text: '搜一下', timestamp: 1_000 },
        { id: 'a1', role: 'assistant', text: '先并行拉几路。', timestamp: 2_000 },
        { role: 'tool', toolName: 'exec', toolCallId: 'c1', title: 'exa', timestamp: 2_100 },
        { role: 'tool', toolName: 'exec', toolCallId: 'c2', title: 'exa', timestamp: 2_200 },
        { id: 'a2', role: 'assistant', text: '再补一路。', timestamp: 3_000 },
        { role: 'tool', toolName: 'search', toolCallId: 'c3', title: 'web', timestamp: 3_100 },
        { role: 'tool', toolName: 'search', toolCallId: 'c4', timestamp: 3_200 },
        { id: 'a3', role: 'assistant', text: '', timestamp: 4_000 },
        { id: 'u2', role: 'user', text: '下一问', timestamp: 5_000 },
        { id: 'a4', role: 'assistant', text: '好。', timestamp: 6_000 },
      ],
    });
    assert.equal(turns.length, 4);
    assert.equal(turns[1].id, 'a1');
    assert.equal(turns[1].text, '先并行拉几路。\n\n再补一路。');
    assert.equal(turns[1].activity.tools.length, 4);
    assert.equal(turns[1].activity.tools[3].name, 'search');
    assert.equal(turns[2].text, '下一问');
    assert.equal(turns[3].text, '好。');
    assert.equal(turns[3].activity.tools.length, 0);
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
    assert.equal(formatDuration(400), '不到 1 秒');
    assert.equal(formatDuration(0), '');
    const quick = {
      tools: [
        { name: 'exec', phase: 'done', startedAt: 1_000, endedAt: 1_400 },
        { name: 'search', phase: 'done', startedAt: 1_400, endedAt: 1_800 },
      ],
    };
    assert.equal(workHeadline(quick), '已工作 不到 1 秒 · 2 次工具调用');
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

describe('mergeTranscript', () => {
  const localUser = { id: 'u-local', role: 'user', text: '离线写的', ts: 5000, turnId: 't-off' };
  const localDraft = {
    id: 'a-local',
    role: 'assistant',
    text: '待发出（已排队）',
    ts: 5000,
    turnId: 't-off',
    turnStatus: 'queued',
  };
  const remoteOld = { id: 'h1', role: 'user', text: '上一条', ts: 1000, turnId: 'h1' };
  const remoteOldReply = { id: 'h2', role: 'assistant', text: '好的', ts: 2000, turnId: 'h2' };
  const remoteEcho = { id: 'h3', role: 'user', text: '离线写的', ts: 5001, turnId: 'h3' };
  const remoteReply = { id: 'h4', role: 'assistant', text: '收到', ts: 6000, turnId: 'h4' };

  it('keeps a local message the Mac has not seen yet', () => {
    const merged = mergeTranscript([remoteOld, remoteOldReply, localUser, localDraft], [
      remoteOld,
      remoteOldReply,
    ]);
    assert.deepEqual(
      merged.map((row) => row.text),
      ['上一条', '好的', '离线写的', '待发出（已排队）']
    );
  });

  it('adopts the Mac reply for a turn the Mac did see, keeping the local id', () => {
    const merged = mergeTranscript([localUser, localDraft], [remoteEcho, remoteReply]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, 'u-local');
    assert.equal(merged[0].turnId, 't-off');
    assert.equal(merged[0].role, 'user');
    assert.equal(merged[1].id, 'a-local');
    assert.equal(merged[1].turnId, 't-off');
    assert.equal(merged[1].text, '收到');
  });

  it('never drops a queued message when history is empty or partial', () => {
    assert.deepEqual(mergeTranscript([localUser, localDraft], []), [localUser, localDraft]);
    const partial = mergeTranscript([remoteOld, remoteOldReply, localUser, localDraft], [remoteOld]);
    assert.equal(partial.length, 4);
    assert.ok(partial.some((row) => row.turnId === 't-off'));
  });

  it('does not duplicate a remote message that is also local', () => {
    const merged = mergeTranscript([remoteOld, localUser, localDraft], [remoteOld, remoteEcho, remoteReply]);
    assert.equal(merged.filter((row) => row.role === 'user' && row.text === '离线写的').length, 1);
    assert.equal(merged.filter((row) => row.text === '上一条').length, 1);
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
