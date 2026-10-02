/**
 * Render the chat shell in headless Chrome at iPhone size.
 * Usage: node scripts/mobile-preview.mjs
 */
import esbuild from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = '/tmp/aos-mobile-preview';
mkdirSync(outDir, { recursive: true });

const bundled = await esbuild.build({
  entryPoints: [join(root, 'scripts/preview-app.js')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
});
const js = bundled.outputFiles[0].text;
const css = readFileSync(join(root, 'styles.css'), 'utf8');
const vaultRoot = join(root, '../../..');
function baselineLayer() {
  let layer = '';
  for (const rel of [
    '.obsidian-mobile/themes/Baseline/theme.css',
    '.obsidian-mobile/snippets/baseline-optimized.minimal.active.css',
  ]) {
    const path = join(vaultRoot, rel);
    if (!existsSync(path)) continue;
    layer += `\n/* baseline layer: ${rel} */\n`;
    layer += readFileSync(path, 'utf8').slice(0, 100_000);
  }
  return layer;
}
const baselineCss = baselineLayer();
const states = ['thread', 'tools', 'empty', 'offline', 'pairing', 'keyboard', 'drawer'];
const widths = [375, 393, 430];
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function page(state, theme, width) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}, initial-scale=1" />
<style>
  html, body { margin: 0; width: ${width}px; height: 852px; overflow: hidden; background: ${theme === 'light' ? '#faf9f7' : '#0e1015'}; }
  body.is-phone button { min-height: var(--touch-size, 44px); }
  #app { height: 100%; }
  ${css}
  ${baselineCss}
</style>
</head>
<body class="is-mobile is-phone ${theme === 'light' ? 'theme-light' : 'theme-dark'}">
<div id="app"></div>
<script>location.hash = ${JSON.stringify(`#${state}&theme=${theme}&hideNav=1`)};</script>
<script>${js}</script>
</body>
</html>`;
}

const shots = [];
for (const theme of ['dark', 'light']) {
  for (const width of widths) {
    for (const state of states) {
      const slug = `${theme}-${width}-${state}`;
    const htmlPath = join(outDir, `${slug}.html`);
    const pngPath = join(outDir, `${slug}.png`);
    writeFileSync(htmlPath, page(state, theme, width));
    const result = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--virtual-time-budget=1500',
      '--timeout=10000',
      '--force-device-scale-factor=2',
      `--window-size=${width},852`,
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ], { stdio: 'pipe' });
    if (result.status !== 0) {
      console.error(result.stderr?.toString() || result.stdout?.toString());
      throw new Error(`screenshot failed: ${slug}`);
    }
    shots.push(pngPath);
    console.log('shot', pngPath);
    }
  }
}
console.log(`preview ${shots.length} shots in ${outDir}`);
