#!/usr/bin/env node
/**
 * me-care-check: scan vault signals + cares.md policy → pending-care.md
 * Usage: node run.mjs [--vault root] [--now ISO] [--quiet-today] [--sent-today N]
 */
import { resolve } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defaultVaultRoot,
  safeWrite,
  safeRead,
  abs,
  loadProtocol,
} from '../lib/vault-io.mjs';

function parseArgs(argv) {
  const out = {
    vault: defaultVaultRoot(),
    now: null,
    quietToday: false,
    sentToday: 0,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--vault') out.vault = resolve(argv[++i]);
    else if (argv[i] === '--now') out.now = argv[++i];
    else if (argv[i] === '--quiet-today') out.quietToday = true;
    else if (argv[i] === '--sent-today') out.sentToday = Number(argv[++i]);
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

function listPendingFiles(vault) {
  const dir = abs(vault, 'agent-inbox/pending');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .map((n) => `agent-inbox/pending/${n}`);
}

/**
 * Build candidate care items from vault signals (deterministic, no LLM).
 */
export function collectCandidates(vault) {
  /** @type {import('../../packages/protocol/src/care-policy.js').CareItem[]} */
  const items = [];
  const pending = listPendingFiles(vault).filter((p) => {
    const md = safeRead(vault, p);
    if (!md) return false;
    return !/^status:\s*(approved|rejected|applied)/m.test(md);
  });
  if (pending.length >= 3) {
    items.push({
      id: 'pending-pile',
      message: `有 ${pending.length} 条待确认 pending，要不要抽 15 分钟清一轮？`,
      evidence: pending.slice(0, 5),
      priority: 10,
    });
  } else if (pending.length > 0) {
    items.push({
      id: 'pending-some',
      message: `还有 ${pending.length} 条 pending 等你点头。`,
      evidence: pending,
      priority: 4,
    });
  }

  // empty wiki sources dir is not a care; skip heavy scans for determinism
  return items;
}

export async function runCareCheck(opts = {}) {
  const vault = opts.vault || defaultVaultRoot();
  const {
    parseCaresMarkdown,
    selectCareItems,
    serializePendingCare,
  } = await loadProtocol();

  let caresMd = safeRead(vault, 'agent-inbox/soul/cares.md') || '';
  if (opts.quietToday) {
    caresMd += '\nquietToday: true\n';
  }
  const config = parseCaresMarkdown(caresMd);
  if (opts.quietToday) config.quietToday = true;

  const now = opts.now ? new Date(opts.now) : new Date();
  const candidates = opts.candidates || collectCandidates(vault);
  const { items, suppressedReason } = selectCareItems(candidates, config, {
    now,
    sentToday: opts.sentToday ?? 0,
  });

  const md = serializePendingCare(items);
  const outRel = 'agent-inbox/soul/pending-care.md';
  const writes = [];
  if (!opts.dryRun) {
    const w = await safeWrite(vault, outRel, md);
    if (!w.ok) throw new Error(w.error);
    writes.push(w.path);
  } else {
    writes.push(outRel);
  }

  const thought =
    items.length > 0
      ? `有 ${items.length} 条牵挂值得说——都带着证据，不空喊。`
      : suppressedReason
        ? `牵挂静音：${suppressedReason}`
        : '扫了一圈，没什么非说不可的。';

  return {
    ok: true,
    writes,
    items,
    suppressedReason: suppressedReason || null,
    pendingCare: md,
    reply: `:::thought\n${thought}\n:::\n\n牵挂检查完成：${items.length} 条写入 \`${outRel}\`。`,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const result = await runCareCheck(args);
  console.log(result.reply);
  if (result.suppressedReason) console.log('suppressed:', result.suppressedReason);
  console.log('\n<!-- me-care-check writes: ' + JSON.stringify(result.writes) + ' -->');
  console.log('<!-- items: ' + JSON.stringify(result.items.map((i) => i.id)) + ' -->');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
