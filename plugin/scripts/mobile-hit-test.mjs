/**
 * Headless hit-test: portaled composer must win over navbar + corner FAB/dock.
 * Usage: node scripts/mobile-hit-test.mjs
 */
import esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = '/tmp/aos-mobile-hit-test';
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
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const runnerPath = join(outDir, 'runner.html');
writeFileSync(
  runnerPath,
  `<!doctype html>
<html><head><meta charset="utf-8"><title>pending</title>
<meta name="viewport" content="width=393, initial-scale=1" />
<style>
  html, body { margin: 0; width: 393px; height: 852px; overflow: hidden; background: #0e1015; }
  body { --view-bottom-spacing: 96px; --safe-area-inset-bottom: 34px; }
  .workspace-leaf {
    flex: 1;
    min-height: 0;
    contain: strict;
    isolation: isolate;
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .workspace-leaf-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  #app { height: 100%; display: flex; flex-direction: column; flex: 1; min-height: 0; }
  ${css}
  .mobile-navbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 52px;
    margin-bottom: 20px;
    background: rgba(255,255,255,0.12);
    z-index: 30;
    pointer-events: auto;
  }
  .fake-fab {
    position: fixed;
    right: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    width: 52px;
    height: 52px;
    border-radius: 26px;
    background: rgba(255, 120, 80, 0.35);
    z-index: 30;
    pointer-events: auto;
  }
  .fake-dock {
    position: fixed;
    left: 16px;
    bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    width: 48px;
    height: 48px;
    border-radius: 24px;
    background: rgba(80, 160, 255, 0.35);
    z-index: 30;
    pointer-events: auto;
  }
</style></head>
<body class="theme-dark is-mobile is-phone">
<div class="workspace-leaf">
  <div class="workspace-leaf-content" data-type="me-soul-chat">
    <div id="app"></div>
  </div>
</div>
<div class="mobile-navbar" aria-hidden="true"></div>
<div class="fake-fab" aria-hidden="true"></div>
<div class="fake-dock" aria-hidden="true"></div>
<script>location.hash='#thread&theme=dark';</script>
<script>${js}</script>
<script>
async function runHitTest() {
  const root = document.querySelector('.aos-root');
  const host = document.querySelector('.aos-composer-host');
  if (root) {
    const nav = document.querySelector('.mobile-navbar');
    if (nav) {
      const rect = nav.getBoundingClientRect();
      const stack = Math.round(window.innerHeight - rect.top);
      if (stack > 0) {
        root.style.setProperty('--aos-navbar-h', stack + 'px');
        root.style.setProperty('--aos-nav-clearance', stack + 'px');
      }
    }
  }
  if (host && host.classList.contains('is-portal')) {
    const navStack =
      parseInt(getComputedStyle(root).getPropertyValue('--aos-navbar-h') || '96', 10) || 96;
    host.style.bottom = navStack + 8 + 'px';
  }
  document.body.offsetHeight;
  const send = document.querySelector('.aos-send');
  const chip = document.querySelector('.aos-chip');
  const menu = document.querySelector('.aos-top-menu');
  if (!send || !chip || !menu || !host) {
    document.title = 'RESULT:' + JSON.stringify({ ok: false, error: 'missing elements', portal: host?.classList?.contains('is-portal') });
    return;
  }
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  };
  const hitButton = (el, pt) => {
    const target = document.elementFromPoint(pt.x, pt.y);
    return !!(target && (target === el || el.contains(target) || target.contains(el)));
  };
  const sendPt = center(send);
  const chipPt = center(chip);
  const menuPt = center(menu);
  const hitsSend = hitButton(send, sendPt);
  const hitsChip = hitButton(chip, chipPt);
  const hitsMenu = hitButton(menu, menuPt);
  const input = document.querySelector('.aos-input');
  input.value = 'ping-send';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  send.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: sendPt.x, clientY: sendPt.y, pointerType: 'touch', button: 0, pointerId: 7,
  }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sent = document.body.innerText.includes('ping-send');
  const down = new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: chipPt.x, clientY: chipPt.y, pointerType: 'touch', button: 0, pointerId: 1,
  });
  chip.dispatchEvent(down);
  const stillChip = document.elementFromPoint(chipPt.x, chipPt.y);
  chip.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, clientX: chipPt.x, clientY: chipPt.y, pointerType: 'touch', button: 0, pointerId: 1,
  }));
  const releaseTarget = document.elementFromPoint(chipPt.x, chipPt.y);
  releaseTarget?.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, clientX: chipPt.x, clientY: chipPt.y,
  }));
  const sheet = document.querySelector('.aos-sheet');
  const sheetRect = sheet?.getBoundingClientRect();
  const sheetAbove = !!(sheetRect && sheetRect.bottom <= chipPt.y + 2);
  const sheetStays = sheet && !sheet.hidden && sheetAbove;
  document.title = 'RESULT:' + JSON.stringify({
    ok: hitsSend && hitsChip && hitsMenu && sheetStays && sent,
    sent,
    portal: host.classList.contains('is-portal'),
    parentIsBody: host.parentElement === document.body,
    zIndex: getComputedStyle(host).zIndex,
    hitsSend,
    hitsChip,
    hitsMenu,
    sendPt,
    chipPt,
    menuPt,
    sendTarget: document.elementFromPoint(sendPt.x, sendPt.y)?.className,
    chipTarget: document.elementFromPoint(chipPt.x, chipPt.y)?.className,
    plusTarget: document.elementFromPoint(menuPt.x, menuPt.y)?.className,
    sheetHidden: sheet?.hidden ?? null,
    sheetAbove,
    sheetTop: sheetRect ? Math.round(sheetRect.top) : null,
    releaseTarget: releaseTarget?.className || null,
  });
}
requestAnimationFrame(() => setTimeout(() => { runHitTest(); }, 400));
</script></body></html>`
);

const shot = spawnSync(
  chrome,
  [
    '--headless=new',
    '--window-size=393,852',
    '--force-device-scale-factor=1',
    '--disable-gpu',
    '--virtual-time-budget=8000',
    '--dump-dom',
    `file://${runnerPath}`,
  ],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
);

if (shot.status !== 0) {
  console.error(shot.stderr?.slice(0, 800));
  throw new Error('Chrome failed to load hit-test page');
}

const titleMatch = (shot.stdout || '').match(/<title>RESULT:(\{[^<]+\})<\/title>/);
if (!titleMatch) {
  console.error('Could not read hit-test result (title still pending?)');
  console.error(shot.stdout?.slice(0, 400));
  process.exit(1);
}
const payload = JSON.parse(titleMatch[1]);
console.log('hit-test', payload);
if (!payload.ok) process.exit(1);
