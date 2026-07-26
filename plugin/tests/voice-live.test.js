import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextLiveState,
  buildHandoffOpenOpts,
  liveStateClasses,
} from '../src/voice-live.js';

describe('voice-live state machine', () => {
  it('start from idle → listening', () => {
    assert.equal(nextLiveState('idle', 'start'), 'listening');
  });

  it('stop while listening → handing_off', () => {
    assert.equal(nextLiveState('listening', 'stop'), 'handing_off');
  });

  it('cancel / empty → idle', () => {
    assert.equal(nextLiveState('listening', 'cancel'), 'idle');
    assert.equal(nextLiveState('handing_off', 'empty'), 'idle');
  });

  it('busy → thinking', () => {
    assert.equal(nextLiveState('handing_off', 'busy'), 'thinking');
    assert.equal(nextLiveState('idle', 'busy'), 'thinking');
  });

  it('ignores start while already listening', () => {
    assert.equal(nextLiveState('listening', 'start'), 'listening');
  });
});

describe('voice-live handoff opts', () => {
  it('builds autoSubmit open opts with keepHistory when cmdbar open', () => {
    const opts = buildHandoffOpenOpts({
      text: '  把这段写进笔记  ',
      cmdbarOpen: true,
    });
    assert.deepEqual(opts, {
      seedText: '把这段写进笔记',
      autoSubmit: true,
      keepHistory: true,
      forceOpen: true,
    });
  });

  it('keepHistory false when cmdbar closed', () => {
    const opts = buildHandoffOpenOpts({ text: 'hello', cmdbarOpen: false });
    assert.equal(opts.keepHistory, false);
    assert.equal(opts.autoSubmit, true);
  });
});

describe('voice-live css classes', () => {
  it('maps listening / thinking / handing_off', () => {
    assert.deepEqual(liveStateClasses('listening'), {
      'is-listening': true,
      'is-handing-off': false,
      'is-thinking': false,
    });
    assert.deepEqual(liveStateClasses('thinking'), {
      'is-listening': false,
      'is-handing-off': false,
      'is-thinking': true,
    });
    assert.deepEqual(liveStateClasses('handing_off'), {
      'is-listening': false,
      'is-handing-off': true,
      'is-thinking': false,
    });
    assert.deepEqual(liveStateClasses('idle'), {
      'is-listening': false,
      'is-handing-off': false,
      'is-thinking': false,
    });
  });
});
