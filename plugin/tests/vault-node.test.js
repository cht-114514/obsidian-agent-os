import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPendingWrite, executeVaultCommand } from '../src/kernel/vault-tools.js';
import { VaultNode } from '../src/kernel/vault-node.js';
import { createDeviceIdentity } from '../src/kernel/device-identity.js';

function memoryVault(files = {}) {
  const notes = { ...files };
  return {
    notes,
    async read(path) {
      if (!(path in notes)) throw new Error(`missing ${path}`);
      return notes[path];
    },
    async write(path, content) {
      notes[path] = content;
    },
    async list(prefix = '') {
      return Object.keys(notes).filter((path) => !prefix || path.startsWith(prefix));
    },
    activeNote: () => ({ path: '手记/today.md', name: 'today' }),
  };
}

describe('vault tools', () => {
  it('writes agent-inbox immediately and parks human-zone writes', async () => {
    const vault = memoryVault();
    const free = await executeVaultCommand(
      'vault.write',
      { path: 'agent-inbox/wiki/a.md', content: '# a' },
      vault
    );
    assert.equal(free.mode, 'written');
    assert.equal(vault.notes['agent-inbox/wiki/a.md'], '# a');

    const held = await executeVaultCommand(
      'vault.write',
      { path: '手记/日记.md', content: 'hello' },
      vault,
      { now: Date.parse('2026-10-01T00:00:00Z') }
    );
    assert.equal(held.mode, 'pending');
    assert.equal(held.target, '手记/日记.md');
    assert.match(vault.notes[held.path], /status: pending/);
    assert.match(vault.notes[held.path], /hello/);
    assert.equal(vault.notes['手记/日记.md'], undefined);
  });

  it('blocks traversal and reads notes', async () => {
    const vault = memoryVault({ 'agent-inbox/wiki/a.md': 'body' });
    const bad = await executeVaultCommand('vault.read', { path: '../secrets.md' }, vault);
    assert.equal(bad.ok, false);
    const ok = await executeVaultCommand('vault.read', { path: 'agent-inbox/wiki/a.md' }, vault);
    assert.equal(ok.content, 'body');
    const pending = buildPendingWrite('项目库/x.md', 'draft', Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(pending.pendingPath, 'agent-inbox/pending/2026-10-01-write-x.md');
  });
});

describe('vault node invoke', () => {
  it('answers node.invoke.request with node.invoke.result', async () => {
    const vault = memoryVault({ 'agent-inbox/wiki/a.md': 'alpha' });
    const node = new VaultNode({
      url: 'ws://127.0.0.1:18789',
      token: 't',
      identity: createDeviceIdentity(),
      WebSocketImpl: class {
        constructor() {
          this.listeners = {};
          this.sent = [];
        }
        addEventListener(type, fn) {
          (this.listeners[type] ||= []).push(fn);
        }
        send(data) {
          this.sent.push(JSON.parse(data));
        }
        close() {}
      },
      vault,
    });
    node.client.socket = {
      opened: true,
      request: async (method, params) => {
        node.client.socket.last = { method, params };
        if (method === 'node.invoke.result') return { ok: true };
        return {};
      },
    };
    node.client.identity = node.client.identity || {};
    await node.handleInvoke({
      id: 'inv-1',
      nodeId: node.client.identity.deviceId,
      command: 'vault.read',
      paramsJSON: JSON.stringify({ path: 'agent-inbox/wiki/a.md' }),
    });
    assert.equal(node.client.socket.last.method, 'node.invoke.result');
    assert.equal(node.client.socket.last.params.ok, true);
    assert.equal(node.client.socket.last.params.payload.content, 'alpha');
  });
});
