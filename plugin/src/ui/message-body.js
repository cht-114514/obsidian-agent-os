/**
 * Render one assistant message: markdown for prose, cards for protocol fences.
 */
import { parseFences } from '../protocol-bridge.js';
import { escapeHtml } from '../renderer.js';

function confirmHtml(block) {
  const title = block.meta?.title || 'Confirm';
  const path = block.meta?.path || block.attrs?.path || '';
  const body = block.meta?.body || block.content || '';
  const actions = (block.meta?.actions || ['accept', 'reject']).join(',');
  const ctype = block.attrs?.type || block.meta?.type || '';
  return [
    `<div class="me-soul-confirm" data-path="${escapeHtml(path)}" data-type="${escapeHtml(ctype)}" data-actions="${escapeHtml(actions)}">`,
    `<div class="me-soul-confirm-title">${escapeHtml(title)}</div>`,
    `<div class="me-soul-confirm-body">${escapeHtml(body)}</div>`,
    `<div class="me-soul-confirm-actions">`,
    `<button type="button" data-action="accept">接受</button>`,
    `<button type="button" data-action="reject">拒绝</button>`,
    `</div></div>`,
  ].join('');
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 * @param {{
 *   quiet?: boolean,
 *   isCurrent?: () => boolean,
 *   renderMarkdown?: (el: HTMLElement, markdown: string) => Promise<void>|void,
 *   onConfirm?: (card: HTMLElement, action: string) => void,
 * }} opts
 */
export async function renderMessageBody(host, text, opts = {}) {
  const current = opts.isCurrent || (() => true);
  if (!current()) return;
  host.empty();
  const blocks = parseFences(String(text || ''));
  for (const block of blocks) {
    if (!current()) return;
    if (block.type === 'thought') {
      if (opts.quiet) continue;
      const details = host.createEl('details', { cls: 'me-soul-thought' });
      details.createEl('summary', { text: '思绪' });
      details.createDiv({ cls: 'me-soul-thought-body', text: block.content || '' });
      continue;
    }
    if (block.type === 'confirm') {
      const wrap = host.createDiv({ cls: 'aos-confirm-wrap' });
      wrap.innerHTML = confirmHtml(block);
      const card = wrap.querySelector('.me-soul-confirm');
      card?.querySelector('[data-action="accept"]')?.addEventListener('click', () => {
        opts.onConfirm?.(card, 'accept');
      });
      card?.querySelector('[data-action="reject"]')?.addEventListener('click', () => {
        opts.onConfirm?.(card, 'reject');
      });
      continue;
    }
    if (block.type === 'tool') {
      const details = host.createEl('details', { cls: 'me-soul-tool' });
      details.createEl('summary', { text: block.meta?.name || block.attrs?.name || 'tool' });
      details.createEl('pre', { text: block.content || '' });
      continue;
    }
    if (block.type === 'attachment') {
      const path = block.meta?.path || block.attrs?.path || block.content || '';
      host.createDiv({ cls: 'me-soul-attachment', text: path });
      continue;
    }
    const el = host.createDiv({ cls: 'me-soul-text aos-md' });
    const markdown = block.content || '';
    if (!markdown.trim()) continue;
    if (opts.renderMarkdown) {
      await opts.renderMarkdown(el, markdown);
      if (!current()) return;
    } else {
      el.setText(markdown);
    }
  }
}
