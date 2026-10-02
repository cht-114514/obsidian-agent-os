/**
 * Obsidian Agent OS — OpenClaw client: IDE command bar + full-screen chat.
 */
import {
  Plugin,
  ItemView,
  Notice,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  Platform,
  MarkdownView,
  loadMathJax,
  renderMath,
  finishRenderMath,
} from 'obsidian';
import { mountMeSoulChat } from './chat-panel.js';
import { createCommandBarController } from './command-bar.js';
import { createVoiceLiveController } from './voice-live.js';
import { KernelClient, resolveThinking, thinkingLevelsOf } from './kernel/kernel-client.js';
import { VaultNode } from './kernel/vault-node.js';
import {
  createLocalStorageStore,
  createMemoryStore,
  loadOrCreateIdentity,
  readSecret,
  writeSecret,
} from './kernel/device-identity.js';
import { executeVaultCommand } from './kernel/vault-tools.js';

export const VIEW_TYPE = 'me-soul-chat';

class MeSoulView extends ItemView {
  /** @param {import('obsidian').WorkspaceLeaf} leaf @param {MeSoulPlugin} plugin */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this._mount = null;
    this._sessionTitle = '';
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this._sessionTitle || 'Agent';
  }

  getIcon() {
    return 'sparkles';
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass('me-soul-view-content');
    // Full-screen main-tab chat (Claude / ChatGPT style) — not a right sidebar
    this._mount = mountMeSoulChat(this.contentEl, {
      app: this.app,
      plugin: this.plugin,
      Notice,
      MarkdownRenderer,
      loadMathJax,
      renderMath,
      finishRenderMath,
      view: this,
      onTitle: (title) => {
        this._sessionTitle = title || '';
        this.leaf?.updateHeader?.();
      },
      onClose: () => this.leaf?.detach?.(),
    });
  }

  async onClose() {
    this._mount?.destroy?.();
    this._mount = null;
  }

  async reloadSession() {
    await this._mount?.reloadSession?.();
  }

  async consumeQueuedLaunch() {
    await this._mount?.consumeQueuedLaunch?.();
  }
}

export default class MeSoulPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    await this.publishSharedGateway();
    this.operator = null;
    this.vaultNode = null;
    this.kernelModels = [];
    /** @type {{ skillId: string, text?: string, autoSend?: boolean } | null} */
    this._pendingChatLaunch = null;
    this.commandBar = createCommandBarController(this.app, this, {
      Notice,
      MarkdownRenderer,
      loadMathJax,
      renderMath,
      finishRenderMath,
    });
    this.voiceLive = createVoiceLiveController(this.app, this, {
      Notice,
      getCommandBar: () => this.commandBar,
    });

    document.body.classList.add('me-soul-plugin-loaded');
    this.register(() => document.body.classList.remove('me-soul-plugin-loaded'));
    this.register(() => {
      this.voiceLive?.destroy?.();
      this.voiceLive = null;
      this.commandBar?.destroy?.();
      this.commandBar = null;
    });

    this.registerView(VIEW_TYPE, (leaf) => new MeSoulView(leaf, this));

    this.addRibbonIcon('sparkles', 'Agent 全屏对话', () => this.activateView());

    // Primary: IDE command bar (inline, on the note)
    this.addCommand({
      id: 'obsidian-agent-os-command-bar',
      name: 'Open Agent command bar',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: ' ' }],
      callback: () => this.commandBar?.toggle(),
    });
    this.addCommand({
      id: 'obsidian-agent-os-command-bar-open',
      name: 'Open Agent command bar (force open)',
      callback: () => this.commandBar?.open({ forceOpen: true }),
    });

    // Live voice shell: border listen → hand off to command bar (text reply)
    this.addCommand({
      id: 'obsidian-agent-os-live-voice',
      name: 'Toggle Agent Live voice',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'V' }],
      callback: () => this.voiceLive?.toggle(),
    });

    // Full-screen chat tab (Claude / ChatGPT style)
    this.addCommand({
      id: 'obsidian-agent-os-open',
      name: 'Open Agent full-screen chat',
      callback: () => this.activateView(),
    });

    // Editor context menu: process selection via command bar
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        if (this.settings.commandBarEnabled === false) return;
        const sel = editor?.getSelection?.() || '';
        menu.addItem((item) => {
          item
            .setTitle(sel ? '用 Agent 处理选区…' : '打开 Agent 命令条…')
            .setIcon('sparkles')
            .onClick(() => {
              this.commandBar?.open({ forceOpen: true });
            });
        });
      })
    );

    // Optional floating chip near selection (Phase 1.5)
    this._setupSelectionChip();

    this.addSettingTab(new MeSoulSettingTab(this.app, this));

    this.register(() => {
      this.acp?.stop?.();
      this.acp = null;
    });
    this.bindGatewayWake();
  }

  /** Phone sleep and app switches drop the socket without a close event. Probe, then reconnect. */
  bindGatewayWake() {
    let last = 0;
    const wake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - last < 1500) return;
      last = now;
      this.operator?.revive?.().catch(() => {});
      this.vaultNode?.revive?.().catch(() => {});
    };
    this.registerDomEvent(document, 'visibilitychange', wake);
    this.registerDomEvent(window, 'focus', wake);
    this.registerDomEvent(window, 'online', wake);
    this.registerDomEvent(window, 'pageshow', wake);
  }

  /**
   * Lightweight "✦" chip near selection — opens command bar.
   * Disabled when settings.commandBarSelectionChip === false.
   */
  _setupSelectionChip() {
    /** @type {HTMLElement | null} */
    let chip = null;
    let hideTimer = null;

    const removeChip = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (chip) {
        chip.remove();
        chip = null;
      }
    };

    const placeChip = () => {
      if (this.settings.commandBarEnabled === false) {
        removeChip();
        return;
      }
      if (this.settings.commandBarSelectionChip === false) {
        removeChip();
        return;
      }
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view?.editor) {
        removeChip();
        return;
      }
      const sel = view.editor.getSelection();
      if (!sel || !sel.trim()) {
        removeChip();
        return;
      }
      // Avoid overlapping command bar
      if (this.commandBar?.isOpen?.()) {
        removeChip();
        return;
      }

      let top = 72;
      let left = 24;
      try {
        const sel = window.getSelection?.();
        if (sel && sel.rangeCount > 0) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect && (rect.width || rect.height)) {
            top = Math.max(8, rect.top - 36);
            left = Math.max(8, rect.left);
          }
        }
      } catch {
        /* keep defaults */
      }

      if (!chip) {
        chip = document.body.createDiv({ cls: 'me-soul-sel-chip' });
        chip.setAttr('title', '用 Agent 处理选区');
        chip.setText('✦');
        chip.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          removeChip();
          this.commandBar?.open({ forceOpen: true });
        };
      }

      chip.style.top = `${top}px`;
      chip.style.left = `${left}px`;
      chip.style.right = 'auto';
      chip.addClass('is-visible');
    };

    const schedulePlace = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(placeChip, 180);
    };

    this.registerDomEvent(document, 'selectionchange', schedulePlace);
    this.registerEvent(this.app.workspace.on('active-leaf-change', removeChip));
    this.register(() => removeChip());
  }

  isDesktopKernelAvailable() {
    return !Platform.isMobileApp && !Platform.isMobile;
  }

  secretStore() {
    const vaultId = this.app?.appId || this.app?.vault?.getName?.() || 'vault';
    if (typeof localStorage !== 'undefined') {
      return createLocalStorageStore(localStorage, `aos:${vaultId}:`);
    }
    this._memorySecrets ||= createMemoryStore();
    return this._memorySecrets;
  }

  hostGatewayToken() {
    if (Platform.isMobile || Platform.isMobileApp) return '';
    try {
      const req = typeof require === 'function' ? require : null;
      if (!req) return '';
      const fs = req('fs');
      const os = req('os');
      const path = req('path');
      const file = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      const token = cfg?.gateway?.auth?.token;
      return typeof token === 'string' ? token.trim() : '';
    } catch {
      return '';
    }
  }

  isLoopbackUrl(url) {
    try {
      const parsed = new URL(String(url || '').replace(/^ws/i, 'http'));
      return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    } catch {
      return false;
    }
  }

  connectionPrefs() {
    const store = this.secretStore();
    const mobile = Platform.isMobile || Platform.isMobileApp || document.body?.classList?.contains('is-mobile');
    let url = readSecret(store, 'gatewayUrl') || this.settings.gatewayUrl || 'ws://127.0.0.1:18789';
    if (mobile && this.isLoopbackUrl(url)) {
      url = this.settings.gatewayRemoteUrl || 'wss://mac-mini.tail3b2ec3.ts.net';
    }
    return {
      url,
      token: this.settings.gatewayToken || readSecret(store, 'gatewayToken') || this.hostGatewayToken(),
      vaultNode: readSecret(store, 'vaultNode') === '1',
      thinking: readSecret(store, 'thinking') || this.settings.thinking || '',
      model: readSecret(store, 'model') || '',
    };
  }

  async setConnectionPrefs(patch) {
    const store = this.secretStore();
    if (patch.url != null) writeSecret(store, 'gatewayUrl', patch.url);
    if (patch.token != null) {
      writeSecret(store, 'gatewayToken', patch.token);
      this.settings.gatewayToken = String(patch.token || '').trim();
      await this.saveSettings();
    }
    if (patch.vaultNode != null) writeSecret(store, 'vaultNode', patch.vaultNode ? '1' : '');
    if (patch.thinking != null) writeSecret(store, 'thinking', patch.thinking);
    if (patch.model != null) writeSecret(store, 'model', patch.model);
    this.invalidateKernel();
  }

  deviceProfile() {
    if (Platform.isMobile || Platform.isMobileApp) {
      return { platform: 'ios', deviceFamily: 'iphone' };
    }
    return { platform: 'macos', deviceFamily: 'mac' };
  }

  websocketImpl() {
    if (typeof WebSocket !== 'undefined') return WebSocket;
    return globalThis.WebSocket;
  }

  vaultAdapter() {
    const vault = this.app.vault;
    return {
      read: async (path) => {
        const file = vault.getAbstractFileByPath(path);
        if (!file) throw new Error(`找不到 ${path}`);
        return vault.read(file);
      },
      write: async (path, content) => {
        const existing = vault.getAbstractFileByPath(path);
        if (existing) {
          await vault.modify(existing, content);
          return;
        }
        const parts = path.split('/');
        parts.pop();
        if (parts.length) {
          const folder = parts.join('/');
          if (!vault.getAbstractFileByPath(folder)) {
            try {
              await vault.createFolder(folder);
            } catch {
              /* already exists */
            }
          }
        }
        await vault.create(path, content);
      },
      list: async (prefix = '') =>
        vault
          .getMarkdownFiles()
          .map((file) => file.path)
          .filter((path) => !prefix || path.startsWith(prefix)),
      search: async (query, limit) => {
        const q = String(query || '').toLowerCase();
        const hits = [];
        for (const file of vault.getMarkdownFiles()) {
          if (hits.length >= limit) break;
          if (file.path.toLowerCase().includes(q)) {
            hits.push({ path: file.path, title: file.basename, excerpt: '' });
            continue;
          }
          const text = await vault.cachedRead(file);
          const index = text.toLowerCase().indexOf(q);
          if (index >= 0) {
            hits.push({
              path: file.path,
              title: file.basename,
              excerpt: text.slice(Math.max(0, index - 40), index + 120),
            });
          }
        }
        return hits;
      },
      activeNote: () => {
        const file = this.app.workspace.getActiveFile();
        return file ? { path: file.path, name: file.basename } : null;
      },
    };
  }

  invalidateKernel() {
    try {
      this.operator?.disconnect();
    } catch {
      /* */
    }
    try {
      this.vaultNode?.disconnect();
    } catch {
      /* */
    }
    this.operator = null;
    this.vaultNode = null;
  }

  async ensureOperator(opts = {}) {
    if (opts.force) this.invalidateKernel();
    if (this.operator?.revive) {
      const live = await this.operator.revive();
      if (live && !this.kernelModels?.length) {
        const [models, agents] = await Promise.all([
          this.operator.listModels().catch(() => []),
          this.operator.listAgents().catch(() => []),
        ]);
        this.kernelModels = models;
        this.kernelAgents = agents;
      }
      return this.operator;
    }
    if (this.operator) return this.operator;
    const prefs = this.connectionPrefs();
    if (!prefs.token) {
      this.operator = {
        status: { state: 'offline', role: 'operator', message: '还没有填写 Gateway token' },
        onStatus() {
          return () => {};
        },
      };
      return this.operator;
    }
    const profile = this.deviceProfile();
    const identity = loadOrCreateIdentity(this.secretStore());
    const storedDeviceToken = readSecret(this.secretStore(), 'operatorDeviceToken');
    const client = new KernelClient({
      url: prefs.url,
      token: prefs.token,
      identity,
      role: 'operator',
      platform: profile.platform,
      deviceFamily: profile.deviceFamily,
      displayName: `Obsidian · ${this.settings.agentName || 'Agent'}`,
      deviceToken: storedDeviceToken,
      WebSocketImpl: this.websocketImpl(),
    });
    client.onStatus((status) => {
      if (status.deviceToken) writeSecret(this.secretStore(), 'operatorDeviceToken', status.deviceToken);
    });
    this.operator = client;
    await client.connect();
    if (client.deviceToken) writeSecret(this.secretStore(), 'operatorDeviceToken', client.deviceToken);
    if (client.status.state === 'live') {
      const [models, agents] = await Promise.all([
        client.listModels().catch(() => []),
        client.listAgents().catch(() => []),
      ]);
      this.kernelModels = models;
      this.kernelAgents = agents;
    }
    if (prefs.vaultNode) this.ensureVaultNode().catch(() => {});
    return client;
  }

  activeThinkingProfile() {
    const selected = this.connectionPrefs().model;
    const models = Array.isArray(this.kernelModels) ? this.kernelModels : [];
    if (selected) {
      const model = models.find(
        (item) => item.id === selected || `${item.provider}/${item.id}` === selected
      );
      if (model && thinkingLevelsOf(model).length) return model;
    }
    const agentId = this.settings.agentId || 'main';
    const agents = Array.isArray(this.kernelAgents) ? this.kernelAgents : [];
    const agent = agents.find((item) => item.id === agentId) || agents[0];
    if (agent && thinkingLevelsOf(agent).length) return agent;
    return null;
  }

  thinkingChoices() {
    return thinkingLevelsOf(this.activeThinkingProfile());
  }

  resolveOutgoingThinking() {
    return resolveThinking(this.connectionPrefs().thinking, this.activeThinkingProfile());
  }

  async ensureVaultNode() {
    const prefs = this.connectionPrefs();
    if (!prefs.vaultNode || !prefs.token) return null;
    if (this.vaultNode) return this.vaultNode;
    const profile = this.deviceProfile();
    const identity = loadOrCreateIdentity(this.secretStore());
    const node = new VaultNode({
      url: prefs.url,
      token: prefs.token,
      identity,
      platform: profile.platform,
      deviceFamily: profile.deviceFamily,
      deviceToken: readSecret(this.secretStore(), 'nodeDeviceToken'),
      displayName: 'Obsidian vault',
      WebSocketImpl: this.websocketImpl(),
      vault: this.vaultAdapter(),
    });
    node.onStatus((status) => {
      if (status.deviceToken) writeSecret(this.secretStore(), 'nodeDeviceToken', status.deviceToken);
    });
    this.vaultNode = node;
    await node.connect();
    return node;
  }

  async setKernelModel(model) {
    await this.setConnectionPrefs({ model });
  }

  runVaultCommand(command, params) {
    return executeVaultCommand(command, params, this.vaultAdapter());
  }

  /**
   * Queue a fullscreen-chat skill launch (from IDE command bar).
   * @param {{ skillId: string, text?: string, autoSend?: boolean }} launch
   */
  queueChatLaunch(launch) {
    if (!launch?.skillId) return;
    this._pendingChatLaunch = {
      skillId: String(launch.skillId),
      text: String(launch.text || ''),
      autoSend: launch.autoSend !== false,
    };
  }

  /**
   * Take and clear the pending launch once.
   * @returns {{ skillId: string, text: string, autoSend: boolean } | null}
   */
  takeChatLaunch() {
    const q = this._pendingChatLaunch;
    this._pendingChatLaunch = null;
    return q;
  }

  async openHome(opts = {}) {
    const homePath = this.settings.homePath || '00-首页.md';
    const file = this.app.vault.getAbstractFileByPath(homePath);
    if (!file) {
      if (opts.notice) {
        new Notice(`找不到首页：${homePath}`);
      }
      return false;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    return true;
  }

  /**
   * Open Agent chat as a full main-area tab (not the right sidebar).
   * Layout mirrors Claude / ChatGPT: center stage, full height.
   */
  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE);

    const isSideLeaf = (leaf) => {
      try {
        const root = leaf?.getRoot?.();
        return root === workspace.leftSplit || root === workspace.rightSplit;
      } catch {
        return false;
      }
    };

    // Prefer an existing leaf already in the main workspace
    let leaf = existing.find((l) => !isSideLeaf(l));
    const reusedExisting = !!leaf;

    if (!leaf) {
      // New tab in the main split (full workspace area)
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }

    // Drop legacy right-sidebar instances so we don't keep a narrow panel around
    for (const old of existing) {
      if (old !== leaf && isSideLeaf(old)) {
        try {
          old.detach();
        } catch {
          /* */
        }
      }
    }

    workspace.revealLeaf(leaf);
    // Reused leaf keeps stale in-memory chat; reload shared current.json.
    if (reusedExisting) {
      await leaf.view?.reloadSession?.();
    }
    // Command-bar may have queued a /skill — run it in fullscreen chat.
    await leaf.view?.consumeQueuedLaunch?.();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {
        gatewayUrl: 'ws://127.0.0.1:18789',
        gatewayRemoteUrl: 'wss://mac-mini.tail3b2ec3.ts.net',
        gatewayToken: '',
        agentId: 'main',
        thinking: '',
        quiet: false,
        /** Phone only. When on, the fullscreen chat hides Obsidian's bottom navbar. */
        hideMobileNavbar: false,
        /** IDE primary entry; sidebar/home are secondary. */
        commandBarEnabled: true,
        /** Optional soul pack inject into command-bar prompts (heavier). */
        commandBarInjectSoul: false,
        /** Floating ✦ chip when text is selected. */
        commandBarSelectionChip: true,
        /** Default off — notes first; open home only if user opts in. */
        openHomeOnStart: false,
        setupDone: false,
        agentName: 'Agent',
        userName: '',
        agentVibe: '简洁、温暖、直接；像合伙人不是客服',
        homePath: '00-首页.md',
        retrieve: true,
        embedEnabled: true, // required — wiki memory is vector-only
        embedBaseUrl: 'https://www.dmxapi.cn/v1',
        embedApiKey: '',
        embedModel: 'bge-m3',
        embedTopK: 3,
        embedMinScore: 0.28,
        retrieveMode: 'vector',
        // xAI voice STT
        voiceEnabled: true,
        voiceLanguage: '', // empty = auto; e.g. en, zh if supported
        voiceAutoSend: false,
        xaiApiKey: '',
        activeNoteContext: true,
        activeNoteMode: 'follow', // follow | pin | off
        activeNotePinnedPath: '',
        activeNoteMaxChars: 8000,
        activeNoteForDigest: true,
        digestBatchMax: 8,
        skills: [
          'me-digest',
          'me-write-insight',
          'me-reflect-feedback',
          'me-care-check',
          'me-apply-pending',
          'me-apply-insight',
          'me-soul-promote',
          'memorized',
          'me-reindex', // alias of memorized
        ],
      },
      (await this.loadData()) || {}
    );
    this.settings.skills = [];
    const dropped = [
      'engine',
      'grokBin',
      'grokModel',
      'grokApiBaseUrl',
      'grokApiKey',
      'grokProfiles',
      'grokActiveProfile',
      'token',
    ];
    let migrated = false;
    if (!this.settings.agentName || this.settings.agentName === '联合创始人') {
      this.settings.agentName = 'Agent';
      migrated = true;
    }
    if (this.settings.token) {
      writeSecret(this.secretStore(), 'gatewayToken', this.settings.token);
      migrated = true;
    }
    if (String(this.settings.gatewayUrl || '').startsWith('http')) {
      this.settings.gatewayUrl = this.settings.gatewayUrl
        .replace(/^http:\/\//, 'ws://')
        .replace(/^https:\/\//, 'wss://')
        .replace(/\/$/, '');
      migrated = true;
    }
    for (const key of dropped) {
      if (key in this.settings) {
        delete this.settings[key];
        migrated = true;
      }
    }
    if (migrated) await this.saveData(this.settings);
  }

  async publishSharedGateway() {
    const token = this.hostGatewayToken();
    let changed = false;
    if (token && this.settings.gatewayToken !== token) {
      this.settings.gatewayToken = token;
      changed = true;
    }
    if (!this.settings.gatewayRemoteUrl) {
      this.settings.gatewayRemoteUrl = 'wss://mac-mini.tail3b2ec3.ts.net';
      changed = true;
    }
    if (changed) await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class MeSoulSettingTab extends PluginSettingTab {
  /** @param {import('obsidian').App} app @param {MeSoulPlugin} plugin */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Visual section card with title + optional blurb.
   * @param {HTMLElement} parent
   * @param {{ title: string, desc?: string, badge?: string }} opts
   */
  section(parent, opts) {
    const card = parent.createDiv({ cls: 'me-soul-settings-section' });
    const head = card.createDiv({ cls: 'me-soul-settings-section-head' });
    const titleRow = head.createDiv({ cls: 'me-soul-settings-section-title-row' });
    titleRow.createEl('h3', {
      cls: 'me-soul-settings-section-title',
      text: opts.title,
    });
    if (opts.badge) {
      titleRow.createSpan({ cls: 'me-soul-settings-badge', text: opts.badge });
    }
    if (opts.desc) {
      head.createDiv({ cls: 'me-soul-settings-section-desc', text: opts.desc });
    }
    return card.createDiv({ cls: 'me-soul-settings-section-body' });
  }

  /**
   * Collapsible subsection (details/summary).
   * @param {HTMLElement} parent
   * @param {{ title: string, desc?: string, open?: boolean }} opts
   */
  fold(parent, opts) {
    const details = parent.createEl('details', {
      cls: 'me-soul-settings-fold',
    });
    if (opts.open) details.setAttr('open', '');
    const summary = details.createEl('summary', { cls: 'me-soul-settings-fold-summary' });
    summary.createSpan({ cls: 'me-soul-settings-fold-title', text: opts.title });
    if (opts.desc) {
      summary.createSpan({ cls: 'me-soul-settings-fold-desc', text: opts.desc });
    }
    return details.createDiv({ cls: 'me-soul-settings-fold-body' });
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();
    containerEl.addClass('me-soul-settings');

    // ---- Header ----
    const hero = containerEl.createDiv({ cls: 'me-soul-settings-hero' });
    hero.createEl('h2', { text: 'Obsidian Agent OS' });
    hero.createEl('p', {
      cls: 'me-soul-settings-hero-sub',
      text: 'OpenClaw 客户端。手机走 Tailscale，命令条只是附加入口。',
    });

    // ============================================================
    // 1. OpenClaw 连接
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: 'OpenClaw 内核',
        desc: '插件只做客户端。Gateway token 会跟着 vault 同步到手机；每台设备的身份密钥仍然只留在本机。',
        badge: '1',
      });
      const prefs = this.plugin.connectionPrefs();
      const status = this.plugin.operator?.status;

      new Setting(body)
        .setName('连接状态')
        .setDesc(status?.message || '打开全屏对话后会自动连接');

      new Setting(body)
        .setName('聊天时隐藏底栏')
        .setDesc('只在手机上生效。打开后，全屏对话不再为 Obsidian 底栏留空。')
        .addToggle((toggle) =>
          toggle.setValue(!!s.hideMobileNavbar).onChange(async (value) => {
            this.plugin.settings.hideMobileNavbar = value;
            document.body.classList.toggle('aos-hide-navbar', !!value);
            await this.plugin.saveSettings();
          })
        );

      if (status?.approveCommand) {
        new Setting(body)
          .setName('等待批准')
          .setDesc(status.approveCommand)
          .addButton((b) =>
            b.setButtonText('复制命令').onClick(async () => {
              try {
                await navigator.clipboard.writeText(status.approveCommand);
                new Notice('已复制');
              } catch {
                new Notice(status.approveCommand);
              }
            })
          );
      }

      new Setting(body)
        .setName('Gateway URL')
        .setDesc('本机用 ws://127.0.0.1:18789。其他设备用 tailnet 地址，例如 ws://100.x.x.x:18789 或 wss://主机名。')
        .addText((t) =>
          t
            .setPlaceholder('ws://127.0.0.1:18789')
            .setValue(prefs.url || '')
            .onChange(async (v) => {
              await this.plugin.setConnectionPrefs({ url: v.trim() });
            })
        );

      new Setting(body)
        .setName('Gateway token')
        .setDesc('和 vault 一起同步。手机连的是 Tailscale 地址，不会用这台 Mac 的 127.0.0.1。')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setValue(prefs.token || '').onChange(async (v) => {
            await this.plugin.setConnectionPrefs({ token: v.trim() });
          });
        });

      new Setting(body)
        .setName('作为 vault 节点')
        .setDesc('只在常开的那台 Obsidian 上打开。它向 OpenClaw 发布 vault 读写工具。手机默认只做界面。')
        .addToggle((t) =>
          t.setValue(!!prefs.vaultNode).onChange(async (v) => {
            await this.plugin.setConnectionPrefs({ vaultNode: v });
            if (v) await this.plugin.ensureVaultNode().catch((e) => new Notice(e?.message || String(e)));
          })
        );

      new Setting(body)
        .setName('Agent')
        .setDesc('OpenClaw agent id，默认 main')
        .addText((t) =>
          t.setValue(s.agentId || 'main').onChange(async (v) => {
            s.agentId = v.trim() || 'main';
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('重新连接')
        .addButton((b) =>
          b.setButtonText('连接').onClick(async () => {
            try {
              await this.plugin.ensureOperator({ force: true });
              const next = this.plugin.operator?.status;
              new Notice(next?.message || '已连接');
              this.display();
            } catch (e) {
              new Notice(e?.message || String(e));
            }
          })
        );
    }

    // ============================================================
    // 2. 命令条
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '命令条',
        desc: '笔记里的悬浮入口，不是主界面。',
        badge: '2',
      });

      new Setting(body)
        .setName('命令条')
        .setDesc('快捷键 Mod+Shift+Space，在笔记里改写或提问。')
        .addToggle((t) =>
          t.setValue(s.commandBarEnabled !== false).onChange(async (v) => {
            s.commandBarEnabled = v;
            await this.plugin.saveSettings();
          })
        )
        .addButton((b) =>
          b.setButtonText('打开命令条').onClick(() => {
            this.plugin.commandBar?.open({ forceOpen: true });
          })
        );

      new Setting(body)
        .setName('选区浮动按钮 ✦')
        .setDesc('选中文字后显示轻量按钮，点击打开命令条')
        .addToggle((t) =>
          t.setValue(s.commandBarSelectionChip !== false).onChange(async (v) => {
            s.commandBarSelectionChip = v;
            await this.plugin.saveSettings();
          })
        );

    }

    // ============================================================
    // 3. 语音输入
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '语音输入',
        desc: 'Cmd/Ctrl+Shift+V 进入 Live 边框听麦，说完自动送进命令条。Key 可填 xAI，或自动读环境变量。',
        badge: '3',
      });

      new Setting(body)
        .setName('启用语音')
        .setDesc('关闭后 Live 与 Chat 麦克风均不可用')
        .addToggle((t) =>
          t.setValue(s.voiceEnabled !== false).onChange(async (v) => {
            s.voiceEnabled = v;
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('Live 语音（边框听麦）')
        .setDesc('默认快捷键 Cmd/Ctrl+Shift+V，可在「快捷键」里改绑。说完后打开命令条并自动提交。')
        .addButton((btn) =>
          btn.setButtonText('试一下').onClick(() => {
            this.plugin.voiceLive?.toggle();
          })
        );

      new Setting(body)
        .setName('xAI API Key（STT）')
        .setDesc('与对话内核 Key 可分开；留空则自动探测')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setPlaceholder('xai-…')
            .setValue(s.xaiApiKey || '')
            .onChange(async (v) => {
              s.xaiApiKey = v.trim();
              await this.plugin.saveSettings();
            });
        });

      const voiceAdv = this.fold(body, {
        title: '高级 · 语言与发送',
        open: false,
      });

      new Setting(voiceAdv)
        .setName('语言提示')
        .setDesc('如 en；留空自动')
        .addText((t) =>
          t
            .setPlaceholder('en')
            .setValue(s.voiceLanguage || '')
            .onChange(async (v) => {
              s.voiceLanguage = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(voiceAdv)
        .setName('松手后自动发送')
        .setDesc('关闭则只填入输入框')
        .addToggle((t) =>
          t.setValue(!!s.voiceAutoSend).onChange(async (v) => {
            s.voiceAutoSend = v;
            await this.plugin.saveSettings();
          })
        );
    }
  }
}
