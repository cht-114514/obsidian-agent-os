import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextStepFor, phaseLabel } from '../src/ui/turn-phase.js';

describe('turn phase', () => {
  it('keeps connection words out of the task label', () => {
    assert.equal(phaseLabel({ status: 'preparing' }), '准备上下文');
    assert.equal(phaseLabel({ status: 'prep_failed' }), '上下文读取失败');
    assert.equal(phaseLabel({ status: 'unconfirmed' }), '未确认发送');
    assert.equal(phaseLabel({ status: 'queued' }), '待发送');
    assert.equal(phaseLabel({ status: 'sending', delivered: true }), '已送达');
    assert.equal(phaseLabel({ status: 'sending', hasText: true }), '正在回复');
    assert.equal(phaseLabel({ stalled: true }), '等待模型回复');
    assert.equal(phaseLabel({ confirmingStop: true }), '正在确认停止');
    assert.equal(phaseLabel({ status: 'failed' }), '失败');
    assert.equal(phaseLabel({ status: 'aborted' }), '已停止');
  });

  it('names a next step without pretending a failure was sent again', () => {
    assert.match(nextStepFor('failed', { code: 'MODEL_REJECTED' }), /没有改用其他模型/);
    assert.match(nextStepFor('unknown', { code: 'NETWORK' }), /不会重跑/);
  });
});
