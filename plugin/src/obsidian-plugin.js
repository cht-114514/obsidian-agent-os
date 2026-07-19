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
import {
  DEFAULT_GROK_PROFILES,
  formatGrokRuntimeLabel,
  grokRuntimeSignature,
  normalizeGrokProfiles,
  resolveGrokRuntime,
} from './grok-runtime.js';

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

  /** Active Grok Build model + endpoint (for UI + ACP). */
  getGrokRuntime() {
    return resolveGrokRuntime(this.settings);
  }

  /**
   * Switch profile from chat header/settings. Restarts ACP on next prompt.
   * @param {string} profileId
   */
  async switchGrokProfile(profileId) {
    const profiles = normalizeGrokProfiles(this.settings.grokProfiles);
    const p = profiles.find((x) => x.id === profileId);
    if (!p) throw new Error(`未知模型配置档：${profileId}`);
    this.settings.grokActiveProfile = p.id;
    this.settings.grokModel = p.model || this.settings.grokModel;
    this.settings.grokProfiles = profiles;
    await this.saveSettings();
    this.invalidateAcp();
    return this.getGrokRuntime();
  }

  /** Drop running Grok ACP so next getAcp() rebuilds with current settings. */
  invalidateAcp() {
    try {
      this.acp?.stop?.();
    } catch {
      /* */
    }
    this.acp = null;
    this._acpSig = null;
  }

  /**
   * Lazily create / reuse the Grok ACP client bound to this vault.
   * Mobile: throws a clear error (plugin still loads for UI; skills need Grok Build ACP).
   * Rebuilds when model / base URL / API key / bin path change.
   */
  getAcp() {
    if (!this.isDesktopKernelAvailable()) {
      throw new Error(
        '手机端无法启动本地 Grok 内核（需要桌面 Node）。可：1) 用电脑聊；2) 设置里改用 OpenClaw Gateway（HTTP）；3) 仅用本地技能写 vault。'
      );
    }
    const rt = this.getGrokRuntime();
    const sig = grokRuntimeSignature(rt);
    if (this.acp && this._acpSig && this._acpSig !== sig) {
      this.invalidateAcp();
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
      binPath: rt.binPath,
      cwd: base,
      model: rt.model,
      baseUrl: rt.baseUrl,
      apiKey: rt.apiKey,
      isThirdParty: rt.isThirdParty,
      label: rt.label,
      profileId: rt.profileId,
      autoApprove: makeVaultAutoApprove(
        (rel) => checkWritePolicy(rel).allowed,
        base
      ),
    });
    this._acpSig = sig;
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
        grokModel: 'grok-build',
        /** Optional default third-party OpenAI-compatible base (profile can override). */
        grokApiBaseUrl: '',
        /** Optional API key for third-party / override SuperGrok session auth for this plugin only. */
        grokApiKey: '',
        /** Named profiles for sidebar quick-switch. */
        grokProfiles: DEFAULT_GROK_PROFILES.map((p) => ({ ...p })),
        grokActiveProfile: 'supergrok',
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
    // Merge newly shipped skills into saved settings (data.json may be stale).
    const builtinSkills = [
      'me-digest',
      'me-write-insight',
      'me-care-check',
      'me-apply-pending',
      'me-apply-insight',
      'me-soul-promote',
      'memorized',
      'me-reindex',
    ];
    const saved = Array.isArray(this.settings.skills) ? this.settings.skills : [];
    this.settings.skills = [...new Set([...saved, ...builtinSkills])];
    this.settings.grokProfiles = normalizeGrokProfiles(this.settings.grokProfiles);
    if (!this.settings.grokActiveProfile) {
      this.settings.grokActiveProfile = 'supergrok';
    }
  }

  async saveSettings() {
    this.settings.grokProfiles = normalizeGrokProfiles(this.settings.grokProfiles);
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
      text: 'beta · 人格与密钥只存在本 vault 的插件 data.json，不会随源码分发。',
    });

    // ============================================================
    // 1. 快速开始
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '快速开始',
        desc: '首次使用先跑向导；日常开关放这里。',
        badge: '1',
      });

      new Setting(body)
        .setName('初始配置向导')
        .setDesc('命名 Agent、写入通用 soul 模板')
        .addButton((b) =>
          b.setButtonText('打开 Setup').setCta().onClick(() => this.plugin.openSetup())
        );

      new Setting(body)
        .setName('启动时打开首页')
        .setDesc(`Layout ready 时打开「${s.homePath || '00-首页.md'}」`)
        .addToggle((t) =>
          t.setValue(!!s.openHomeOnStart).onChange(async (v) => {
            s.openHomeOnStart = v;
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('今日少说话（Quiet）')
        .setDesc('收起思绪块，回复更克制')
        .addToggle((t) =>
          t.setValue(!!s.quiet).onChange(async (v) => {
            s.quiet = v;
            this.plugin.controller.setQuiet(v);
            await this.plugin.saveSettings();
          })
        );
    }

    // ============================================================
    // 2. 人格与界面
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '人格与界面',
        desc: '聊天里显示的名字、首页入口。',
        badge: '2',
      });

      new Setting(body)
        .setName('Agent 显示名')
        .setDesc('顶栏标题')
        .addText((t) =>
          t.setValue(s.agentName || 'Agent').onChange(async (v) => {
            s.agentName = v.trim() || 'Agent';
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('用户称呼')
        .setDesc('写入 soul 模板时用')
        .addText((t) =>
          t.setValue(s.userName || '').onChange(async (v) => {
            s.userName = v.trim();
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('首页路径')
        .setDesc('嵌入 ```me-soul``` 代码块的笔记')
        .addText((t) =>
          t.setValue(s.homePath || '00-首页.md').onChange(async (v) => {
            s.homePath = v.trim() || '00-首页.md';
            await this.plugin.saveSettings();
          })
        );
    }

    // ============================================================
    // 3. 对话内核
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '对话内核',
        desc: '选引擎；Grok Build 可接官方 SuperGrok 或 OpenAI 兼容第三方以省额度。',
        badge: '3',
      });

      new Setting(body)
        .setName('引擎')
        .setDesc('推荐 Grok Build（本地 ACP）。OpenClaw 为旧 HTTP gateway。')
        .addDropdown((d) =>
          d
            .addOption('grok', 'Grok Build')
            .addOption('openclaw', 'OpenClaw gateway')
            .setValue(s.engine || 'grok')
            .onChange(async (v) => {
              s.engine = v;
              this.plugin.invalidateAcp();
              await this.plugin.saveSettings();
              this.display(); // re-render engine-specific blocks
            })
        );

      if ((s.engine || 'grok') === 'grok') {
        new Setting(body)
          .setName('Grok 二进制')
          .setDesc('桌面端路径，默认 ~/.grok/bin/grok')
          .addText((t) =>
            t
              .setPlaceholder('~/.grok/bin/grok')
              .setValue(s.grokBin || '')
              .onChange(async (v) => {
                s.grokBin = v.trim();
                this.plugin.invalidateAcp();
                await this.plugin.saveSettings();
              })
          );

        const profiles = normalizeGrokProfiles(s.grokProfiles);
        s.grokProfiles = profiles;

        new Setting(body)
          .setName('当前模型配置档')
          .setDesc(formatGrokRuntimeLabel(this.plugin.getGrokRuntime()))
          .addDropdown((d) => {
            for (const p of profiles) {
              d.addOption(p.id, p.label || p.model || p.id);
            }
            d.setValue(s.grokActiveProfile || profiles[0]?.id || 'supergrok');
            d.onChange(async (v) => {
              try {
                await this.plugin.switchGrokProfile(v);
                this.display();
              } catch (e) {
                new Notice(String(e?.message || e));
              }
            });
          });

        new Setting(body)
          .setName('全局 API Base URL')
          .setDesc(
            'OpenAI 兼容根地址，须含 /v1（如 https://www.dmxapi.cn/v1）。只写域名会失败。SuperGrok 官方档不继承此项。'
          )
          .addText((t) =>
            t
              .setPlaceholder('https://www.dmxapi.cn/v1')
              .setValue(s.grokApiBaseUrl || '')
              .onChange(async (v) => {
                s.grokApiBaseUrl = v.trim();
                this.plugin.invalidateAcp();
                await this.plugin.saveSettings();
              })
          );

        new Setting(body)
          .setName('全局 API Key')
          .setDesc('仅注入本插件启动的 grok 进程；不改 ~/.grok 登录态')
          .addText((t) => {
            t.inputEl.type = 'password';
            t.setPlaceholder('sk-… / xai-…')
              .setValue(s.grokApiKey || '')
              .onChange(async (v) => {
                s.grokApiKey = v.trim();
                this.plugin.invalidateAcp();
                await this.plugin.saveSettings();
              });
          });

        // Profiles: collapsed list, open by default if only 1–2
        const fold = this.fold(body, {
          title: `模型配置档（${profiles.length}）`,
          desc: '聊天顶栏可随时切换 · 展开编辑',
          open: profiles.length <= 2,
        });

        for (const p of profiles) {
          const isActive = (s.grokActiveProfile || 'supergrok') === p.id;
          const box = fold.createDiv({
            cls: `me-soul-profile-box${isActive ? ' is-active' : ''}`,
          });
          const boxHead = box.createDiv({ cls: 'me-soul-profile-head' });
          boxHead.createEl('h4', { text: p.label || p.id });
          if (isActive) {
            boxHead.createSpan({ cls: 'me-soul-settings-badge is-on', text: '使用中' });
          }
          if (p.id === 'supergrok') {
            boxHead.createSpan({
              cls: 'me-soul-settings-badge is-muted',
              text: '官方',
            });
          }

          new Setting(box)
            .setName('显示名')
            .addText((t) =>
              t.setValue(p.label || '').onChange(async (v) => {
                p.label = v.trim() || p.id;
                s.grokProfiles = normalizeGrokProfiles(profiles);
                await this.plugin.saveSettings();
              })
            );

          new Setting(box)
            .setName('模型 ID')
            .setDesc('传给 grok -m；第三方需与网关 /v1/models 一致')
            .addText((t) =>
              t
                .setPlaceholder('grok-build / gpt-4o-mini …')
                .setValue(p.model || '')
                .onChange(async (v) => {
                  p.model = v.trim() || 'grok-build';
                  if (s.grokActiveProfile === p.id) {
                    s.grokModel = p.model;
                    this.plugin.invalidateAcp();
                  }
                  s.grokProfiles = normalizeGrokProfiles(profiles);
                  await this.plugin.saveSettings();
                })
            );

          new Setting(box)
            .setName('Base URL 覆盖')
            .setDesc(
              p.id === 'supergrok'
                ? '官方档请留空（用 grok login）'
                : '留空则用上方全局 Base URL'
            )
            .addText((t) =>
              t
                .setPlaceholder('https://…/v1')
                .setValue(p.baseUrl || '')
                .onChange(async (v) => {
                  p.baseUrl = v.trim();
                  if (s.grokActiveProfile === p.id) this.plugin.invalidateAcp();
                  s.grokProfiles = normalizeGrokProfiles(profiles);
                  await this.plugin.saveSettings();
                })
            );

          new Setting(box)
            .setName('API Key 覆盖')
            .setDesc(
              p.id === 'supergrok' ? '留空用官方登录 / 环境变量' : '留空则用全局 Key'
            )
            .addText((t) => {
              t.inputEl.type = 'password';
              t.setPlaceholder('可选')
                .setValue(p.apiKey || '')
                .onChange(async (v) => {
                  p.apiKey = v.trim();
                  if (s.grokActiveProfile === p.id) this.plugin.invalidateAcp();
                  s.grokProfiles = normalizeGrokProfiles(profiles);
                  await this.plugin.saveSettings();
                });
            });

          if (p.id !== 'supergrok') {
            new Setting(box).addButton((b) =>
              b.setButtonText('删除此档').setWarning().onClick(async () => {
                const next = profiles.filter((x) => x.id !== p.id);
                s.grokProfiles = normalizeGrokProfiles(next);
                if (s.grokActiveProfile === p.id) {
                  s.grokActiveProfile = 'supergrok';
                  this.plugin.invalidateAcp();
                }
                await this.plugin.saveSettings();
                this.display();
              })
            );
          }
        }

        new Setting(fold)
          .setName('添加配置档')
          .setDesc('第三方便宜模型，侧栏一键切换')
          .addButton((b) =>
            b.setButtonText('＋ 添加').onClick(async () => {
              const id = `p_${Date.now().toString(36)}`;
              const next = [
                ...normalizeGrokProfiles(s.grokProfiles),
                {
                  id,
                  label: '第三方模型',
                  model: 'gpt-4o-mini',
                  baseUrl: s.grokApiBaseUrl || '',
                  apiKey: '',
                },
              ];
              s.grokProfiles = normalizeGrokProfiles(next);
              await this.plugin.saveSettings();
              this.display();
            })
          );
      } else {
        // OpenClaw engine
        new Setting(body)
          .setName('Gateway URL')
          .setDesc('OpenClaw HTTP 入口')
          .addText((t) =>
            t
              .setPlaceholder('http://127.0.0.1:18789')
              .setValue(s.gatewayUrl || '')
              .onChange(async (v) => {
                s.gatewayUrl = v.trim();
                await this.plugin.saveSettings();
              })
          );

        new Setting(body)
          .setName('Bearer Token')
          .setDesc('可选')
          .addText((t) => {
            t.inputEl.type = 'password';
            t.setValue(s.token || '').onChange(async (v) => {
              s.token = v;
              await this.plugin.saveSettings();
            });
          });
      }
    }

    // ============================================================
    // 4. 上下文与 Digest
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '上下文与 Digest',
        desc: '自动附带当前笔记；批量消化时的默认行为。',
        badge: '4',
      });

      new Setting(body)
        .setName('自动附带当前笔记')
        .setDesc('关闭后完全不注入 active-note')
        .addToggle((t) =>
          t.setValue(s.activeNoteContext !== false).onChange(async (v) => {
            s.activeNoteContext = v;
            await this.plugin.saveSettings();
          })
        );

      new Setting(body)
        .setName('默认模式')
        .setDesc('也可在聊天输入栏上方切换')
        .addDropdown((d) =>
          d
            .addOption('follow', '跟随')
            .addOption('pin', '固定')
            .addOption('off', '关闭')
            .setValue(s.activeNoteMode || 'follow')
            .onChange(async (v) => {
              s.activeNoteMode = v;
              await this.plugin.saveSettings();
            })
        );

      const advanced = this.fold(body, {
        title: '高级 · 截断与批量',
        desc: '字符上限、digest 行为',
        open: false,
      });

      new Setting(advanced)
        .setName('当前笔记最大字符')
        .setDesc('默认 8000')
        .addText((t) =>
          t
            .setPlaceholder('8000')
            .setValue(String(s.activeNoteMaxChars ?? 8000))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              s.activeNoteMaxChars = Number.isFinite(n) && n > 500 ? n : 8000;
              await this.plugin.saveSettings();
            })
        );

      new Setting(advanced)
        .setName('Digest 默认用当前笔记')
        .setDesc('无 @ 时 /me-digest 使用当前/跟随笔记')
        .addToggle((t) =>
          t.setValue(s.activeNoteForDigest !== false).onChange(async (v) => {
            s.activeNoteForDigest = v;
            await this.plugin.saveSettings();
          })
        );

      new Setting(advanced)
        .setName('Digest 批量上限')
        .setDesc('「所有日记」等每轮最多几篇（1–50，默认 8）')
        .addText((t) =>
          t
            .setPlaceholder('8')
            .setValue(String(s.digestBatchMax ?? 8))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              s.digestBatchMax = Number.isFinite(n) && n > 0 && n <= 50 ? n : 8;
              await this.plugin.saveSettings();
            })
        );
    }

    // ============================================================
    // 5. 向量记忆
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '向量记忆',
        desc: 'Wiki 检索只走 embedding（vectors.jsonl）。改模型后请 /memorized。',
        badge: '5',
      });

      new Setting(body)
        .setName('Embed Base URL')
        .setDesc('OpenAI 兼容，默认 DMX')
        .addText((t) =>
          t
            .setPlaceholder('https://www.dmxapi.cn/v1')
            .setValue(s.embedBaseUrl || '')
            .onChange(async (v) => {
              s.embedBaseUrl = v.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(body)
        .setName('Embed API Key')
        .setDesc('无 Key 则无法检索 wiki；勿提交 git')
        .addText((t) => {
          t.inputEl.type = 'password';
          t.setPlaceholder('sk-…')
            .setValue(s.embedApiKey || '')
            .onChange(async (v) => {
              s.embedApiKey = v.trim();
              s.embedEnabled = true;
              s.retrieveMode = 'vector';
              await this.plugin.saveSettings();
            });
        });

      new Setting(body)
        .setName('Embed 模型')
        .setDesc('推荐 bge-m3（中文 · 1024 维）')
        .addText((t) =>
          t
            .setPlaceholder('bge-m3')
            .setValue(s.embedModel || 'bge-m3')
            .onChange(async (v) => {
              s.embedModel = v.trim() || 'bge-m3';
              await this.plugin.saveSettings();
            })
        );

      const embedAdv = this.fold(body, {
        title: '高级 · 检索阈值',
        open: false,
      });

      new Setting(embedAdv)
        .setName('Top K')
        .setDesc('每轮注入相关记忆条数')
        .addText((t) =>
          t
            .setPlaceholder('3')
            .setValue(String(s.embedTopK ?? 3))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              s.embedTopK = Number.isFinite(n) && n > 0 ? n : 3;
              await this.plugin.saveSettings();
            })
        );

      new Setting(embedAdv)
        .setName('最小余弦相似度')
        .setDesc('默认 0.28')
        .addText((t) =>
          t
            .setPlaceholder('0.28')
            .setValue(String(s.embedMinScore ?? 0.28))
            .onChange(async (v) => {
              const n = parseFloat(v);
              s.embedMinScore = Number.isFinite(n) ? n : 0.28;
              await this.plugin.saveSettings();
            })
        );
    }

    // ============================================================
    // 6. 语音输入
    // ============================================================
    {
      const body = this.section(containerEl, {
        title: '语音输入',
        desc: '按住 🎤 说话；Key 可填 xAI，或自动读环境 / OpenClaw / ~/.grok/auth。',
        badge: '6',
      });

      new Setting(body)
        .setName('启用语音')
        .addToggle((t) =>
          t.setValue(s.voiceEnabled !== false).onChange(async (v) => {
            s.voiceEnabled = v;
            await this.plugin.saveSettings();
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
