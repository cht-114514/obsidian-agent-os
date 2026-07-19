/**
 * Grok Build ACP client — speaks Agent Client Protocol (JSON-RPC over stdio)
 * to a long-lived `grok agent … stdio` child process.
 *
 * Desktop-only at runtime (needs Node child_process). Do NOT top-level import
 * node: builtins — that breaks Obsidian Mobile plugin load.
 *
 * Third-party OpenAI-compatible models use an isolated GROK_HOME + config.toml
 * (see grok-runtime.js). Env-only base URL overrides cause 401 re-auth loops.
 */
import {
  applySpawnPlanEnv,
  buildGrokSpawnPlan,
  buildThirdPartyConfigToml,
  validateGrokRuntime,
} from './grok-runtime.js';

/** @returns {typeof import('child_process').spawn} */
function getSpawn() {
  const req = getNodeRequire();
  if (!req) {
    throw new Error('Grok ACP 需要桌面端 Node（手机无法 spawn grok）');
  }
  try {
    return req('child_process').spawn;
  } catch (e) {
    throw new Error(`无法加载 child_process：${e?.message || e}`);
  }
}

function getNodeRequire() {
  return (
    (typeof require === 'function' && require) ||
    (typeof window !== 'undefined' && window.require) ||
    (typeof globalThis !== 'undefined' && globalThis.require) ||
    null
  );
}

/**
 * @typedef {{
 *   onThought?: (text: string) => void,
 *   onText?: (text: string) => void,
 *   onToolCall?: (tc: any) => void,
 *   onToolUpdate?: (tc: any) => void,
 *   onPermission?: (req: any) => Promise<string>,
 *   onStatus?: (s: string) => void,
 * }} PromptHandlers
 */

const DEFAULT_INIT = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
};

export class GrokAcpClient {
  /**
   * @param {{
   *   binPath?: string,
   *   cwd: string,
   *   model?: string,
   *   baseUrl?: string,
   *   apiKey?: string,
   *   isThirdParty?: boolean,
   *   label?: string,
   *   profileId?: string,
   *   env?: Record<string, string>,
   *   onStatus?: (s: string) => void,
   *   autoApprove?: (toolCall: any, options: any[]) => string | null,
   * }} opts
   */
  constructor(opts) {
    this.binPath = expandHome(opts.binPath || '~/.grok/bin/grok');
    this.cwd = opts.cwd;
    this.model = opts.model || '';
    this.baseUrl = (opts.baseUrl || '').trim();
    this.apiKey = opts.apiKey || '';
    this.isThirdParty = opts.isThirdParty != null ? !!opts.isThirdParty : !!this.baseUrl;
    this.label = opts.label || this.model || 'Grok';
    this.profileId = opts.profileId || '';
    this.extraEnv = opts.env || null;
    this.onStatus = opts.onStatus || (() => {});
    this.autoApprove = opts.autoApprove || (() => null);
    this.child = null;
    this.buf = '';
    this.stderrBuf = '';
    this.nextId = 0;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    this.sessionId = null;
    /** @type {PromptHandlers|null} */
    this.handlers = null;
    this.initialized = false;
    this.agentInfo = null;
  }

  get alive() {
    return !!(this.child && this.child.exitCode == null && !this.child.killed);
  }

  async ensureStarted() {
    if (this.alive && this.initialized) return;
    await this.start();
  }

  async start() {
    this.stop();
    const spawn = getSpawn();

    const rt = {
      profileId: this.profileId,
      label: this.label,
      model: this.model,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      binPath: this.binPath,
      isThirdParty: this.isThirdParty,
    };
    const invalid = validateGrokRuntime(rt);
    if (invalid) throw new Error(invalid);

    let grokHomeDir = null;
    if (rt.isThirdParty) {
      grokHomeDir = prepareThirdPartyGrokHome(rt);
    }

    const plan = buildGrokSpawnPlan(rt, { grokHomeDir });
    this.onStatus(
      plan.isThirdParty
        ? `启动内核（第三方 ${shortHost(this.baseUrl)} · ${this.model}）…`
        : `启动内核（${this.model || 'default'}）…`
    );

    const baseEnv =
      typeof process !== 'undefined' && process.env
        ? { ...process.env }
        : {};
    if (this.extraEnv) Object.assign(baseEnv, this.extraEnv);
    if (plan.grokHome) plan.envPatch.GROK_HOME = plan.grokHome;
    const env = applySpawnPlanEnv(baseEnv, plan);

    this.stderrBuf = '';
    this.child = spawn(this.binPath, plan.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child.on('error', (e) => {
      this.rejectAll(new Error(`grok 启动失败：${e.message}`));
    });
    this.child.on('exit', (code) => {
      this.initialized = false;
      this.sessionId = null;
      const hint = this.stderrBuf.trim().slice(-400);
      this.rejectAll(
        new Error(`grok 内核退出（code ${code}）` + (hint ? `\n${hint}` : ''))
      );
    });
    this.child.stdout.on('data', (d) => this.onData(d.toString()));
    this.child.stderr.on('data', (d) => {
      const t = d.toString();
      this.stderrBuf = (this.stderrBuf + t).slice(-8000);
      if (/401|403|auth recovery|rejected|ECONNREFUSED|ENOTFOUND/i.test(t)) {
        const line = t
          .replace(/\x1b\[[0-9;]*m/g, '')
          .trim()
          .split('\n')
          .filter(Boolean)
          .pop();
        if (line) {
          const short = line.slice(0, 160);
          this.onStatus?.(`内核警告：${short}`);
          this.handlers?.onStatus?.(`内核警告：${short}`);
        }
      }
    });

    const init = await this.request('initialize', DEFAULT_INIT, 30000);
    this.agentInfo = init?._meta || {};
    this.initialized = true;
    this.onStatus(
      plan.isThirdParty
        ? `内核就绪 · ${this.model} @ ${shortHost(this.baseUrl)}`
        : '内核就绪'
    );
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.initialized = false;
    this.sessionId = null;
    this.buf = '';
    this.rejectAll(new Error('client stopped'));
  }

  rejectAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** New conversation (drops current session). */
  resetSession() {
    this.sessionId = null;
  }

  async ensureSession() {
    await this.ensureStarted();
    if (this.sessionId) return this.sessionId;
    const res = await this.request(
      'session/new',
      { cwd: this.cwd, mcpServers: [] },
      60000
    );
    this.sessionId = res.sessionId;
    return this.sessionId;
  }

  /**
   * @param {string} text
   * @param {PromptHandlers} handlers
   */
  async prompt(text, handlers) {
    const sessionId = await this.ensureSession();
    this.handlers = handlers || {};
    try {
      const res = await this.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        20 * 60 * 1000
      );
      return { stopReason: res?.stopReason || 'end_turn' };
    } catch (e) {
      const msg = e?.message || String(e);
      const hint = this.stderrBuf.trim().slice(-500);
      if (hint && !msg.includes(hint.slice(0, 40))) {
        throw new Error(`${msg}\n\n--- grok stderr ---\n${hint}`);
      }
      throw e;
    } finally {
      this.handlers = null;
    }
  }

  cancel() {
    if (this.sessionId && this.alive) {
      this.notify('session/cancel', { sessionId: this.sessionId });
    }
  }

  request(method, params, timeoutMs = 120000) {
    if (!this.alive && method !== 'initialize') {
      return Promise.reject(new Error('内核未运行'));
    }
    const id = ++this.nextId;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const hint = this.stderrBuf.trim().slice(-300);
        reject(
          new Error(
            `${method} 超时（${Math.round(timeoutMs / 1000)}s）` +
              (hint ? `\n${hint}` : '') +
              (this.baseUrl
                ? `\n请检查第三方 Base URL（需含 /v1）与 API Key，当前：${this.baseUrl}`
                : '')
          )
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method, params) {
    if (!this.alive) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  respond(id, result) {
    if (!this.alive) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id, message) {
    if (!this.alive) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n'
    );
  }

  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line || line[0] !== '{') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          const detail =
            msg.error.data?.message || msg.error.message || 'agent error';
          p.reject(new Error(detail));
        } else p.resolve(msg.result);
      }
      return;
    }
    if (msg.id != null && msg.method) {
      this.handleServerRequest(msg);
      return;
    }
    if (msg.method === 'session/update') {
      this.handleUpdate(msg.params?.update);
      return;
    }
    if (msg.method === '_x.ai/session/prompt_complete') {
      const reason = msg.params?.stopReason;
      const result = msg.params?.agentResult;
      if (reason === 'error' && result) {
        this.handlers?.onStatus?.(`失败：${String(result).slice(0, 200)}`);
        this.onStatus?.(`失败：${String(result).slice(0, 120)}`);
      }
      return;
    }
    if (msg.method === '_x.ai/session_notification') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'retry_state' && u.reason) {
        const t = `重试 ${u.attempt || '?'}/${u.max_retries || '?'}: ${u.reason}`;
        this.handlers?.onStatus?.(t);
        this.onStatus?.(t);
      }
    }
  }

  async handleServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const toolCall = msg.params?.toolCall || {};
      const options = msg.params?.options || [];
      const auto = this.autoApprove(toolCall, options);
      if (auto) {
        this.respond(msg.id, { outcome: { outcome: 'selected', optionId: auto } });
        return;
      }
      if (this.handlers?.onPermission) {
        try {
          const optionId = await this.handlers.onPermission({ toolCall, options });
          this.respond(msg.id, { outcome: { outcome: 'selected', optionId } });
          return;
        } catch {
          /* fall through */
        }
      }
      const rej =
        options.find((o) => /reject/i.test(o.kind || '') || /reject|deny/i.test(o.name || '')) ||
        options[options.length - 1];
      this.respond(msg.id, {
        outcome: rej
          ? { outcome: 'selected', optionId: rej.optionId }
          : { outcome: 'cancelled' },
      });
      return;
    }
    this.respond(msg.id, {});
  }

  handleUpdate(update) {
    if (!update || !this.handlers) return;
    const h = this.handlers;
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk':
        h.onThought?.(update.content?.text || '');
        break;
      case 'agent_message_chunk':
        h.onText?.(update.content?.text || '');
        break;
      case 'tool_call':
        h.onToolCall?.(update);
        break;
      case 'tool_call_update':
        h.onToolUpdate?.(update);
        break;
      default:
        break;
    }
  }
}

/**
 * Write isolated GROK_HOME with third-party model config.
 * @param {{ model: string, baseUrl: string, apiKey: string, label?: string }} rt
 * @returns {string}
 */
export function prepareThirdPartyGrokHome(rt) {
  const req = getNodeRequire();
  if (!req) throw new Error('无法写临时 GROK_HOME（需要 Node fs）');
  const fs = req('fs');
  const path = req('path');
  const os = req('os');
  let h = 0;
  const sigSrc = `${rt.baseUrl}|${rt.model}|${(rt.apiKey || '').slice(0, 12)}`;
  for (let i = 0; i < sigSrc.length; i++) h = (Math.imul(31, h) + sigSrc.charCodeAt(i)) | 0;
  const sig = (h >>> 0).toString(36);
  const dir = path.join(os.tmpdir(), 'obsidian-agent-os-grok', sig);
  fs.mkdirSync(dir, { recursive: true });
  const toml = buildThirdPartyConfigToml({
    model: rt.model,
    baseUrl: rt.baseUrl,
    apiKey: rt.apiKey,
    label: rt.label,
  });
  fs.writeFileSync(path.join(dir, 'config.toml'), toml, 'utf8');
  return dir;
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return (process.env.HOME || '') + p.slice(1);
  return p;
}

/** @param {string} url */
function shortHost(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return String(url || '').slice(0, 40);
  }
}

/**
 * Default auto-approve policy for vault-native tools:
 * - reads / searches / fetches: always allow
 * - edits confined to free-write paths (typically agent-inbox/): allow
 * - everything else: null (surface to UI)
 * @param {(rel: string) => boolean} isFreeWritePath
 * @param {string} [vaultBase]
 */
export function makeVaultAutoApprove(isFreeWritePath, vaultBase) {
  return (toolCall, options) => {
    const allow =
      options.find((o) => (o.kind || '') === 'allow_once') ||
      options.find((o) => /allow|approve|yes/i.test(o.name || ''));
    if (!allow) return null;

    const kind = (toolCall.kind || '').toLowerCase();
    if (['read', 'search', 'fetch', 'think'].includes(kind)) return allow.optionId;

    const locations = toolCall.locations || [];
    if (['edit', 'delete', 'move'].includes(kind) && locations.length) {
      const allSafe = locations.every((l) => {
        let p = l?.path || '';
        if (vaultBase && p.startsWith(vaultBase)) {
          p = p.slice(vaultBase.length).replace(/^\//, '');
        }
        return isFreeWritePath(p);
      });
      if (allSafe) return allow.optionId;
    }
    return null;
  };
}

/** @deprecated use makeVaultAutoApprove */
export const makeMeIncAutoApprove = makeVaultAutoApprove;
