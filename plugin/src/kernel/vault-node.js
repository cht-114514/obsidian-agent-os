/**
 * Second gateway connection with role=node. Publishes vault_* tools and
 * answers node.invoke.request by running them inside Obsidian.
 */
import { KernelClient } from './kernel-client.js';
import { VAULT_COMMANDS, VAULT_TOOL_DEFS, executeVaultCommand } from './vault-tools.js';

export class VaultNode {
  /**
   * @param {{
   *   url: string,
   *   token: string,
   *   identity: any,
   *   deviceToken?: string,
   *   platform?: string,
   *   deviceFamily?: string,
   *   WebSocketImpl: any,
   *   vault: any,
   *   displayName?: string,
   * }} opts
   */
  constructor(opts) {
    this.vault = opts.vault;
    this.client = new KernelClient({
      url: opts.url,
      token: opts.token,
      identity: opts.identity,
      role: 'node',
      clientId: 'node-host',
      clientMode: 'node',
      platform: opts.platform,
      deviceFamily: opts.deviceFamily,
      displayName: opts.displayName || 'Obsidian vault',
      commands: VAULT_COMMANDS,
      deviceToken: opts.deviceToken || '',
      scopes: [],
      caps: [],
      WebSocketImpl: opts.WebSocketImpl,
    });
    this.unlisten = null;
    this.published = false;
    this.client.onStatus((status) => {
      if (status.state !== 'live') {
        this.published = false;
        return;
      }
      if (!this.published) this.publishTools().catch(() => {});
    });
  }

  get status() {
    return this.client.status;
  }

  onStatus(listener) {
    return this.client.onStatus(listener);
  }

  /** Re-announce vault tools on every fresh connection, not only the first. */
  async publishTools() {
    this.published = true;
    try {
      await this.client.request('node.pluginTools.update', { tools: VAULT_TOOL_DEFS });
    } catch (error) {
      this.published = false;
      this.client.setStatus({
        state: 'live',
        message: `已连接，但工具发布失败：${error?.message || error}`,
      });
    }
  }

  revive() {
    return this.client.revive();
  }

  async connect() {
    this.unlisten?.();
    this.unlisten = this.client.onEvent((frame) => {
      if (frame?.event !== 'node.invoke.request') return;
      this.handleInvoke(frame.payload || {}).catch(() => {});
    });
    return this.client.connect();
  }

  async handleInvoke(payload) {
    const id = String(payload.id || '').trim();
    const nodeId = String(payload.nodeId || this.client.identity.deviceId || '').trim();
    const command = String(payload.command || '').trim();
    if (!id || !nodeId || !command) return;
    let params = {};
    if (typeof payload.paramsJSON === 'string' && payload.paramsJSON) {
      try {
        params = JSON.parse(payload.paramsJSON);
      } catch {
        params = {};
      }
    } else if (payload.params && typeof payload.params === 'object') {
      params = payload.params;
    }
    let result;
    try {
      result = await executeVaultCommand(command, params, this.vault);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    const ok = result?.ok !== false && !result?.error;
    try {
      await this.client.request('node.invoke.result', {
        id,
        nodeId,
        ok,
        payload: ok ? result : undefined,
        error: ok ? undefined : { message: result?.error || 'vault command failed' },
      });
    } catch {
      /* late or disconnected */
    }
  }

  disconnect() {
    this.unlisten?.();
    this.unlisten = null;
    this.client.disconnect();
  }
}
