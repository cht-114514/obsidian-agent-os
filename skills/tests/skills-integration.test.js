/**
 * Integration tests: skill pure entry points against disposable vault copy.
 * Drives real run.mjs helpers — not reimplementations.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SCRATCH =
  process.env.ME_SOUL_TEST_SCRATCH ||
  join(tmpdir(), 'me-soul-skill-test');

async function load(name) {
  return import(pathToFileURL(join(ROOT, 'skills', name, 'run.mjs')).href);
}

async function loadVaultIo() {
  return import(pathToFileURL(join(ROOT, 'skills', 'lib', 'vault-io.mjs')).href);
}

function listAllFiles(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) listAllFiles(p, base, acc);
    else acc.push(p.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return acc;
}

describe('skills integration (disposable vault)', () => {
  /** @type {string} */
  let vault;

  before(() => {
    mkdirSync(SCRATCH, { recursive: true });
    vault = mkdtempSync(join(SCRATCH, 'vault-'));
    for (const d of [
      'agent-inbox/soul/insights/drafts',
      'agent-inbox/soul/insights/accepted',
      'agent-inbox/soul/feedback',
      'agent-inbox/palace',
      'agent-inbox/pending',
      'agent-inbox/wiki/sources',
      'agent-inbox/fixtures',
      '手记/日记',
      '项目库',
      '资料库',
      '基础学科',
    ]) {
      mkdirSync(join(vault, d), { recursive: true });
    }
    writeFileSync(
      join(vault, 'agent-inbox/soul/cares.md'),
      '---\ndaily_cap: 3\n---\n\n- 每日主动消息 **≤ 3**\n- Quiet hours：默认 23:30–07:00 不主动\n\n## 黑名单\n\n| 何时 | 范围 | 原因 |\n| ---- | ---- | ---- |\n| （空） | | |\n'
    );
    writeFileSync(
      join(vault, 'agent-inbox/soul/profile.md'),
      '# Profile\n\nseed\n'
    );
    writeFileSync(
      join(vault, 'agent-inbox/fixtures/note.md'),
      '# Note\n\n苏格拉底偏好测试材料。\n'
    );
  });

  it('digest writes only under agent-inbox', async () => {
    const { runDigest } = await load('me-digest');
    const r = await runDigest({
      vault,
      source: 'agent-inbox/fixtures/note.md',
    });
    assert.equal(r.ok, true);
    assert.ok(r.writes.every((p) => p.startsWith('agent-inbox/')));
    assert.match(r.reply, /:::thought/);
    assert.match(r.reply, /:::confirm/);
    for (const p of r.writes) {
      assert.ok(existsSync(join(vault, p)), p);
    }
    const human = listAllFiles(join(vault, '手记')).concat(
      listAllFiles(join(vault, '项目库')),
      listAllFiles(join(vault, '资料库')),
      listAllFiles(join(vault, '基础学科'))
    );
    assert.equal(human.length, 0);
  });

  it('write-insight + care-check policies', async () => {
    const { runWriteInsight } = await load('me-write-insight');
    const ir = await runWriteInsight({
      vault,
      title: 't',
      body: '偏好测试',
      slug: 'pref',
    });
    assert.ok(ir.writes.every((p) => p.startsWith('agent-inbox/')));
    assert.match(ir.reply, /:::confirm/);

    const { runCareCheck } = await load('me-care-check');
    const noon = await runCareCheck({
      vault,
      now: new Date('2026-07-18T12:00:00'),
      sentToday: 0,
    });
    assert.ok(noon.items.length >= 1);
    assert.ok(noon.items.every((i) => i.evidence.length > 0));

    const quiet = await runCareCheck({
      vault,
      now: new Date('2026-07-18T23:45:00'),
      sentToday: 0,
    });
    assert.equal(quiet.items.length, 0);
    assert.match(quiet.suppressedReason || '', /quiet/);

    const cap = await runCareCheck({
      vault,
      now: new Date('2026-07-18T12:00:00'),
      sentToday: 3,
    });
    assert.equal(cap.items.length, 0);
    assert.match(cap.suppressedReason || '', /cap/);
  });

  it('refuses skill I/O write into human zone without approved pending', async () => {
    // Drive the real safeWrite used by all me-* skills (shipped vault-io).
    const { safeWrite } = await loadVaultIo();
    const evilRel = '手记/日记/evil-from-skill.md';
    const denied = await safeWrite(vault, evilRel, '# should not land\n', {
      approvedPending: false,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error || '', /write denied|human zone/i);
    assert.equal(existsSync(join(vault, evilRel)), false);

    // Same path still denied if a skill tried after digest (no approved flag).
    const still = await safeWrite(vault, '项目库/evil.md', 'x');
    assert.equal(still.ok, false);
    assert.equal(existsSync(join(vault, '项目库/evil.md')), false);

    // Agent-inbox write via same entry point succeeds (control).
    const ok = await safeWrite(vault, 'agent-inbox/wiki/sources/ok.md', '# ok\n');
    assert.equal(ok.ok, true);
    assert.equal(existsSync(join(vault, 'agent-inbox/wiki/sources/ok.md')), true);
  });
});
