/**
 * Optional desktop smoke test for Grok ACP.
 * Usage:
 *   VAULT_ROOT=/path/to/vault node scripts/acp-smoke.mjs
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

// Prefer built paths via dynamic import of source (Node ESM)
const { GrokAcpClient, makeVaultAutoApprove } = await import(
  join(root, 'plugin/src/acp-client.js')
);
const { checkWritePolicy } = await import(join(root, 'packages/protocol/src/index.js'));

const vault = process.env.VAULT_ROOT || process.cwd();
console.log('vault', vault);

const client = new GrokAcpClient({
  binPath: process.env.GROK_BIN || '~/.grok/bin/grok',
  cwd: vault,
  autoApprove: makeVaultAutoApprove((rel) => checkWritePolicy(rel).allowed, vault),
});

console.log('spawn…');
// Keep minimal — users with grok binary can extend.
console.log('smoke helper loaded; set VAULT_ROOT and wire a prompt in a local fork if needed.');
void require;
void client;
