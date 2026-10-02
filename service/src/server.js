/**
 * Agent OS Mac service.
 *
 * Runs independently of the Obsidian window: the phone submits turns, this
 * process owns them, and OpenClaw executes them. A phone that sleeps, loses
 * Wi-Fi, or closes Obsidian changes nothing about a turn that was already
 * accepted here.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createStore } from './store.js';
import { createGateway } from './gateway.js';
import { createTurnEngine } from './turns.js';
import { createDevices } from './devices-store.js';
import { createRateLimiter } from './rate-limit.js';
import { createApi } from './api.js';
import { createVault } from './vault.js';
import { createConfirmations } from './confirmations.js';

export const SERVICE_VERSION = '0.4.0';

export async function startService(overrides = {}) {
  const config = { ...loadConfig(), serviceVersion: SERVICE_VERSION, ...overrides };
  const logger = createLogger({ level: config.logLevel, path: config.logPath, logBody: config.logBody });
  const store = createStore(config.dbPath);
  const gateway = createGateway({
    url: config.gatewayUrl,
    token: config.gatewayToken,
    logger,
    turnTimeoutMs: config.turnTimeoutMs,
  });
  const engine = createTurnEngine({ store, gateway, logger, config });
  const devices = createDevices({ store, config, logger });
  const rateLimit = createRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.max });
  const vault = createVault({ root: config.vaultPath });
  const confirmations = createConfirmations({});
  const api = createApi({ store, engine, gateway, devices, logger, config, rateLimit, vault, confirmations });

  const server = createServer((req, res) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    res.setHeader('access-control-allow-origin', origin || '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    res.setHeader('access-control-max-age', '600');
    res.setHeader('vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: 'GET,POST,OPTIONS' });
      res.end();
      return;
    }
    api.handler(req, res);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });

  logger.info('service listening', {
    url: `http://${config.host}:${config.port}`,
    publicUrl: config.publicUrl,
    db: config.dbPath,
    gateway: config.gatewayUrl,
    hasGatewayToken: !!config.gatewayToken,
  });

  // Reconcile before accepting new work, but never block the listener: the
  // phone must be able to submit (and see "queued") while we reconcile.
  const reconcileTask = (async () => {
    try {
      const result = await engine.reconcile();
      logger.info('reconcile done', result);
      engine.schedulePump();
    } catch (error) {
      logger.error('reconcile failed', { err: error?.message });
    }
  })();

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    logger.info('service stopping');
    engine.stop();
    await Promise.race([reconcileTask, new Promise((resolve) => setTimeout(resolve, 3000))]);
    await new Promise((resolve) => server.close(resolve));
    await gateway.close().catch(() => {});
    store.close();
  }

  return {
    config,
    store,
    engine,
    gateway,
    devices,
    rateLimit,
    vault,
    confirmations,
    api,
    server,
    logger,
    url: `http://${config.host}:${config.port}`,
    stop,
    reconcileTask,
  };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Surface startup failures instead of exiting silently.
  const service = await startService().catch((error) => {
    process.stderr.write(`agent-os: failed to start: ${error?.stack || error}\n`);
    process.exit(1);
  });
  const shutdown = () => {
    service
      .stop()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
