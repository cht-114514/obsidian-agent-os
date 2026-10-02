import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduceActivity } from '../src/kernel/activity.js';

describe('live activity', () => {
  it('shows tool start and result without dropping the name', () => {
    let activity = reduceActivity(null, {
      type: 'event',
      event: 'agent',
      payload: {
        stream: 'tool',
        data: { phase: 'start', name: 'read', toolCallId: 'call-1' },
      },
    });
    activity = reduceActivity(activity, {
      type: 'event',
      event: 'agent',
      payload: {
        stream: 'tool',
        data: { phase: 'result', name: 'read', toolCallId: 'call-1' },
      },
    });
    assert.equal(activity.tools.length, 1);
    assert.equal(activity.tools[0].name, 'read');
    assert.equal(activity.tools[0].phase, 'done');
  });

  it('accumulates reasoning and keeps a model default status', () => {
    let activity = reduceActivity(null, {
      type: 'event',
      event: 'chat',
      payload: { state: 'status', phase: 'starting_model' },
    });
    assert.equal(activity.status, '思考中');
    activity = reduceActivity(activity, {
      type: 'event',
      event: 'agent',
      payload: { stream: 'thinking', data: { delta: '先比较十分位' } },
    });
    activity = reduceActivity(activity, {
      type: 'event',
      event: 'agent',
      payload: { stream: 'thinking', data: { delta: '，9 更大' } },
    });
    assert.equal(activity.reasoning, '先比较十分位，9 更大');
  });

  it('reads reasoning blocks from the chat snapshot', () => {
    const activity = reduceActivity(null, {
      type: 'event',
      event: 'chat',
      payload: {
        state: 'delta',
        message: { content: [{ type: 'thinking', text: '内部推导' }, { type: 'text', text: '9.9' }] },
      },
    });
    assert.equal(activity.reasoning, '内部推导');
  });
});
