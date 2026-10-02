/**
 * Render the chat shell in headless Chrome at iPhone size.
 * Usage: node scripts/mobile-preview.mjs
 */
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const states = ['thread', 'tools', 'empty', 'offline', 'pairing', 'keyboard', 'drawer'];
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function page(state, theme) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=393, initial-scale=1" />
<style>
  html, body { margin: 0; width: 393px; height: 852px; overflow: hidden; background: ${theme === 'light' ? '#faf9f7' : '#0e1015'}; }
  #app { height: 100%; }
  ${css}
</style>
</head>
<body class="${theme === 'light' ? 'theme-light' : 'theme-dark'}">
<div id="app"></div>
<script>location.hash = ${JSON.stringify(`#${state}&theme=${theme}`)};</script>
<script>${js}</script>
</body>
</html>`;
}

const shots = [];
for (const theme of ['dark', 'light']) {
  for (const state of states) {
    const htmlPath = join(outDir, `${theme}-${state}.html`);
    const pngPath = join(outDir, `${theme}-${state}.png`);
    writeFileSync(htmlPath, page(state, theme));
    const result = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--virtual-time-budget=1500',
      '--timeout=10000',
      '--force-device-scale-factor=2',
      '--window-size=393,852',
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ], { stdio: 'pipe' });
    if (result.status !== 0) {
      console.error(result.stderr?.toString() || result.stdout?.toString());
      throw new Error(`screenshot failed: ${theme}-${state}`);
    }
    shots.push(pngPath);
    console.log('shot', pngPath);
  }
}
console.log(`preview ${shots.length} shots in ${outDir}`);
