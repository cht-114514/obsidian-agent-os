/**
 * Grok Build ACP client — speaks Agent Client Protocol (JSON-RPC over stdio)
 * to a long-lived `grok agent stdio` child process.
 *
 * Desktop-only at runtime (needs Node child_process). Do NOT top-level import
 * node: builtins — that breaks Obsidian Mobile plugin load.
 */

/** @returns {typeof import('child_process').spawn} */
function getSpawn() {
  const req =
    (typeof require === 'function' && require) ||
    (typeof window !== 'undefined' && window.require) ||
    (typeof globalThis !== 'undefined' && globalThis.require) ||
    null;
  if (!req) {
    throw new Error('Grok ACP 需要桌面端 Node（手机无法 spawn grok）');
  }
  try {
    return req('child_process').spawn;
  } catch (e) {
    throw new Error(`无法加载 child_process：${e?.message || e}`);
  }
}

/**
 * @typedef {{
 *   onThought?: (text: string) => void,
 *   onText?: (text: string) => void,
 *   onToolCall?: (tc: any) => void,
 *   onToolUpdate?: (tc: any) => void,
 *   onPermission?: (req: any) => Promise<string>, // resolves optionId
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
   *   env?: Record<string, string>,
   *   onStatus?: (s: string) => void,
   *   autoApprove?: (toolCall: any, options: any[]) => string | null,
   * }} opts
   */
  constructor(opts) {
    this.binPath = expandHome(opts.binPath || '~/.grok/bin/grok');
    this.cwd = opts.cwd;
    this.model = opts.model || '';
    this.onStatus = opts.onStatus || (() => {});
    this.autoApprove = opts.autoApprove || (() => null);
    this.child = null;
    this.buf = '';
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
    const args = ['agent', 'stdio'];
    if (this.model) args.push('-m', this.model);
    this.onStatus('启动内核…');
    const env =
      typeof process !== 'undefined' && process.env
        ? { ...process.env }
        : {};
    this.child = spawn(this.binPath, args, {
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
      this.rejectAll(new Error(`grok 内核退出（code ${code}）`));
    });
    this.child.stdout.on('data', (d) => this.onData(d.toString()));
    this.child.stderr.on('data', () => {});

    const init = await this.request('initialize', DEFAULT_INIT, 30000);
    this.agentInfo = init?._meta || {};
    this.initialized = true;
    this.onStatus('内核就绪');
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
   * Send a prompt; streams via handlers; resolves with { stopReason }.
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
    } finally {
      this.handlers = null;
    }
  }

  cancel() {
    if (this.sessionId && this.alive) {
      this.notify('session/cancel', { sessionId: this.sessionId });
    }
  }

  // ---- JSON-RPC plumbing ----

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
        reject(new Error(`${method} 超时`));
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
    // response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'agent error'));
        else p.resolve(msg.result);
      }
      return;
    }
    // server → client request
    if (msg.id != null && msg.method) {
      this.handleServerRequest(msg);
      return;
    }
    // notification
    if (msg.method === 'session/update') {
      this.handleUpdate(msg.params?.update);
    }
  }

  async handleServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const toolCall = msg.params?.toolCall || {};
      const options = msg.params?.options || [];
      // policy auto-approve first
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
          // fall through to reject
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
    // unknown server request — empty result keeps protocol moving
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

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return (process.env.HOME || '') + p.slice(1);
  return p;
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
