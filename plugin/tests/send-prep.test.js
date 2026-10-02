import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { choosePack, isCompletePack, withDeadline } from '../src/ui/send-prep.js';

describe('send prep', () => {
  it('uses a fresh pack, then a complete cache, and stops when neither exists', () => {
    const fresh = { identity: 'me' };
    assert.equal(choosePack(fresh, null, null).source, 'fresh');
    const timed = choosePack(null, { soul: 'cached' }, Object.assign(new Error('x'), { code: 'PREP_TIMEOUT' }));
    assert.equal(timed.source, 'cache');
    assert.equal(choosePack(null, null, null).ok, false);
    assert.equal(isCompletePack({}), false);
  });

  it('does not resolve a read that returns after cancel', async () => {
    const token = { cancelled: false };
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const task = withDeadline(() => pending, 50, token);
    token.cancelled = true;
    release({ identity: 'late' });
    await assert.rejects(task, (error) => error.code === 'PREP_CANCELLED' || error.code === 'PREP_TIMEOUT');
  });
});
