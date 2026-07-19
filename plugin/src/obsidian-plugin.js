/**
 * Obsidian Agent OS Obsidian plugin — homepage chat shell + sidebar view.
 */
import {
  Plugin,
  ItemView,
  Notice,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  Platform,
} from 'obsidian';
import { MeSoulController } from './main.js';
import { mountMeSoulChat } from './chat-panel.js';
import { GrokAcpClient, makeVaultAutoApprove } from './acp-client.js';
import { checkWritePolicy } from './protocol-bridge.js';
import { MeSoulSetupModal, seedVaultScaffold, needsScaffold } from './setup.js';

export const VIEW_TYPE = 'me-soul-chat';

class MeSoulView extends ItemView {
  /** @param {import('obsidian').WorkspaceLeaf} leaf @param {MeSoulPlugin} plugin */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this._mount = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'Obsidian Agent OS';
  }

  getIcon() {
    return 'sparkles';
  }

  async onOpen() {
    this._mount = mountMeSoulChat(this.contentEl, {
      app: this.app,
      controller: this.plugin.controller,
      plugin: this.plugin,
      Notice,
      MarkdownRenderer,
      mode: 'sidebar',
    });
  }

  async onClose() {
    this._mount?.destroy?.();
    this._mount = null;
  }
}

/** Markdown code-block host for homepage embed */
class MeSoulHomeHost {
  /**
   * @param {HTMLElement} el
   * @param {MeSoulPlugin} plugin
   */
  constructor(el, plugin) {
    this.el = el;
    this.plugin = plugin;
    this._mount = null;
  }

  onload() {
    this.el.empty();
    this.el.addClass('me-soul-home-host');
    this._mount = mountMeSoulChat(this.el, {
      app: this.plugin.app,
      controller: this.plugin.controller,
      plugin: this.plugin,
      Notice,
      MarkdownRenderer,
      mode: 'home',
    });
  }

  onunload() {
    this._mount?.destroy?.();
    this._mount = null;
  }
}

export default class MeSoulPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.controller = new MeSoulController(this.settings);
    this.acp = null;

    document.body.classList.add('me-soul-plugin-loaded');
    this.register(() => document.body.classList.remove('me-soul-plugin-loaded'));

    // Homepage: ```me-soul``` code block
    this.registerMarkdownCodeBlockProcessor('me-soul', (source, el, ctx) => {
      const host = new MeSoulHomeHost(el, this);
      host.onload();
      // ensure full-height in reading view
      el.parentElement?.addClass('me-soul-block-parent');
    });

    this.registerView(VIEW_TYPE, (leaf) => new MeSoulView(leaf, this));

    this.addRibbonIcon('sparkles', 'Obsidian Agent OS', () => this.activateView());
    this.addCommand({
      id: 'obsidian-agent-os-open',
      name: 'Open Obsidian Agent OS chat',
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: 'obsidian-agent-os-open-home',
      name: 'Open home (Obsidian Agent OS)',
      callback: () => this.openHome(),
    });
    this.addCommand({
      id: 'obsidian-agent-os-toggle-quiet',
      name: 'Toggle Quiet (今日少说话)',
      callback: async () => {
        this.controller.setQuiet(!this.controller.settings.quiet);
        this.settings.quiet = this.controller.settings.quiet;
        await this.saveSettings();
        new Notice(this.settings.quiet ? 'Quiet ON' : 'Quiet OFF');
      },
    });
    this.addCommand({
      id: 'obsidian-agent-os-setup',
      name: 'Run setup wizard (人格 / 模板)',
      callback: () => this.openSetup(),
    });
    this.addCommand({
      id: 'obsidian-agent-os-seed-templates',
      name: 'Seed soul templates (不覆盖已有)',
      callback: async () => {
        await seedVaultScaffold(this.app, {
          agentName: this.settings.agentName || 'Agent',
          userName: this.settings.userName || 'User',
          agentVibe: this.settings.agentVibe || '',
          homePath: this.settings.homePath || '00-首页.md',
          createHome: true,
          overwrite: false,
        });
        new Notice('已写入通用 soul 模板（跳过已有文件）');
      },
    });

    this.addSettingTab(new MeSoulSettingTab(this.app, this));

    this.register(() => {
      this.acp?.stop?.();
      this.acp = null;
    });

    this.app.workspace.onLayoutReady(async () => {
      const missing = await needsScaffold(this.app);
      if (!this.settings.setupDone || missing) {
        this.openSetup();
      } else if (this.settings.openHomeOnStart) {
        this.openHome();
      }
    });
  }

  openSetup() {
    new MeSoulSetupModal(this.app, this, {
      onDone: () => {
        if (this.settings.openHomeOnStart) this.openHome();
      },
    }).open();
  }

  /** True when Grok ACP (local spawn) is available. */
  isDesktopKernelAvailable() {
    return !Platform.isMobileApp && !Platform.isMobile;
  }

  /**
   * Lazily create / reuse the Grok ACP client bound to this vault.
   * Mobile: throws a clear error (plugin still loads for UI + local skills).
   */
  getAcp() {
    if (!this.isDesktopKernelAvailable()) {
      throw new Error(
        '手机端无法启动本地 Grok 内核（需要桌面 Node）。可：1) 用电脑聊；2) 设置里改用 OpenClaw Gateway（HTTP）；3) 仅用本地技能写 vault。'
      );
    }
    if (this.acp) return this.acp;
    const base =
      this.app.vault.adapter?.basePath ||
      this.app.vault.adapter?.getBasePath?.() ||
      (typeof process !== 'undefined' && process.cwd ? process.cwd() : '');
    if (!base) {
      throw new Error('拿不到 vault 绝对路径，无法启动 Grok ACP');
    }
    this.acp = new GrokAcpClient({
      binPath: this.settings.grokBin,
      cwd: base,
      model: this.settings.grokModel,
      autoApprove: makeVaultAutoApprove(
        (rel) => checkWritePolicy(rel).allowed,
        base
      ),
    });
    return this.acp;
  }

  async openHome() {
    const homePath = this.settings.homePath || '00-首页.md';
    const file = this.app.vault.getAbstractFileByPath(homePath);
    if (!file) {
      new Notice(`找不到首页：${homePath}（可在设置里改路径，或运行 Setup wizard）`);
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign(
      {
        engine: 'grok',
        grokBin: '~/.grok/bin/grok',
        grokModel: '',
        gatewayUrl: 'http://127.0.0.1:18789',
        token: '',
        quiet: false,
        openHomeOnStart: true,
        setupDone: false,
        agentName: 'Agent',
        userName: '',
        agentVibe: '简洁、温暖、直接；像合伙人不是客服',
        homePath: '00-首页.md',
        retrieve: true,
        embedEnabled: true,
        embedBaseUrl: 'https://www.dmxapi.cn/v1',
        embedApiKey: '',
        embedModel: 'bge-m3',
        embedTopK: 3,
        embedMinScore: 0.28,
        retrieveMode: 'hybrid',
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
        skills: [
          'me-digest',
          'me-write-insight',
          'me-care-check',
          'me-apply-pending',
          'me-apply-insight',
          'me-soul-promote',
          'me-reindex',
        ],
      },
      (await this.loadData()) || {}
    );
    // Merge newly shipped skills into saved settings (data.json may be stale).
    const builtinSkills = [
      'me-digest',
      'me-write-insight',
      'me-care-check',
      'me-apply-pending',
      'me-apply-insight',
      'me-soul-promote',
      'me-reindex',
    ];
    const saved = Array.isArray(this.settings.skills) ? this.settings.skills : [];
    this.settings.skills = [...new Set([...saved, ...builtinSkills])];
    
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.controller) {
      this.controller.settings = { ...this.settings };
    }
  }
}

class MeSoulSettingTab extends PluginSettingTab {
  /** @param {import('obsidian').App} app @param {MeSoulPlugin} plugin */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Obsidian Agent OS' });
    containerEl.createEl('p', {
      text: '开源测试版 (beta)。人格与密钥只存在本 vault 的插件 data.json，不会随源码分发。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('初始配置向导')
      .setDesc('命名 Agent、写入通用 soul 模板')
      .addButton((b) =>
        b.setButtonText('打开 Setup').onClick(() => this.plugin.openSetup())
      );

    containerEl.createEl('h3', { text: '人格 / 显示' });

    new Setting(containerEl)
      .setName('Agent 显示名')
      .setDesc('聊天标题（如 Obsidian Agent OS / 你的自定义名）')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.agentName || 'Agent')
          .onChange(async (v) => {
            this.plugin.settings.agentName = v.trim() || 'Agent';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('用户称呼')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.userName || '')
          .onChange(async (v) => {
            this.plugin.settings.userName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('首页路径')
      .setDesc('嵌入 ```me-soul``` 代码块的笔记')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.homePath || '00-首页.md')
          .onChange(async (v) => {
            this.plugin.settings.homePath = v.trim() || '00-首页.md';
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: '内核' });

    new Setting(containerEl)
      .setName('内核 Engine')
      .setDesc('grok = Grok Build (ACP stdio，推荐)；openclaw = 旧 gateway')
      .addDropdown((d) =>
        d
          .addOption('grok', 'Grok Build')
          .addOption('openclaw', 'OpenClaw gateway')
          .setValue(this.plugin.settings.engine || 'grok')
          .onChange(async (v) => {
            this.plugin.settings.engine = v;
            this.plugin.acp?.stop?.();
            this.plugin.acp = null;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Grok 二进制路径')
      .setDesc('默认 ~/.grok/bin/grok')
      .addText((t) =>
        t
          .setPlaceholder('~/.grok/bin/grok')
          .setValue(this.plugin.settings.grokBin || '')
          .onChange(async (v) => {
            this.plugin.settings.grokBin = v.trim();
            this.plugin.acp?.stop?.();
            this.plugin.acp = null;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Grok 模型')
      .setDesc('留空用默认（当前 grok-4.5）')
      .addText((t) =>
        t
          .setPlaceholder('grok-4.5')
          .setValue(this.plugin.settings.grokModel || '')
          .onChange(async (v) => {
            this.plugin.settings.grokModel = v.trim();
            this.plugin.acp?.stop?.();
            this.plugin.acp = null;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Gateway URL')
      .setDesc('OpenClaw gateway base URL（仅 engine=openclaw 时使用）')
      .addText((t) =>
        t
          .setPlaceholder('http://127.0.0.1:18789')
          .setValue(this.plugin.settings.gatewayUrl)
          .onChange(async (v) => {
            this.plugin.settings.gatewayUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Token')
      .setDesc('Optional bearer token')
      .addText((t) =>
        t.setValue(this.plugin.settings.token || '').onChange(async (v) => {
          this.plugin.settings.token = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('启动打开首页')
      .setDesc('Layout ready 时打开 00-首页.md（Obsidian Agent OS 对话台）')
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.openHomeOnStart).onChange(async (v) => {
          this.plugin.settings.openHomeOnStart = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Quiet（今日少说话）')
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.quiet).onChange(async (v) => {
          this.plugin.settings.quiet = v;
          this.plugin.controller.setQuiet(v);
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '当前笔记上下文' });
    containerEl.createEl('p', {
      text: '自动把你正在看的 Markdown 附带进对话，无需每次 @。可在输入栏上方切换「跟随 / 固定 / 关闭」。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('自动附带当前笔记')
      .setDesc('关闭后完全不注入 active-note 上下文')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.activeNoteContext !== false).onChange(async (v) => {
          this.plugin.settings.activeNoteContext = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('默认模式')
      .setDesc('跟随焦点 / 固定 / 关闭')
      .addDropdown((d) =>
        d
          .addOption('follow', '跟随')
          .addOption('pin', '固定')
          .addOption('off', '关闭')
          .setValue(this.plugin.settings.activeNoteMode || 'follow')
          .onChange(async (v) => {
            this.plugin.settings.activeNoteMode = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('当前笔记最大字符')
      .setDesc('截断正文，默认 8000')
      .addText((t) =>
        t
          .setPlaceholder('8000')
          .setValue(String(this.plugin.settings.activeNoteMaxChars ?? 8000))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.activeNoteMaxChars =
              Number.isFinite(n) && n > 500 ? n : 8000;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Digest 默认用当前笔记')
      .setDesc('无 @ 时 /me-digest 使用当前/跟随笔记')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.activeNoteForDigest !== false).onChange(async (v) => {
          this.plugin.settings.activeNoteForDigest = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '语音输入（xAI STT）' });
    containerEl.createEl('p', {
      text: '按住输入栏旁 🎤 说话，松手填入文字。优先流式 WebSocket，失败则整段 REST。Key 可填 API Key，或自动读 XAI_API_KEY / OpenClaw / ~/.grok/auth。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('启用语音输入')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.voiceEnabled !== false).onChange(async (v) => {
          this.plugin.settings.voiceEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('xAI API Key')
      .setDesc('console.x.ai 的 Key；用于 STT。勿提交 git')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('xai-… 或留空自动探测')
          .setValue(this.plugin.settings.xaiApiKey || '')
          .onChange(async (v) => {
            this.plugin.settings.xaiApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('语音语言（可选）')
      .setDesc('如 en；留空自动。格式化用；中文听写请实测')
      .addText((t) =>
        t
          .setPlaceholder('en')
          .setValue(this.plugin.settings.voiceLanguage || '')
          .onChange(async (v) => {
            this.plugin.settings.voiceLanguage = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('松手后自动发送')
      .setDesc('关闭则只填入输入框，由你确认再发')
      .addToggle((t) =>
        t.setValue(!!this.plugin.settings.voiceAutoSend).onChange(async (v) => {
          this.plugin.settings.voiceAutoSend = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl('h3', { text: '记忆检索（Embedding）' });
    containerEl.createEl('p', {
      text: '默认 DMX + bge-m3。笔记片段会发往 Embed API 做向量化；密钥仅存本机 data.json。改模型后请运行 /me-reindex。',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('启用向量检索')
      .setDesc('关闭后仅用关键词 index.md')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.embedEnabled !== false).onChange(async (v) => {
          this.plugin.settings.embedEnabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('检索模式')
      .setDesc('hybrid = 向量 + 关键词（推荐）')
      .addDropdown((d) =>
        d
          .addOption('hybrid', 'hybrid')
          .addOption('vector', 'vector')
          .addOption('keyword', 'keyword')
          .setValue(this.plugin.settings.retrieveMode || 'hybrid')
          .onChange(async (v) => {
            this.plugin.settings.retrieveMode = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Embed Base URL')
      .setDesc('OpenAI 兼容，默认 https://www.dmxapi.cn/v1')
      .addText((t) =>
        t
          .setPlaceholder('https://www.dmxapi.cn/v1')
          .setValue(this.plugin.settings.embedBaseUrl || '')
          .onChange(async (v) => {
            this.plugin.settings.embedBaseUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Embed API Key')
      .setDesc('DMX 令牌；勿提交到 git')
      .addText((t) => {
        t.inputEl.type = 'password';
        t.setPlaceholder('sk-…')
          .setValue(this.plugin.settings.embedApiKey || '')
          .onChange(async (v) => {
            this.plugin.settings.embedApiKey = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Embed 模型')
      .setDesc('推荐 bge-m3（中文 · 1024 维）')
      .addText((t) =>
        t
          .setPlaceholder('bge-m3')
          .setValue(this.plugin.settings.embedModel || 'bge-m3')
          .onChange(async (v) => {
            this.plugin.settings.embedModel = v.trim() || 'bge-m3';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Top K')
      .setDesc('每轮注入的相关记忆条数')
      .addText((t) =>
        t
          .setPlaceholder('3')
          .setValue(String(this.plugin.settings.embedTopK ?? 3))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.embedTopK = Number.isFinite(n) && n > 0 ? n : 3;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('最小余弦相似度')
      .setDesc('低于阈值的向量命中丢弃，默认 0.28')
      .addText((t) =>
        t
          .setPlaceholder('0.28')
          .setValue(String(this.plugin.settings.embedMinScore ?? 0.28))
          .onChange(async (v) => {
            const n = parseFloat(v);
            this.plugin.settings.embedMinScore = Number.isFinite(n) ? n : 0.28;
            await this.plugin.saveSettings();
          })
      );
  }
}
