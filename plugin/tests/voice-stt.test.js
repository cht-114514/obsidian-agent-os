import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  downsampleBuffer,
  floatTo16BitPCM,
  encodeWav,
  resolveXaiApiKey,
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
