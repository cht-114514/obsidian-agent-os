#!/usr/bin/env node
/**
 * me-apply-pending: apply only if status=approved; marks applied; never writes human zones.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultVaultRoot, safeWrite, safeRead, loadProtocol } from '../lib/vault-io.mjs';

function parseArgs(argv) {
  const out = { vault: defaultVaultRoot(), pending: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--pending') out.pending = argv[++i];
    else if (argv[i] === '--vault') out.vault = resolve(argv[++i]);
  }
  return out;
}

export async function runApplyPending(opts) {
  const vault = opts.vault || defaultVaultRoot();
  const pendingPath = opts.pending;
  if (!pendingPath) throw new Error('--pending required');
  if (!pendingPath.startsWith('agent-inbox/')) {
    throw new Error('pending path must be under agent-inbox/');
  }

  const { applyPendingMarkdown, parsePendingMarkdown } = await loadProtocol();
  const md = safeRead(vault, pendingPath);
  if (md == null) throw new Error(`not found: ${pendingPath}`);

  const before = parsePendingMarkdown(md);
  if (before.status !== 'approved') {
    return {
      ok: false,
      error: `status is ${before.status}, need approved`,
      writes: [],
    };
  }

  const applied = applyPendingMarkdown(md);
  if (!applied.ok) return { ok: false, error: applied.error, writes: [] };

  const w = await safeWrite(vault, pendingPath, applied.markdown);
  if (!w.ok) throw new Error(w.error);

  // Note: human-zone materialization intentionally not performed here.
  return {
    ok: true,
    writes: [w.path],
    reply: `:::thought\npending 已 applied；人区仍保持只读，除非另开已批准的 human-zone 计划。\n:::\n\n已应用 \`${pendingPath}\`。`,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runApplyPending(args);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(result.reply);
  console.log('\n<!-- me-apply-pending writes: ' + JSON.stringify(result.writes) + ' -->');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
