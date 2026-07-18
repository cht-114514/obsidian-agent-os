#!/usr/bin/env node
/**
 * me-write-insight: draft a 心迹 into soul/insights/drafts + pending confirm.
 * Usage: node run.mjs --body "..." [--title "..."] [--vault root]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultVaultRoot,
  safeWrite,
  today,
  thoughtFence,
  confirmFence,
} from '../lib/vault-io.mjs';

function parseArgs(argv) {
  const out = {
    vault: defaultVaultRoot(),
    body: null,
    title: '心迹',
    slug: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--body') out.body = argv[++i];
    else if (argv[i] === '--title') out.title = argv[++i];
    else if (argv[i] === '--slug') out.slug = argv[++i];
    else if (argv[i] === '--vault') out.vault = resolve(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function slugify(s) {
  return String(s)
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'insight';
}

export async function runWriteInsight(opts) {
  const vault = opts.vault || defaultVaultRoot();
  const body = opts.body;
  if (!body) throw new Error('--body required');

  const date = today();
  const slug = opts.slug || slugify(opts.title || body.slice(0, 24));
  const draftRel = `agent-inbox/soul/insights/drafts/${date}-${slug}.md`;
  const pendingRel = `agent-inbox/pending/${date}-insight-${slug}.md`;

  const draftMd = [
    '---',
    'status: draft',
    `type: insight`,
    `title: ${opts.title || '心迹'}`,
    `created: ${date}`,
    '---',
    '',
    body,
    '',
  ].join('\n');

  const pendingMd = [
    '---',
    'status: pending',
    'type: insight',
    `title: ${opts.title || '心迹'}`,
    `created: ${date}`,
    `path: agent-inbox/soul/profile.md`,
    `source_paths: ${JSON.stringify([draftRel])}`,
    '---',
    '',
    '## 心迹草案',
    '',
    body,
    '',
    '## 合并计划',
    '',
    `- 确认后由 me-apply-insight 合并要点到 \`agent-inbox/soul/profile.md\``,
    `- 草案保留在 \`${draftRel}\`，accepted 副本写入 insights/accepted/`,
    '',
  ].join('\n');

  const writes = [];
  if (!opts.dryRun) {
    const w1 = await safeWrite(vault, draftRel, draftMd);
    if (!w1.ok) throw new Error(w1.error);
    writes.push(w1.path);
    const w2 = await safeWrite(vault, pendingRel, pendingMd);
    if (!w2.ok) throw new Error(w2.error);
    writes.push(w2.path);
  } else {
    writes.push(draftRel, pendingRel);
  }

  const reply = [
    thoughtFence('这一点像是稳定偏好，先写成心迹草案，你点头我再写进 profile。'),
    `已起草心迹：\`${draftRel}\``,
    '',
    confirmFence({
      type: 'insight',
      path: pendingRel,
      title: opts.title || '心迹确认',
      body,
    }),
  ].join('\n');

  return { ok: true, writes, reply, draftRel, pendingRel };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runWriteInsight(args);
  console.log(result.reply);
  console.log('\n<!-- me-write-insight writes: ' + JSON.stringify(result.writes) + ' -->');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
