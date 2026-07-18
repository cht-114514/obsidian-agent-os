#!/usr/bin/env node
/**
 * me-apply-insight: merge approved insight pending into profile + accepted folder.
 */
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultVaultRoot,
  safeWrite,
  safeRead,
  loadProtocol,
  today,
} from '../lib/vault-io.mjs';

function parseArgs(argv) {
  const out = { vault: defaultVaultRoot(), pending: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--pending') out.pending = argv[++i];
    else if (argv[i] === '--vault') out.vault = resolve(argv[++i]);
  }
  return out;
}

export async function runApplyInsight(opts) {
  const vault = opts.vault || defaultVaultRoot();
  const pendingPath = opts.pending;
  if (!pendingPath) throw new Error('--pending required');

  const {
    applyPendingMarkdown,
    parsePendingMarkdown,
    approvePendingMarkdown,
  } = await loadProtocol();

  let md = safeRead(vault, pendingPath);
  if (md == null) throw new Error(`not found: ${pendingPath}`);
  let rec = parsePendingMarkdown(md);

  // Allow applying after approve in same flow if already approved only
  if (rec.status === 'pending') {
    return { ok: false, error: 'pending not approved yet', writes: [] };
  }
  if (rec.status === 'rejected') {
    return { ok: false, error: 'rejected insight cannot apply', writes: [] };
  }

  if (rec.status === 'approved') {
    const applied = applyPendingMarkdown(md);
    if (!applied.ok) return { ok: false, error: applied.error, writes: [] };
    md = applied.markdown;
    rec = parsePendingMarkdown(md);
  }

  const writes = [];
  const wPending = await safeWrite(vault, pendingPath, md);
  if (!wPending.ok) throw new Error(wPending.error);
  writes.push(wPending.path);

  // append to profile under agent-inbox
  const profileRel = 'agent-inbox/soul/profile.md';
  let profile = safeRead(vault, profileRel) || '# Profile\n';
  const block = [
    '',
    `## Insight ${today()} — ${rec.title}`,
    '',
    rec.body.trim(),
    '',
  ].join('\n');
  if (!profile.includes(rec.body.trim().slice(0, 40))) {
    profile = profile.trimEnd() + '\n' + block;
  }
  const wProf = await safeWrite(vault, profileRel, profile);
  if (!wProf.ok) throw new Error(wProf.error);
  writes.push(wProf.path);

  const acceptedRel = `agent-inbox/soul/insights/accepted/${today()}-${basename(pendingPath)}`;
  const wAcc = await safeWrite(
    vault,
    acceptedRel,
    `---\nstatus: accepted\ntitle: ${rec.title}\n---\n\n${rec.body}\n`
  );
  if (!wAcc.ok) throw new Error(wAcc.error);
  writes.push(wAcc.path);

  return {
    ok: true,
    writes,
    reply: `:::thought\n心迹进 profile 了——越用越懂你，靠的是你点头，不是我偷记。\n:::\n\n已合并 insight → \`${profileRel}\`。`,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runApplyInsight(args);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.reply);
  console.log('\n<!-- me-apply-insight writes: ' + JSON.stringify(result.writes) + ' -->');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
