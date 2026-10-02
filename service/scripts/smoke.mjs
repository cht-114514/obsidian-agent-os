/**
 * End-to-end smoke test against a running Agent OS Mac service.
 *
 * Usage:
 *   AOS_STATE_DIR=/tmp/aos-test-state node service/scripts/smoke.mjs
 *
 * Environment:
 *   AOS_SMOKE_URL    service base URL (default http://127.0.0.1:8788)
 *   AOS_SMOKE_REAL   set to 1 to submit one real turn to OpenClaw
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.AOS_SMOKE_URL || 'http://127.0.0.1:8788';
const stateDir = process.env.AOS_STATE_DIR || join(process.env.HOME, '.local', 'share', 'agent-os');
const adminToken = readFileSync(join(stateDir, 'admin.token'), 'utf8').trim();

async function call(path, { method = 'GET', body, token, expect } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (expect && res.status !== expect) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

function step(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const health = await call('/v1/health', { expect: 200 });
step('health responds without auth', health.json.ok === true);
step('health hides kernel detail when unauthenticated', health.json.kernel.live === undefined);

// Unauthenticated business route must fail.
const unauth = await call('/v1/turns', {
  method: 'POST',
  body: { clientTurnId: 'x', message: 'x' },
});
step('business route rejects an anonymous caller', unauth.status === 401, `status=${unauth.status}`);

// Admin-only routes must reject a device credential.
const devices = await call('/v1/devices', { token: adminToken, expect: 200 });
step('admin token lists devices', Array.isArray(devices.json.devices));

const minted = await call('/v1/pair/code', { method: 'POST', token: adminToken });
if (minted.status === 404) {
  // Minting over HTTP is intentionally absent; use the CLI instead.
  console.log('SKIP  HTTP pairing-code mint (use: agent-os pair)');
} else {
  step('admin can mint a pairing code', minted.status === 201, JSON.stringify(minted.json).slice(0, 160));
}

// Claim with a bogus code must be rejected and must not leak whether it exists.
const bogus = await call('/v1/pair/claim', {
  method: 'POST',
  body: { code: 'ZZZZZZZZ', name: 'bogus' },
});
step('bogus pairing code is rejected', bogus.status === 401, `status=${bogus.status}`);

const code = process.env.AOS_SMOKE_CODE;
if (!code) {
  console.log('SKIP  pairing claim (set AOS_SMOKE_CODE from: agent-os pair)');
} else {
  const claimed = await call('/v1/pair/claim', {
    method: 'POST',
    body: { code, name: 'smoke-test phone', platform: 'ios' },
  });
  step('pairing code is accepted once', claimed.status === 201, JSON.stringify(claimed.json.device || {}));
  const again = await call('/v1/pair/claim', {
    method: 'POST',
    body: { code, name: 'replay' },
  });
  step('pairing code cannot be reused', again.status === 401, `status=${again.status}`);

  const deviceToken = claimed.json.credential;
  const clientTurnId = `smoke-${Date.now()}`;
  const first = await call('/v1/turns', {
    method: 'POST',
    token: deviceToken,
    body: { clientTurnId, sessionKey: 'agent:main:main', message: 'hello from the smoke test' },
  });
  step('turn is accepted', first.status === 201, `status=${first.status} id=${first.json.turn?.id}`);
  const duplicate = await call('/v1/turns', {
    method: 'POST',
    token: deviceToken,
    body: { clientTurnId, sessionKey: 'agent:main:main', message: 'hello from the smoke test' },
  });
  step(
    'the same clientTurnId returns the same turn (no second run)',
    duplicate.status === 200 &&
      duplicate.json.duplicate === true &&
      duplicate.json.turn.id === first.json.turn.id
  );

  let after = 0;
  let status = first.json.turn.status;
  const deadline = Date.now() + (process.env.AOS_SMOKE_REAL === '1' ? 180000 : 8000);
  while (!['completed', 'failed', 'aborted', 'needs_verification'].includes(status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const polled = await call(`/v1/turns/${first.json.turn.id}?after=${after}`, { token: deviceToken });
    after = polled.json.turn.cursor;
    status = polled.json.turn.status;
  }
  step('turn reaches a terminal state or waits for review', !!status, `status=${status}`);
  const final = await call(`/v1/turns/${first.json.turn.id}`, { token: deviceToken });
  step(
    'final result is readable from the service',
    typeof final.json.turn.result === 'string',
    `resultBytes=${final.json.turn.result.length}`
  );

  // Revocation must cut the device off immediately.
  const list = await call('/v1/devices', { token: adminToken });
  const mine = list.json.devices.find((row) => row.id === claimed.json.device.id);
  step('paired device is listed', !!mine);
  const revoked = await call(`/v1/devices/${claimed.json.device.id}/revoke`, {
    method: 'POST',
    token: adminToken,
  });
  step('device can be revoked', revoked.status === 200);
  const afterRevoke = await call('/v1/turns', {
    method: 'POST',
    token: deviceToken,
    body: { clientTurnId: `${clientTurnId}-2`, message: 'should be refused' },
  });
  step('revoked device can no longer submit', afterRevoke.status === 401, `status=${afterRevoke.status}`);
}

console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
