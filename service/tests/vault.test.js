import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVault, fingerprintOf } from '../src/vault.js';
import { createConfirmations } from '../src/confirmations.js';

let dir;
let vault;
const ROOT_FILES = {
  'agent-inbox/notes/alpha.md': '# Alpha\n\nvector memory and the phone entry point\n',
  'agent-inbox/wiki/beta.md': '# Beta\n\nsomething else entirely\n',
  '手记/journal.md': '# Journal\n\nprivate human text\n',
  '资料库/reference.md': '# Reference\n\nshared reading\n',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aos-vault-'));
  for (const [rel, content] of Object.entries(ROOT_FILES)) {
    const absolute = join(dir, rel);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  writeFileSync(join(dir, 'image.png'), 'not really a png');
  mkdirSync(join(dir, '.obsidian'), { recursive: true });
  writeFileSync(join(dir, '.obsidian/app.json'), '{"secret":true}');
  vault = createVault({ root: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('vault paths', () => {
  it('reads a note with a content fingerprint', () => {
    const note = vault.readNote('agent-inbox/notes/alpha.md');
    assert.match(note.content, /vector memory/);
    assert.equal(note.fingerprint, fingerprintOf(ROOT_FILES['agent-inbox/notes/alpha.md']));
    assert.equal(note.humanZone, false);
    assert.equal(note.truncated, false);
  });

  it('blocks traversal and protected directories', () => {
    assert.throws(() => vault.readNote('../secret.md'), /traversal|escapes/);
    assert.throws(() => vault.readNote('/etc/passwd'), /absolute|escapes/);
    assert.throws(() => vault.readNote('C:\\Windows\\win.ini'), /absolute|escapes/);
    assert.throws(() => vault.readNote('.obsidian/app.json'), /blocked/);
    assert.throws(() => vault.readNote('agent-inbox/../../outside.md'), /traversal|escapes/);
  });

  it('refuses to read binary files', () => {
    assert.throws(() => vault.readNote('image.png'), (error) => error.code === 'UNSUPPORTED_TYPE');
  });

  it('reports a missing note clearly', () => {
    assert.throws(() => vault.readNote('agent-inbox/notes/missing.md'), (error) => error.code === 'NOT_FOUND');
  });
});

describe('vault search and listing', () => {
  it('finds notes by content and by filename with an excerpt', () => {
    const byContent = vault.searchNotes('vector memory');
    assert.equal(byContent.length, 1);
    assert.equal(byContent[0].path, 'agent-inbox/notes/alpha.md');
    assert.match(byContent[0].excerpt, /vector memory/);

    const byName = vault.searchNotes('beta');
    assert.ok(byName.some((hit) => hit.path === 'agent-inbox/wiki/beta.md'));
  });

  it('never surfaces protected directories', () => {
    const notes = vault.listNotes('', 1000);
    assert.ok(notes.includes('agent-inbox/notes/alpha.md'));
    assert.ok(notes.includes('手记/journal.md'));
    assert.ok(!notes.some((path) => path.includes('.obsidian')));
    assert.ok(!notes.some((path) => path.endsWith('.png')));
  });

  it('marks human-zone hits so the UI can warn', () => {
    const hits = vault.searchNotes('private human text');
    assert.equal(hits[0].humanZone, true);
  });
});

describe('vault writes', () => {
  it('allows free writes inside agent-inbox', async () => {
    const result = await vault.writeNote('agent-inbox/notes/new.md', 'fresh', { expectFingerprint: null });
    assert.equal(result.created, true);
    assert.equal(vault.readNote('agent-inbox/notes/new.md').content, 'fresh');
  });

  it('requires a confirmation for a human zone', async () => {
    await assert.rejects(
      () => vault.writeNote('手记/journal.md', 'overwrite', { expectFingerprint: null }),
      (error) => error.code === 'POLICY_DENIED'
    );
    // Nothing changed.
    assert.equal(vault.readNote('手记/journal.md').content, ROOT_FILES['手记/journal.md']);
  });

  it('applies a confirmed write when the fingerprint still matches', async () => {
    const before = vault.readNote('手记/journal.md');
    const result = await vault.writeNote('手记/journal.md', 'approved change', {
      expectFingerprint: before.fingerprint,
      approvedPending: true,
    });
    assert.equal(result.created, false);
    assert.equal(vault.readNote('手记/journal.md').content, 'approved change');
  });

  it('refuses to overwrite text that changed after the diff was shown', async () => {
    const shown = vault.readNote('手记/journal.md');
    // The human edits the note while the phone is showing the confirmation.
    writeFileSync(join(dir, '手记/journal.md'), '# Journal\n\nedited by hand\n');
    await assert.rejects(
      () =>
        vault.writeNote('手记/journal.md', 'stale overwrite', {
          expectFingerprint: shown.fingerprint,
          approvedPending: true,
        }),
      (error) => error.code === 'PRECONDITION_FAILED' && !!error.current
    );
    assert.match(vault.readNote('手记/journal.md').content, /edited by hand/);
  });

  it('requires a fingerprint for an overwrite of an existing file', async () => {
    await assert.rejects(
      () => vault.writeNote('agent-inbox/notes/alpha.md', 'no precondition'),
      (error) => error.code === 'PRECONDITION_REQUIRED'
    );
  });

  it('describes a proposed write for the confirmation card', () => {
    const preview = vault.describeWrite('手记/journal.md', 'new text');
    assert.equal(preview.exists, true);
    assert.equal(preview.humanZone, true);
    assert.equal(preview.currentFingerprint, fingerprintOf(ROOT_FILES['手记/journal.md']));
    assert.equal(preview.proposedFingerprint, fingerprintOf('new text'));
  });

  it('reports vault availability honestly', () => {
    const missing = createVault({ root: join(dir, 'nope') });
    assert.equal(missing.enabled, false);
    assert.equal(missing.status().readable, false);
    assert.throws(() => missing.listNotes(''), (error) => error.code === 'VAULT_UNAVAILABLE');
  });
});

describe('confirmation tokens', () => {
  it('is single use and device bound', () => {
    const confirmations = createConfirmations({ ttlMs: 60_000 });
    const token = confirmations.issue({ deviceId: 'dev-a', path: '手记/x.md', fingerprint: 'sha256:1' });
    assert.equal(confirmations.consume(token, { deviceId: 'dev-b' }), null);
    const consumed = confirmations.consume(token, { deviceId: 'dev-a', path: '手记/x.md', fingerprint: 'sha256:1' });
    assert.ok(consumed);
    assert.equal(confirmations.consume(token, { deviceId: 'dev-a' }), null);
  });

  it('refuses a mismatched fingerprint', () => {
    const confirmations = createConfirmations({ ttlMs: 60_000 });
    const token = confirmations.issue({ deviceId: 'dev-a', path: '手记/x.md', fingerprint: 'sha256:1' });
    assert.equal(confirmations.consume(token, { deviceId: 'dev-a', fingerprint: 'sha256:2' }), null);
  });

  it('expires', () => {
    const confirmations = createConfirmations({ ttlMs: -1 });
    const token = confirmations.issue({ deviceId: 'dev-a', path: 'a', fingerprint: null });
    assert.equal(confirmations.peek(token, 'dev-a'), null);
  });
});
