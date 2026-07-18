import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

// Optional: OBSIDIAN_PLUGIN_DIR=/path/to/vault/.obsidian/plugins/obsidian-agent-os
// Fallback: walk up to a vault that already has .obsidian/plugins (dev convenience)
function resolveInstallDir() {
  if (process.env.OBSIDIAN_PLUGIN_DIR) return process.env.OBSIDIAN_PLUGIN_DIR;
  // plugin/ → me-soul → agent-inbox → vault
  const candidate = join(__dirname, '../../../.obsidian/plugins/obsidian-agent-os');
  if (existsSync(join(__dirname, '../../../.obsidian'))) return candidate;
  return null;
}

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(__dirname, 'src/obsidian-plugin.js')],
  bundle: true,
  outfile: join(outDir, 'main.js'),
  format: 'cjs',
  platform: 'node',
  target: 'es2020',
  external: [
    'obsidian',
    'electron',
    'child_process',
    'path',
    'fs',
    'node:child_process',
    'node:path',
    'node:fs',
  ],
  logLevel: 'info',
});

let bundle = readFileSync(join(outDir, 'main.js'), 'utf8');
if (!/module\.exports\s*=/.test(bundle)) {
  bundle += '\nmodule.exports = module.exports.default || exports.default;\n';
  writeFileSync(join(outDir, 'main.js'), bundle);
}

copyFileSync(join(__dirname, 'manifest.json'), join(outDir, 'manifest.json'));
copyFileSync(join(__dirname, 'styles.css'), join(outDir, 'styles.css'));

function installTo(dir) {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(outDir, 'main.js'), join(dir, 'main.js'));
  copyFileSync(join(__dirname, 'manifest.json'), join(dir, 'manifest.json'));
  copyFileSync(join(__dirname, 'styles.css'), join(dir, 'styles.css'));
  console.log('installed →', dir);
}

const vaultPlugin = resolveInstallDir();
installTo(vaultPlugin);
// Dev convenience: also refresh legacy folder name if present
const legacy = join(__dirname, '../../../.obsidian/plugins/me-soul');
if (existsSync(legacy) && legacy !== vaultPlugin) {
  installTo(legacy);
}

console.log('built →', outDir);
