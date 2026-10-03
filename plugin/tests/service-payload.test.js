import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  serviceMessagesFromPayload,
  serviceSessionsFromPayload,
  unwrapServicePayload,
} from '../src/kernel/service-payload.js';

describe('service payload unwrap', () => {
  it('reads sessions from the json wrapper, not the outer shell', () => {
    const wrapped = {
      status: 200,
      json: { sessions: [{ key: 'agent:main:main', label: '主会话' }] },
    };
    assert.equal(serviceSessionsFromPayload(wrapped).length, 1);
    assert.equal(serviceSessionsFromPayload(wrapped)[0].key, 'agent:main:main');
    assert.equal(
      serviceSessionsFromPayload({ status: 200, json: {}, sessions: [{ key: 'x' }] }).length,
      0,
    );
  });

  it('reads history messages from the json wrapper', () => {
    const wrapped = {
      status: 200,
      json: { messages: [{ role: 'user', content: 'hi', ts: 1 }] },
    };
    assert.equal(serviceMessagesFromPayload(wrapped).length, 1);
    assert.equal(serviceMessagesFromPayload(wrapped)[0].content, 'hi');
    assert.deepEqual(unwrapServicePayload(wrapped), wrapped.json);
  });
});
