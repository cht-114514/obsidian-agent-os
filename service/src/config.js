/**
 * Configuration for the Agent OS Mac service.
 *
 * The service is the durable receiver: it owns the turn database, the device
 * credentials, and the connection to the OpenClaw execution kernel. Nothing
 * here reads or writes the vault — that is the vault module's job.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function env(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/** Gateway shared token. Kept in memory only; never written to the database. */
function gatewayToken() {
  const fromEnv = env('OPENCLAW_GATEWAY_TOKEN');
  if (fromEnv) return fromEnv;
  const cfg = readJson(join(homedir(), '.openclaw', 'openclaw.json'));
  const token = cfg?.gateway?.auth?.token;
  return typeof token === 'string' ? token.trim() : '';
}

/**
 * Machine-local settings shared by the service and the operator CLI.
 * Written once during install; environment variables still win.
 */
function localConfig() {
  const explicit = env('AOS_CONFIG_PATH');
  const candidates = [
    explicit,
    join(homedir(), '.config', 'agent-os', 'config.json'),
    join(homedir(), '.local', 'share', 'agent-os', 'config.json'),
  ].filter(Boolean);
  for (const path of candidates) {
    const parsed = readJson(path);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return {};
}

export function loadConfig(overrides = {}) {
  const local = localConfig();
  const stateDir = env('AOS_STATE_DIR', local.stateDir || join(homedir(), '.local', 'share', 'agent-os'));
  const dbPath = env('AOS_DB_PATH', local.dbPath || join(stateDir, 'agent-os.sqlite'));
  const logPath = env('AOS_LOG_PATH', local.logPath || join(stateDir, 'agent-os.log'));
  const adminTokenPath = env('AOS_ADMIN_TOKEN_PATH', local.adminTokenPath || join(stateDir, 'admin.token'));
  ensureDir(dirname(dbPath));
  ensureDir(dirname(logPath));

  return {
    host: env('AOS_HOST', local.host || '127.0.0.1'),
    port: Number(env('AOS_PORT', String(local.port || 8788))),
    /** Public HTTPS origin, for building links and for diagnostics only. */
    publicUrl: env('AOS_PUBLIC_URL', local.publicUrl || 'https://agent.chenhaotong.one'),
    /** Vault root — used by the资料 (vault) subsystem, never by turns. */
    vaultPath: env('AOS_VAULT_PATH', local.vaultPath || ''),
    gatewayUrl: env('OPENCLAW_URL', local.gatewayUrl || 'ws://127.0.0.1:18789'),
    gatewayToken: gatewayToken(),
    agentId: env('AOS_AGENT_ID', 'main'),
    defaultSessionKey: env('AOS_DEFAULT_SESSION', 'agent:main:main'),
    dbPath,
    logPath,
    adminTokenPath,
    stateDir,
    /** Pairing codes live this long, and work exactly once. */
    pairingCodeTtlMs: Number(env('AOS_PAIR_TTL_MS', String(5 * 60 * 1000))),
    /** Per-device request budget. */
    rateLimit: {
      windowMs: Number(env('AOS_RATE_WINDOW_MS', '60000')),
      max: Number(env('AOS_RATE_MAX', '240')),
      pairMax: Number(env('AOS_PAIR_RATE_MAX', '20')),
    },
    /** A single turn may run this long before it is treated as stuck. */
    turnTimeoutMs: Number(env('AOS_TURN_TIMEOUT_MS', String(15 * 60 * 1000))),
    idlePollMs: Number(env('AOS_TURN_POLL_MS', '2000')),
    logLevel: env('AOS_LOG_LEVEL', 'info'),
    logBody: env('AOS_LOG_BODY', '') === '1',
    ...overrides,
  };
}
