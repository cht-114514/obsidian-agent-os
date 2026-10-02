import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceClient } from '../src/kernel/service-client.js';

function fetchReturning(handler) {
  return async (url, init = {}) => {
    const reply = await handler({ url: String(url), method: init.method || 'GET', headers: init.headers || {} });
    const status = reply?.status ?? 200;
    const payload = reply?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return JSON.stringify(payload);
      },
    };
  };
}

describe('service client diagnosis', () => {
  it('reports an unreachable entry point instead of a bare failure', async () => {
    const client = createServiceClient({
      url: 'https://agent.example.test',
      credential: 'stale',
      fetch: async () => {
        throw new TypeError('Load failed');
      },
    });
    const report = await client.diagnose();
    assert.equal(report.reachable, false);
    assert.equal(report.paired, true);
    assert.equal(report.error.step, 'entry');
    assert.equal(report.error.code, 'NETWORK');
    assert.match(report.error.message, /agent\.example\.test/);
    assert.match(report.error.hint, /网络|DNS|蜂窝/);
  });

  it('separates "not paired" from "service down"', async () => {
    const client = createServiceClient({
      url: 'https://agent.example.test',
      credential: '',
      fetch: fetchReturning(() => ({ status: 200, body: { service: { version: '0.4.0' }, kernel: { state: 'live' } } })),
    });
    const report = await client.diagnose();
    assert.equal(report.reachable, true);
    assert.equal(report.paired, false);
    assert.equal(report.error.step, 'pairing');
    assert.equal(report.error.code, 'NOT_PAIRED');
    assert.match(report.error.hint, /agent-os pair/);
  });

  it('flags a revoked credential as such', async () => {
    const client = createServiceClient({
      url: 'https://agent.example.test',
      credential: 'revoked',
      fetch: fetchReturning((call) =>
        call.headers.authorization
          ? { status: 401, body: { error: { code: 'UNAUTHORIZED', message: '设备凭据无效或已被撤销' } } }
          : { status: 200, body: { service: { version: '0.4.0' }, kernel: { state: 'live' } } }
      ),
    });
    const report = await client.diagnose();
    assert.equal(report.reachable, true);
    assert.equal(report.authenticated, false);
    assert.equal(report.error.step, 'auth');
    assert.equal(report.error.code, 'UNAUTHORIZED');
    assert.match(report.error.hint, /撤销|重新配对/);
  });

  it('reports a healthy path with the kernel state', async () => {
    const client = createServiceClient({
      url: 'https://agent.example.test',
      credential: 'good',
      fetch: fetchReturning(() => ({
        status: 200,
        body: {
          service: { version: '0.4.0' },
          kernel: { state: 'live' },
          diagnosis: { entry: 'ok', service: 'ok', kernel: 'ok' },
          queue: { active: 0, queued: 0 },
        },
      })),
    });
    const report = await client.diagnose();
    assert.equal(report.reachable, true);
    assert.equal(report.paired, true);
    assert.equal(report.authenticated, true);
    assert.equal(report.diagnosis.kernel, 'ok');
    assert.equal(report.error, null);
  });

  it('marks a timeout distinctly from a transport error', async () => {
    const client = createServiceClient({
      url: 'https://agent.example.test',
      credential: '',
      fetch: (url, init = {}) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    const report = await client.diagnose({ timeoutMs: 30 });
    assert.equal(report.error.code, 'TIMEOUT');
    assert.match(report.error.hint, /VPN|DNS|蜂窝/);
  });
});
