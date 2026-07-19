/**
 * Build Grok Build skill prompts from SKILL.md + user intent.
 * Pure helpers (loaders take injected readFile).
 */

export const GROK_SKILL_IDS = new Set([
  'me-digest',
  'me-write-insight',
  'me-care-check',
  'me-soul-promote',
  'memorized',
  'me-reindex',
  'me-apply-pending',
  'me-apply-insight',
]);

/** Fallback skill bodies when SKILL.md is missing from vault. */
export const FALLBACK_SKILLS = {
  'me-digest': `# me-digest

You are running on Grok Build with vault cwd = Obsidian vault root.

## Goal
Compile source note(s) into **pending_review** wiki pages under agent-inbox.

## Steps
1. Resolve sources from user message / @paths / current note context / batch intent (e.g. 所有日记 → 手记/日记 + 手记/手写日记).
2. Read each source with tools. Prefer batch ≤8 per turn; report remaining.
3. For each source write:
   - \`agent-inbox/wiki/sources/YYYY-MM-DD-<slug>.md\` with YAML:
     type: wiki-source, wiki_status: pending_review, source_paths, managed_by: me-digest, created
   - Full structured wiki body (not a mechanical truncation).
   - \`agent-inbox/pending/YYYY-MM-DD-digest-<slug>.md\` pending record.
4. Only write under agent-inbox/. Never write human zones without approved pending.

## User-facing output
Use short :::thought blocks. For each digest emit a confirm fence:

:::confirm type=digest path=agent-inbox/pending/...
title: 确认 digest: <name>
body: 待审 wiki 路径与预览
actions: [accept, reject]
:::

Accept (plugin) → wiki accepted. Reject → delete wiki.
`,

  'me-write-insight': `# me-write-insight

Vault-native skill for Grok Build.

## Goal
Draft a 心迹 (insight) about the **user's stable preferences/boundaries**, NOT a discussion of a note.

## Steps
1. From user text, extract title + body (title|body optional).
2. Write draft: agent-inbox/soul/insights/drafts/YYYY-MM-DD-<slug>.md
3. Write pending: agent-inbox/pending/YYYY-MM-DD-insight-<slug>.md (type: insight, path: agent-inbox/soul/profile.md)
4. Output :::thought + :::confirm type=insight

If user is clearly discussing a note (@ or 讨论), refuse skill and tell them to drop the pill and chat normally.
`,

  'me-care-check': `# me-care-check

## Goal
Scan vault signals against agent-inbox/soul/cares.md; write proactive care drafts.

## Steps
1. Read cares.md (daily_cap, quiet hours, blacklist).
2. Scan evidence: pending pile, stale projects, learning gaps — only with concrete paths.
3. Write/update agent-inbox/soul/pending-care.md only.
4. Summarize for user. No human-zone writes.
`,

  'me-soul-promote': `# me-soul-promote

## Goal
Promote insights/reflections/feedback into Soul files **with confirm**.

## Steps
1. Scan agent-inbox/soul/insights/*, feedback/*, wiki/reflections/* (skip pure knowledge sources).
2. Propose updates to profile.md / style.md / SOUL.md (not IDENTITY unless asked).
3. Write agent-inbox/pending/YYYY-MM-DD-soul-promote.md with JSON plan in a json fence.
4. Emit :::confirm type=soul-promote path=...

Accept (plugin) applies the plan to soul files.
`,

  memorized: `# memorized

## Goal
Prepare / refresh **vector memory** for accepted wiki sources.

## Steps
1. List agent-inbox/wiki/sources/*.md excluding wiki_status: pending_review.
2. Report how many pages will be embedded and model expectations (bge-m3 via plugin embed settings).
3. You cannot call the embed HTTP API yourself. Output:

:::confirm type=memorized path=agent-inbox/wiki/vectors.jsonl
title: 写入向量记忆库
body: 将 N 篇 accepted wiki 切块并 embedding → vectors.jsonl；删除遗留 index.md
actions: [accept, reject]
:::

On Accept the Obsidian plugin runs the local embedder. On Reject do nothing.
Alias: /me-reindex
`,

  'me-reindex': `# me-reindex

Alias of **memorized**. Follow memorized skill exactly.
`,

  'me-apply-pending': `# me-apply-pending

## Goal
Apply an already **approved** pending record. Never apply pending status.

## Steps
1. Resolve pending path from @ or user text.
2. Read pending; if status is not approved, stop and explain.
3. Perform the documented apply under agent-inbox only unless pending authorizes human-zone with approved flag.
4. Set pending status applied / note result for user.
`,

  'me-apply-insight': `# me-apply-insight

## Goal
Merge an accepted insight into agent-inbox/soul/profile.md (or paths in pending).

## Steps
1. Resolve pending insight path.
2. If still pending (not accepted), tell user to Accept the card first.
3. Append a dated section to profile.md from the insight body.
4. Optionally move draft to insights/accepted/.
`,
};

/**
 * @param {string} skillId
 * @param {(rel: string) => Promise<string|null>} readFile vault-relative reader
 */
export async function loadSkillMarkdown(skillId, readFile) {
  const id = skillId === 'me-reindex' ? 'memorized' : skillId;
  const candidates = [
    `agent-inbox/me-soul/skills/${id}/SKILL.md`,
    `agent-inbox/me-soul/skills/${skillId}/SKILL.md`,
  ];
  for (const rel of candidates) {
    try {
      const md = await readFile(rel);
      if (md && md.trim()) return md;
    } catch {
      /* */
    }
  }
  return FALLBACK_SKILLS[skillId] || FALLBACK_SKILLS[id] || `# ${skillId}\n\nFollow user intent. Only write under agent-inbox/ unless confirmed.\n`;
}

/**
 * @param {{
 *   skillId: string,
 *   skillMd: string,
 *   userText: string,
 *   contextBlock: string,
 *   activePath?: string | null,
 * }} args
 */
export function buildGrokSkillPrompt(args) {
  const skillId = args.skillId || 'skill';
  const parts = [];
  parts.push(`# Skill execution: /${skillId}`);
  parts.push('');
  parts.push('You are Grok Build operating on an Obsidian vault (cwd = vault root).');
  parts.push('Execute the skill below using your tools (read/search/edit). Prefer agent-inbox/ writes.');
  parts.push('Human zones (手记/项目库/资料库/基础学科) require user-approved pending — do not write them silently.');
  parts.push('');
  parts.push('## Confirm protocol (required when user must approve)');
  parts.push('Emit Obsidian Agent OS fences the plugin can render:');
  parts.push('');
  parts.push(':::thought');
  parts.push('1-3 short lines');
  parts.push(':::');
  parts.push('');
  parts.push(':::confirm type=<digest|insight|soul-promote|memorized> path=<pending-or-target-path>');
  parts.push('title: ...');
  parts.push('body: ...');
  parts.push('actions: [accept, reject]');
  parts.push(':::');
  parts.push('');
  parts.push('After writing files, summarize paths for the user in plain language.');
  parts.push('');
  parts.push('## SKILL.md');
  parts.push(args.skillMd || '');
  parts.push('');
  if (args.activePath) {
    parts.push('## Current open note (auto context)');
    parts.push(`\`${args.activePath}\``);
    parts.push('');
  }
  if (args.contextBlock) {
    parts.push(args.contextBlock);
    parts.push('');
  }
  parts.push('## User intent');
  parts.push(String(args.userText || '').trim() || `(run /${skillId} with defaults)`);
  return parts.join('\n');
}

/**
 * @param {string} skillId
 */
export function isGrokSkill(skillId) {
  return GROK_SKILL_IDS.has(skillId);
}
