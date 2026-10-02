#!/usr/bin/env node
/**
 * Operator CLI for the Agent OS Mac service.
 *
 *   node service/bin/agent-os.mjs pair          mint a one-time pairing code
 *   node service/bin/agent-os.mjs devices       list paired devices
 *   node service/bin/agent-os.mjs revoke <id>   revoke one device
 *   node service/bin/agent-os.mjs rotate <id>   re-issue a device credential
 *   node service/bin/agent-os.mjs status        queue + kernel status
 *   node service/bin/agent-os.mjs serve         run the service in the foreground
 */
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createStore } from '../src/store.js';
import { createDevices } from '../src/devices-store.js';
import { createGateway } from '../src/gateway.js';
import { createTurnEngine } from '../src/turns.js';
import { startService } from '../src/server.js';
import { createVault } from '../src/vault.js';

function openContext() {
  const config = loadConfig();
  const logger = createLogger({ level: 'warn', path: config.logPath });
  const store = createStore(config.dbPath);
  const devices = createDevices({ store, config, logger });
  const gateway = createGateway({ url: config.gatewayUrl, token: config.gatewayToken, logger });
  const engine = createTurnEngine({ store, gateway, logger, config });
  const vault = createVault({ root: config.vaultPath });
  return { config, logger, store, devices, gateway, engine, vault };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const [command, ...args] = process.argv.slice(2);

if (command === 'serve') {
  const service = await startService();
  const shutdown = () => service.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (command === 'pair') {
  const { store, devices, config } = openContext();
  const record = devices.mintPairingCode();
  print({
    code: record.code,
    expiresAt: new Date(record.expiresAt).toISOString(),
    ttlSeconds: Math.round((record.expiresAt - record.createdAt) / 1000),
    publicUrl: config.publicUrl,
    hint: `在手机插件里输入配对码：${record.code}（${Math.round((record.expiresAt - record.createdAt) / 60000)} 分钟内有效，仅可使用一次）`,
  });
  store.close();
} else if (command === 'devices') {
  const { store, devices } = openContext();
  print({ devices: devices.listDevices() });
  store.close();
} else if (command === 'revoke') {
  const { store, devices } = openContext();
  const result = devices.revokeDevice(args[0] || '');
  print(result || { error: 'not found' });
  store.close();
} else if (command === 'rotate') {
  const { store, devices } = openContext();
  const result = devices.rotateDevice(args[0] || '');
  print(result || { error: 'not found' });
  store.close();
} else if (command === 'status') {
  const { config, store, gateway, engine, vault } = openContext();
  const active = store.listActiveTurns();
  let kernel = { state: gateway.status().state, message: gateway.status().message };
  try {
    const health = await gateway.health();
    kernel = { state: 'live', ok: health?.ok !== false };
  } catch (error) {
    kernel = { state: gateway.status().state, error: error?.message };
  }
  print({
    publicUrl: config.publicUrl,
    dbPath: config.dbPath,
    gatewayUrl: config.gatewayUrl,
    kernel,
    queue: {
      running: active.filter((turn) => turn.status === 'running').length,
      queued: active.filter((turn) => turn.status === 'queued').length,
      needsVerification: active.filter((turn) => turn.status === 'needs_verification').length,
    },
    sessions: store.listSessions(10).map((row) => ({ key: row.key, updatedAt: row.updatedAt })),
    runningTasks: engine.runningCount(),
    vault: vault.status(),
  });
  await gateway.close();
  store.close();
} else {
  process.stdout.write(
    [
      'Agent OS Mac service',
      '',
      'Usage: node service/bin/agent-os.mjs <command>',
      '',
      '  serve            run the service in the foreground',
      '  pair             mint a one-time pairing code',
      '  devices          list paired devices',
      '  revoke <id>      revoke one device',
      '  rotate <id>      re-issue a device credential',
      '  status           queue, kernel, and session status',
      '',
    ].join('\n')
  );
  process.exit(command ? 1 : 0);
}
