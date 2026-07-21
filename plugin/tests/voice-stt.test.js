import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  downsampleBuffer,
  floatTo16BitPCM,
  encodeWav,
  resolveXaiApiKey,
  joinSegments,
  accumulateTranscript,
  displayTranscript,
} from '../src/voice-stt.js';

describe('voice-stt helpers', () => {
  it('downsample halves length at 2x rate', () => {
    const input = new Float32Array([0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5]);
    const out = downsampleBuffer(input, 32000, 16000);
    assert.equal(out.length, 4);
  });

  it('floatTo16BitPCM clamps', () => {
    const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]));
    assert.equal(pcm[0], 0);
    assert.equal(pcm[1], 0x7fff);
    assert.equal(pcm[2], -0x8000);
  });

  it('encodeWav has RIFF header and correct size', () => {
    const samples = new Int16Array([0, 100, -100]);
    const buf = encodeWav(samples, 16000);
    const u8 = new Uint8Array(buf);
    assert.equal(String.fromCharCode(u8[0], u8[1], u8[2], u8[3]), 'RIFF');
    assert.equal(String.fromCharCode(u8[8], u8[9], u8[10], u8[11]), 'WAVE');
    assert.equal(buf.byteLength, 44 + samples.length * 2);
  });

  it('resolveXaiApiKey prefers settings', () => {
    const k = resolveXaiApiKey({ xaiApiKey: '  test-key-abc  ' });
    assert.equal(k, 'test-key-abc');
  });
});

describe('joinSegments', () => {
  it('joins Latin with a space', () => {
    assert.equal(joinSegments('hello', 'world'), 'hello world');
  });

  it('joins CJK without a space', () => {
    assert.equal(joinSegments('今天天气', '真不错'), '今天天气真不错');
  });

  it('joins CJK + Latin sensibly', () => {
    assert.equal(joinSegments('我说', 'hello'), '我说hello');
    assert.equal(joinSegments('hello', '世界'), 'hello世界');
  });

  it('handles empty sides', () => {
    assert.equal(joinSegments('', 'hi'), 'hi');
    assert.equal(joinSegments('hi', ''), 'hi');
  });
});

describe('accumulateTranscript', () => {
  it('replaces interim without losing committed', () => {
    let s = { committed: '第一段', interim: '' };
    let r = accumulateTranscript(s, {
      type: 'transcript.partial',
      text: '临时A',
      is_final: false,
    });
    assert.equal(r.display, '第一段临时A');
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '临时B',
      is_final: false,
    });
    assert.equal(r.state.committed, '第一段');
    assert.equal(r.display, '第一段临时B');
  });

  it('accumulates chunk finals across a long dictation', () => {
    let state = { committed: '', interim: '' };
    // interim first sentence
    let r = accumulateTranscript(state, {
      type: 'transcript.partial',
      text: '今天我想讨论一下项目进度',
      is_final: false,
    });
    assert.match(r.display, /项目进度/);

    // chunk final locks it
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '今天我想讨论一下项目进度',
      is_final: true,
      speech_final: false,
    });
    assert.equal(r.state.committed, '今天我想讨论一下项目进度');
    assert.equal(r.state.interim, '');

    // next interim (would overwrite under the old bug)
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '然后还有预算问题',
      is_final: false,
    });
    assert.equal(r.display, '今天我想讨论一下项目进度然后还有预算问题');

    // second chunk final
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '然后还有预算问题',
      is_final: true,
      speech_final: false,
    });
    assert.equal(r.state.committed, '今天我想讨论一下项目进度然后还有预算问题');

    // last interim + speech final
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '先这样吧',
      is_final: false,
    });
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: '先这样吧',
      is_final: true,
      speech_final: true,
    });
    assert.equal(r.display, '今天我想讨论一下项目进度然后还有预算问题先这样吧');
    // Old bug would only keep "先这样吧"
    assert.notEqual(r.display, '先这样吧');
  });

  it('accumulates Latin chunk finals with spaces', () => {
    let r = accumulateTranscript(
      { committed: '', interim: '' },
      { type: 'transcript.partial', text: 'hello world', is_final: true }
    );
    r = accumulateTranscript(r.state, {
      type: 'transcript.partial',
      text: 'and more',
      is_final: true,
    });
    assert.equal(r.display, 'hello world and more');
  });

  it('transcript.done prefers server text else local join', () => {
    const local = accumulateTranscript(
      { committed: '已提交', interim: '未定' },
      { type: 'transcript.done', text: '' }
    );
    assert.equal(local.display, '已提交未定');

    const server = accumulateTranscript(
      { committed: '已提交', interim: '未定' },
      { type: 'transcript.done', text: 'server full text' }
    );
    assert.equal(server.display, 'server full text');
  });

  it('displayTranscript joins state', () => {
    assert.equal(
      displayTranscript({ committed: 'A', interim: 'B' }),
      'A B'
    );
  });
});
