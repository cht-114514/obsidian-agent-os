/**
 * First-run vault scaffold + setup modal.
 * Seeds generic templates only — never ships a personal persona.
 */

import { Modal, Setting, Notice } from 'obsidian';

/** Bundled minimal templates (kept in-plugin so npm install works without reading ../templates). */
export const DEFAULT_TEMPLATES = {
  'agent-inbox/soul/IDENTITY.md': `---
title: Agent identity
type: soul-identity
managed_by: me-soul
---

# IDENTITY

- **Name:** {{AGENT_NAME}}
- **Role:** Vault co-pilot / learning & production partner
- **User:** {{USER_NAME}}
- **Creature:** vault-native agent (Markdown body + LLM nerve)
- **Vibe:** {{AGENT_VIBE}}
- **Emoji:** ◈

## Relationship

- Partner with the user on attention, projects, learning, and output.
- Match the user's language; keep paths and tool names in English when useful.
`,
  'agent-inbox/soul/SOUL.md': `---
title: Agent soul / voice
type: soul-voice
managed_by: me-soul
---

# SOUL

You are **{{AGENT_NAME}}**, a co-founder-style partner in this vault — not a passive summarizer.

## Hard boundaries

- Human-owned zones require **confirm before write** (defaults: 手记 / 项目库 / 资料库 / 基础学科).
- AI compilation defaults to \`agent-inbox/\` only.
- No empty praise openers; no report-speak; no dumping chain-of-thought as thoughts.

## Default behavior

- Shared material → life/project link → skill goal → output → one 15-minute next step.
- Discussing a note → their observation → short diagnosis → 2–3 questions → one small action.
- Prefer Socratic questioning over performing expertise.

## Growth

Stable preferences land via **insight / soul-promote** into profile and this file (**with confirm**).
`,
  'agent-inbox/soul/profile.md': `---
title: User profile model
type: soul-profile
managed_by: me-soul
---

# PROFILE

Stable model of **{{USER_NAME}}**. Update only via confirmed insights / soul-promote.

## Identity

- (Fill during setup or via insights.)

## Work preferences

- 

## Learning

- 

## Boundaries

- 
`,
  'agent-inbox/soul/style.md': `---
title: Communication style
type: soul-style
managed_by: me-soul
---

# STYLE

- Concise, warm, direct; have a stance.
- Thoughts (\`:::thought\`) are short marginalia (1–3 lines), not CoT dumps.
- Quiet mode: fewer thoughts and less proactive care.
`,
  'agent-inbox/soul/cares.md': `---
title: Care rules
type: soul-cares
managed_by: me-soul
intensity: cola-strong
daily_cap: 3
---

# Cares

## Hard guards

- At most **3** proactive messages per day
- Quiet hours: default 23:30–07:00
- "别烦 / quiet" → stop proactive for the day
- Every care item needs **concrete vault evidence**

## Blacklist

| When | Scope | Reason |
|------|-------|--------|
|  |  |  |
`,
  'agent-inbox/soul/README.md': `# agent-inbox/soul

Me.Soul local soul store. Edit freely. Open-source beta ships **templates only**.
`,
  'agent-inbox/wiki/index.md': `---
title: Wiki index
type: wiki-index
managed_by: me-soul
---

# Wiki Index

Keyword list. Run \`/me-reindex\` after digests. Optional vectors: \`vectors.jsonl\`.
`,
  'agent-inbox/pending/README.md': `# pending

Confirm queue for digests, insights, and human-zone writes.
`,
  'AGENTS.md': `# Vault constitution (minimal)

- Human zones: confirm before write.
- \`agent-inbox/\`: agent free-write for digests, wiki, soul drafts.
- Prefer evidence + next actions over fluff.
`,
};

/**
 * @param {string} tpl
 * @param {Record<string, string>} vars
 */
export function fillTemplate(tpl, vars) {
  let s = String(tpl || '');
  for (const [k, v] of Object.entries(vars || {})) {
    s = s.split(`{{${k}}}`).join(v ?? '');
  }
  return s;
}

/**
 * @param {any} app
 * @param {string} rel
 * @param {string} content
 * @param {{ overwrite?: boolean }} [opts]
 */
export async function writeVaultFile(app, rel, content, opts = {}) {
  const existing = app.vault.getAbstractFileByPath(rel);
  if (existing && !opts.overwrite) return { wrote: false, path: rel };
  if (existing) {
    await app.vault.modify(existing, content);
    return { wrote: true, path: rel, modified: true };
  }
  const parts = rel.split('/');
  let dir = '';
  for (let i = 0; i < parts.length - 1; i++) {
    dir = dir ? `${dir}/${parts[i]}` : parts[i];
    if (!app.vault.getAbstractFileByPath(dir)) {
      await app.vault.createFolder(dir);
    }
  }
  await app.vault.create(rel, content);
  return { wrote: true, path: rel, created: true };
}

/**
 * Seed generic soul + agent-inbox structure.
 * @param {any} app
 * @param {{
 *   agentName?: string,
 *   userName?: string,
 *   agentVibe?: string,
 *   homePath?: string,
 *   overwrite?: boolean,
 *   createHome?: boolean,
 * }} opts
 */
export async function seedVaultScaffold(app, opts = {}) {
  const vars = {
    AGENT_NAME: opts.agentName || 'Me.Soul',
    USER_NAME: opts.userName || 'User',
    AGENT_VIBE: opts.agentVibe || 'concise, warm, direct; partner not servant',
  };
  const results = [];
  for (const [rel, tpl] of Object.entries(DEFAULT_TEMPLATES)) {
    const body = fillTemplate(tpl, vars);
    results.push(await writeVaultFile(app, rel, body, { overwrite: !!opts.overwrite }));
  }
  // empty dirs markers
  for (const d of [
    'agent-inbox/soul/insights/drafts',
    'agent-inbox/soul/insights/accepted',
    'agent-inbox/soul/feedback',
    'agent-inbox/soul/thoughts',
    'agent-inbox/wiki/sources',
    'agent-inbox/wiki/reflections',
    'agent-inbox/raw',
    'agent-inbox/palace',
  ]) {
    if (!app.vault.getAbstractFileByPath(d)) {
      try {
        await app.vault.createFolder(d);
        results.push({ wrote: true, path: d, folder: true });
      } catch {
        /* exists */
      }
    }
  }

  if (opts.createHome !== false) {
    const homePath = opts.homePath || '00-首页.md';
    const homeBody = `---
title: Home
type: home
managed_by: me-soul
cssclasses:
  - me-soul-home
---

\`\`\`me-soul
\`\`\`

> [!me-soul-fallback] Me.Soul not loaded
> Enable community plugin **Me.Soul**, then reopen this note.
`;
    results.push(
      await writeVaultFile(app, homePath, homeBody, { overwrite: !!opts.overwrite })
    );
  }

  return results;
}

/**
 * @param {any} app
 */
export async function needsScaffold(app) {
  const soul = app.vault.getAbstractFileByPath('agent-inbox/soul/SOUL.md');
  return !soul;
}

/**
 * First-run modal.
 */
export class MeSoulSetupModal extends Modal {
  /**
   * @param {any} app
   * @param {import('./obsidian-plugin.js').default} plugin
   * @param {{ onDone?: () => void }} [opts]
   */
  constructor(app, plugin, opts = {}) {
    super(app);
    this.plugin = plugin;
    this.onDone = opts.onDone;
    this.agentName = plugin.settings.agentName || 'Me.Soul';
    this.userName = plugin.settings.userName || '';
    this.agentVibe = plugin.settings.agentVibe || '简洁、温暖、直接；像合伙人不是客服';
    this.homePath = plugin.settings.homePath || '00-首页.md';
    this.seedTemplates = true;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Me.Soul 初始配置（测试版）' });
    contentEl.createEl('p', {
      text: '开源 beta 不自带作者人格。在这里命名你的 Agent，并写入通用 soul 模板（可稍后在 agent-inbox/soul/ 改）。',
      cls: 'setting-item-description',
    });

    new Setting(contentEl)
      .setName('Agent 显示名')
      .setDesc('聊天标题与 IDENTITY 中的名字')
      .addText((t) =>
        t.setValue(this.agentName).onChange((v) => {
          this.agentName = v.trim() || 'Me.Soul';
        })
      );

    new Setting(contentEl)
      .setName('你的称呼')
      .setDesc('写入 profile / IDENTITY')
      .addText((t) =>
        t.setPlaceholder('可选').setValue(this.userName).onChange((v) => {
          this.userName = v.trim();
        })
      );

    new Setting(contentEl)
      .setName('气质 / Vibe')
      .setDesc('一句话描述 Agent 说话风格')
      .addTextArea((t) => {
        t.setValue(this.agentVibe).onChange((v) => {
          this.agentVibe = v;
        });
        t.inputEl.rows = 3;
      });

    new Setting(contentEl)
      .setName('首页路径')
      .setDesc('嵌入 ```me-soul``` 的笔记')
      .addText((t) =>
        t.setValue(this.homePath).onChange((v) => {
          this.homePath = v.trim() || '00-首页.md';
        })
      );

    new Setting(contentEl)
      .setName('写入 soul 模板')
      .setDesc('创建 agent-inbox/soul/*、wiki、pending 等（不覆盖已有文件）')
      .addToggle((t) =>
        t.setValue(this.seedTemplates).onChange((v) => {
          this.seedTemplates = v;
        })
      );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('跳过（稍后配置）')
        .onClick(async () => {
          this.plugin.settings.setupDone = true;
          await this.plugin.saveSettings();
          this.close();
          this.onDone?.();
        })
    );

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('完成并写入')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.agentName = this.agentName;
          this.plugin.settings.userName = this.userName;
          this.plugin.settings.agentVibe = this.agentVibe;
          this.plugin.settings.homePath = this.homePath;
          this.plugin.settings.setupDone = true;
          await this.plugin.saveSettings();

          if (this.seedTemplates) {
            try {
              await seedVaultScaffold(this.app, {
                agentName: this.agentName,
                userName: this.userName || 'User',
                agentVibe: this.agentVibe,
                homePath: this.homePath,
                createHome: true,
                overwrite: false,
              });
              new Notice('已写入通用 soul 模板（未覆盖已有文件）');
            } catch (e) {
              new Notice(`写入模板失败：${e?.message || e}`);
            }
          }
          this.close();
          this.onDone?.();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
