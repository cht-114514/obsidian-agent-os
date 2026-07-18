#!/usr/bin/env node
/**
 * me-digest: digest a source note into agent-inbox/wiki + optional pending plan.
 * Usage: node run.mjs --source <vault-rel-path> [--vault <root>] [--fixture-text <file>]
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultVaultRoot,
  safeWrite,
  safeRead,
  today,
  thoughtFence,
  confirmFence,
  createWriteLog,
} from '../lib/vault-io.mjs';

function parseArgs(argv) {
  const out = { source: null, vault: defaultVaultRoot(), fixtureText: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source') out.source = argv[++i];
    else if (argv[i] === '--vault') out.vault = resolve(argv[++i]);
    else if (argv[i] === '--fixture-text') out.fixtureText = resolve(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function slugify(s) {
  return String(s)
    .replace(/\.md$/i, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'note';
}

function extractSummary(text, max = 400) {
  const plain = String(text)
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/[#>*`]/g, '')
    .trim();
  const lines = plain.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, 6).join(' ');
  return head.length > max ? head.slice(0, max) + '…' : head;
}

export async function runDigest(opts) {
  const vault = opts.vault || defaultVaultRoot();
  const source = opts.source;
  if (!source) throw new Error('--source required');

  let content;
  if (opts.fixtureText) {
    content = readFileSync(opts.fixtureText, 'utf8');
  } else {
    content = safeRead(vault, source);
    if (content == null) throw new Error(`source not found: ${source}`);
  }

  const date = today();
  const slug = slugify(basename(source));
  const wikiRel = `agent-inbox/wiki/sources/${date}-${slug}.md`;
  const pendingRel = `agent-inbox/pending/${date}-digest-${slug}.md`;
  const log = createWriteLog();

  const summary = extractSummary(content);
  const wikiBody = [
    '---',
    `type: wiki-source`,
    `created: ${date}`,
    `source_paths: ${JSON.stringify([source])}`,
    `managed_by: me-digest`,
    '---',
    '',
    `# Digest: ${basename(source)}`,
    '',
    '## Summary',
    '',
    summary || '(empty source)',
    '',
    '## Source',
    '',
    `- [[${source}]]`,
    '',
    '## Agent notes',
    '',
    '- Digested into agent-owned wiki only; human zones untouched.',
    '',
  ].join('\n');

  const pendingBody = [
    '---',
    'status: pending',
    'type: digest',
    `title: Digest ${basename(source)}`,
    `created: ${date}`,
    `path: ${wikiRel}`,
    `source_paths: ${JSON.stringify([source])}`,
    '---',
    '',
    `## Plan`,
    '',
    `- Wiki page written/updated: \`${wikiRel}\``,
    `- No automatic writes to 手记/项目库/资料库/基础学科`,
    `- Approve to mark this digest plan applied (wiki already in agent-inbox).`,
    '',
    '## Summary preview',
    '',
    summary || '(empty)',
    '',
  ].join('\n');

  const writes = [];
  if (!opts.dryRun) {
    const w1 = await safeWrite(vault, wikiRel, wikiBody);
    if (!w1.ok) throw new Error(w1.error);
    log.track(w1.path);
    writes.push(w1.path);

    const w2 = await safeWrite(vault, pendingRel, pendingBody);
    if (!w2.ok) throw new Error(w2.error);
    log.track(w2.path);
    writes.push(w2.path);
  } else {
    writes.push(wikiRel, pendingRel);
  }

  const thought = '材料进 wiki 编译层了；人区我不动，pending 留给你点头。';
  const reply = [
    thoughtFence(thought),
    `已消化 \`${source}\` → \`${wikiRel}\`。`,
    '',
    confirmFence({
      type: 'digest',
      path: pendingRel,
      title: `确认 digest: ${basename(source)}`,
      body: `Wiki 已写入 agent-inbox。批准将 pending 标为 approved/applied；不会自动改四主区。`,
    }),
  ].join('\n');

  return { ok: true, writes, reply, wikiRel, pendingRel, thought };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runDigest(args);
  console.log(result.reply);
  console.log('\n<!-- me-digest writes: ' + JSON.stringify(result.writes) + ' -->');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
