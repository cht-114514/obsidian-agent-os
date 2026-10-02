import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServiceClient,
  isTerminalStatus,
  normalizeServiceUrl,
  planCredentialMigration,
} from '../src/kernel/service-client.js';

/** A scriptable fetch double. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    const reply = await handler(call, calls.length);
    const status = reply?.status ?? 200;
    const payload = reply?.body ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return typeof payload === 'string' ? payload : JSON.stringify(payload);
      },
    };
  };
  fn.calls = calls;
  return fn;
}

const turnPayload = (over = {}) => ({
  id: 'turn-1',
  clientTurnId: 'c-1',
  sessionKey: 'agent:main:main',
  status: 'queued',
  result: '',
  error: '',
  needsAttention: false,
  events: [],
  cursor: 0,
  terminal: false,
  ...over,
});

describe('service url normalization', () => {
  it('defaults to the fixed HTTPS entry point', () => {
    assert.equal(normalizeServiceUrl(''), 'https://agent.chenhaotong.one');
    assert.equal(normalizeServiceUrl('agent.chenhaotong.one'), 'https://agent.chenhaotong.one');
    assert.equal(normalizeServiceUrl('https://x.test/'), 'https://x.test');
    // The plan is HTTPS-only for the phone entry.
    assert.equal(normalizeServiceUrl('http://x.test'), 'https://x.test');
  });
});

describe('service client auth', () => {
  it('sends the device credential as a bearer token', async () => {
    const fetchImpl = fakeFetch(() => ({ body: { ok: true } }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'dev-secret', fetch: fetchImpl });
    await client.health();
    assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer dev-secret');
  });

  it('omits the credential when pairing', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 201, body: { credential: 'new' } }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'old', fetch: fetchImpl });
    const result = await client.pair('ABCD1234', { name: 'iPhone', platform: 'ios' });
    assert.equal(result.credential, 'new');
    assert.equal(fetchImpl.calls[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), {
      code: 'ABCD1234',
      name: 'iPhone',
      platform: 'ios',
    });
  });

  it('maps an HTTP error to a coded, classed error', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: '设备凭据无效或已被撤销' } },
    }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'stale', fetch: fetchImpl });
    await assert.rejects(
      () => client.health(),
      (error) => {
        assert.equal(error.code, 'UNAUTHORIZED');
        assert.equal(error.status, 401);
        assert.equal(error.retryable, false);
        return true;
      }
    );
  });

  it('marks server and rate-limit failures retryable', async () => {
    for (const [status, body, retryable] of [
      [503, { error: { code: 'KERNEL_UNAVAILABLE' } }, true],
      [429, { error: { code: 'RATE_LIMITED' } }, true],
      [400, { error: { code: 'BAD_REQUEST' } }, false],
    ]) {
      const fetchImpl = fakeFetch(() => ({ status, body }));
      const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
      await assert.rejects(
        () => client.health(),
        (error) => {
          assert.equal(error.retryable, retryable, `status ${status}`);
          return true;
        }
      );
    }
  });

  it('treats a network failure as retryable, not as a lost message', async () => {
    const client = createServiceClient({
      url: 'https://x.test',
      credential: 'c',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await assert.rejects(
      () => client.submitTurn({ clientTurnId: 'a', sessionKey: 's', message: 'm' }),
      (error) => {
        assert.equal(error.retryable, true);
        return true;
      }
    );
  });
});

describe('service client turn flow', () => {
  it('polls increments with after=cursor and returns the final result', async () => {
    const fetchImpl = fakeFetch((call, count) => {
      if (count === 1) {
        assert.equal(call.method, 'POST');
        const body = JSON.parse(call.body);
        assert.equal(body.clientTurnId, 'c-1');
        // Reuse the phone's own turn id, so a retry resumes the same turn.
        assert.equal(body.message, 'hello');
        return { status: 201, body: { turn: turnPayload({ status: 'running', cursor: 1, events: [{ seq: 1, kind: 'status', text: '已送达 Mac，开始执行' }] }) } };
      }
      if (count === 2) {
        assert.match(call.url, /after=1$/);
        return {
          status: 200,
          body: {
            turn: turnPayload({
              status: 'running',
              cursor: 2,
              events: [{ seq: 2, kind: 'progress', text: 'half' }],
            }),
          },
        };
      }
      assert.match(call.url, /after=2$/);
      return {
        status: 200,
        body: {
          turn: turnPayload({
            status: 'completed',
            result: 'the answer',
            terminal: true,
            cursor: 3,
            events: [{ seq: 3, kind: 'result', text: 'the answer' }],
          }),
        },
      };
    });
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    const seen = [];
    const result = await client.runTurn({
      clientTurnId: 'c-1',
      sessionKey: 'agent:main:main',
      message: 'hello',
      pollMs: 1,
      onProgress: (event) => seen.push(event.text || event.status),
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'the answer');
    assert.equal(result.turnId, 'turn-1');
    assert.ok(seen.includes('half'));
  });

  it('resumes polling without re-submitting after an app restart', async () => {
    const fetchImpl = fakeFetch((call) => {
      assert.equal(call.method, 'GET');
      return {
        status: 200,
        body: {
          turn: turnPayload({ status: 'completed', result: 'finished while away', terminal: true, cursor: 5 }),
        },
      };
    });
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    const result = await client.resumeTurn('turn-1', { after: 4, pollMs: 1 });
    assert.equal(result.text, 'finished while away');
    // Never POSTs: resuming must not create a second run.
    assert.ok(fetchImpl.calls.every((call) => call.method === 'GET'));
  });

  it('surfaces a needs_verification turn as a user decision', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        turn: turnPayload({
          status: 'needs_verification',
          error: '无法确认这条消息是否已经执行',
          terminal: false,
        }),
      },
    }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    await assert.rejects(
      () => client.resumeTurn('turn-1', { pollMs: 1 }),
      (error) => {
        assert.equal(error.code, 'NEEDS_VERIFICATION');
        return true;
      }
    );
  });
});

describe('service client backgrounding', () => {
  it('stops polling when the app goes to the background, keeping the turn', async () => {
    let polls = 0;
    const fetchImpl = fakeFetch((call) => {
      if (call.method === 'POST') {
        return { status: 201, body: { turn: turnPayload({ status: 'running' }) } };
      }
      polls += 1;
      return { status: 200, body: { turn: turnPayload({ status: 'running', cursor: polls }) } };
    });
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    await assert.rejects(
      () =>
        client.runTurn({
          clientTurnId: 'c-1',
          sessionKey: 's',
          message: 'm',
          pollMs: 1,
          shouldContinue: () => polls < 2,
        }),
      (error) => {
        assert.equal(error.code, 'BACKGROUNDED');
        assert.equal(error.turnId, 'turn-1');
        assert.ok(error.cursor >= 1);
        return true;
      }
    );
    // It really stopped polling rather than spinning.
    assert.ok(polls <= 3, `polled ${polls} times`);
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { turn: turnPayload({ status: 'running' }) } }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      () => client.resumeTurn('turn-1', { pollMs: 10, signal: controller.signal }),
      (error) => error.code === 'ABORTED'
    );
  });
});

describe('service client notes', () => {
  it('turns a 428 into a confirmation request the UI can render', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 428,
      body: {
        error: { code: 'CONFIRMATION_REQUIRED', message: '这个位置需要确认卡' },
        confirm: {
          token: 'tok-1',
          path: '手记/journal.md',
          humanZone: true,
          currentFingerprint: 'sha256:aaa',
          proposedFingerprint: 'sha256:bbb',
          currentBytes: 10,
          proposedBytes: 20,
        },
      },
    }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    await assert.rejects(
      () => client.writeNote({ path: '手记/journal.md', content: 'proposal' }),
      (error) => {
        assert.equal(error.code, 'CONFIRMATION_REQUIRED');
        assert.equal(error.details.confirm.token, 'tok-1');
        assert.equal(error.details.confirm.humanZone, true);
        return true;
      }
    );
  });

  it('passes the confirmation token through on approval', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: { write: { path: '手记/journal.md' } } }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    await client.writeNote({
      path: '手记/journal.md',
      content: 'proposal',
      confirmationToken: 'tok-1',
      expectFingerprint: 'sha256:aaa',
    });
    const body = JSON.parse(fetchImpl.calls[0].body);
    assert.equal(body.confirmationToken, 'tok-1');
    assert.equal(body.expectFingerprint, 'sha256:aaa');
  });

  it('url-encodes note paths and search terms', async () => {
    const fetchImpl = fakeFetch(() => ({ status: 200, body: {} }));
    const client = createServiceClient({ url: 'https://x.test', credential: 'c', fetch: fetchImpl });
    await client.readNote('基础学科/语文/a b.md');
    await client.searchNotes('挂念 & 心情');
    assert.match(fetchImpl.calls[0].url, /path=%E5%9F%BA%E7%A1%80%E5%AD%A6%E7%A7%91/);
    assert.match(fetchImpl.calls[1].url, /%26/);
  });
});

describe('credential migration', () => {
  it('flags shared credentials for clearing once a device is paired', () => {
    assert.deepEqual(planCredentialMigration({ gatewayToken: 'shared' }).legacyFields, ['gatewayToken']);
    assert.equal(planCredentialMigration({ gatewayToken: 'shared' }).shouldClear, true);
    assert.equal(planCredentialMigration({}).shouldClear, false);
  });
});

describe('terminal status helper', () => {
  it('knows which statuses end a turn', () => {
    assert.equal(isTerminalStatus('completed'), true);
    assert.equal(isTerminalStatus('failed'), true);
    assert.equal(isTerminalStatus('aborted'), true);
    assert.equal(isTerminalStatus('needs_verification'), false);
    assert.equal(isTerminalStatus('running'), false);
  });
});
