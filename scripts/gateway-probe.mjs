/**
 * Read-only probe of the live OpenClaw gateway.
 * Verifies the Node-side client (the same modules the Obsidian plugin uses) can
 * authenticate, list sessions/models, and read history. Sends nothing.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { KernelClient } from '../plugin/src/kernel/kernel-client.js';
import { createMemoryStore, createDeviceIdentity } from '../plugin/src/kernel/device-identity.js';

function token() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const cfg = JSON.parse(readFileSync(join(homedir(), '.openclaw', 'openclaw.json'), 'utf8'));
  return cfg?.gateway?.auth?.token || '';
}

async function main() {
  const shared = token();
  if (!shared) throw new Error('no gateway token found');
  const identity = createDeviceIdentity();
  const client = new KernelClient({
    url: process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789',
    token: shared,
    identity,
    role: 'operator',
    clientId: 'gateway-client',
    clientMode: 'backend',
    platform: 'macos',
    deviceFamily: 'mac',
    displayName: 'agent-os-service probe',
    WebSocketImpl: WebSocket,
  });
  client.onStatus((status) => {
    if (status.state !== 'connecting') console.log('[status]', status.state, status.message || '');
  });
  const hello = await client.connect();
  console.log('[hello] protocol=%s role=%s scopes=%s', hello?.protocol, hello?.auth?.role, JSON.stringify(hello?.auth?.scopes));
  const methods = Array.isArray(hello?.features?.methods) ? hello.features.methods : [];
  console.log('[methods]', methods.filter((m) => /^(chat|sessions|models|agents|health|node)\./.test(m)).join(', '));

  const health = await client.health().catch((error) => ({ error: error.message }));
  console.log('[health]', JSON.stringify(health).slice(0, 400));

  const sessions = await client.listSessions().catch((error) => ({ error: error.message }));
  if (Array.isArray(sessions)) {
    console.log('[sessions] count=%d', sessions.length);
    for (const row of sessions.slice(0, 5)) {
      console.log('  -', JSON.stringify({ key: row.key || row.sessionKey, agent: row.agentId, updatedAt: row.updatedAt }));
    }
  } else {
    console.log('[sessions] error', JSON.stringify(sessions));
  }

  const models = await client.listModels().catch((error) => ({ error: error.message }));
  console.log('[models] count=%s', Array.isArray(models) ? models.length : JSON.stringify(models).slice(0, 200));

  const key = process.env.PROBE_SESSION || 'agent:main:main';
  const history = await client.history(key, 5).catch((error) => ({ error: error.message, code: error.code }));
  if (history?.error) {
    console.log('[history] error', JSON.stringify(history));
  } else {
    const rows = history?.messages || history?.items || [];
    console.log('[history] key=%s count=%d', key, rows.length);
    const last = rows.at(-1);
    if (last) console.log('[history tail]', JSON.stringify(last).slice(0, 500));
  }
  client.disconnect();
}

main().catch((error) => {
  console.error('[fatal]', error?.message || error);
  process.exitCode = 1;
});
