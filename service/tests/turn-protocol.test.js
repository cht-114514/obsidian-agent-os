import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatSendParams, classifyRun, progressPreview, sessionPatchForTurn } from '../src/turn-protocol.js';

describe('turn protocol', () => {
  it('patches the session model and does not put model on chat.send', () => {
    const turn = { sessionKey: 'agent:main:main', message: 'hi', runId: 'run-1', model: 'dmxapi/deepseek-v4.1-flash', thinking: 'off' };
    assert.deepEqual(sessionPatchForTurn(turn), {
      key: 'agent:main:main',
      model: 'dmxapi/deepseek-v4.1-flash',
      thinkingLevel: 'off',
    });
    const send = chatSendParams(turn);
    assert.equal(send.thinking, 'off');
    assert.equal('model' in send, false);
  });

  it('keeps progress moving after the preview cap', () => {
    const first = progressPreview('a'.repeat(5000), 100);
    const second = progressPreview(`${'a'.repeat(5000)}b`, 100);
    assert.notEqual(first, second);
    assert.match(second, /^…\(5001\)/);
  });

  it('does not call a tool-use row finished, and treats a missing run as uncertain', () => {
    const tool = classifyRun(
      [{ role: 'assistant', text: 'mid', stopReason: 'toolUse', __openclaw: { runId: 'r' } }],
      'r'
    );
    assert.equal(tool.found, true);
    assert.equal(tool.finished, false);
    const missing = classifyRun([], 'r');
    assert.equal(missing.found, false);
    assert.equal(missing.uncertain, true);
    const done = classifyRun(
      [{ role: 'assistant', text: 'answer', stopReason: 'stop', __openclaw: { runId: 'r' } }],
      'r'
    );
    assert.equal(done.finished, true);
    assert.equal(done.text, 'answer');
  });
});
