import esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, 'dist');

// Optional: OBSIDIAN_PLUGIN_DIR=/path/to/vault/.obsidian/plugins/me-soul
// Fallback: walk up to a vault that already has .obsidian/plugins (dev convenience)
function resolveInstallDir() {
  if (process.env.OBSIDIAN_PLUGIN_DIR) return process.env.OBSIDIAN_PLUGIN_DIR;
  // plugin/ → me-soul → agent-inbox → vault
  const candidate = join(__dirname, '../../../.obsidian/plugins/me-soul');
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

const vaultPlugin = resolveInstallDir();
if (vaultPlugin) {
  mkdirSync(vaultPlugin, { recursive: true });
  copyFileSync(join(outDir, 'main.js'), join(vaultPlugin, 'main.js'));
  copyFileSync(join(__dirname, 'manifest.json'), join(vaultPlugin, 'manifest.json'));
  copyFileSync(join(__dirname, 'styles.css'), join(vaultPlugin, 'styles.css'));
  console.log('installed →', vaultPlugin);
} else {
  console.log('no vault plugin dir (set OBSIDIAN_PLUGIN_DIR to auto-install)');
}

console.log('built →', outDir);
