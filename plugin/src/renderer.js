/**
 * Message block renderer — pure HTML string builder for tests + plugin.
 * Quiet mode suppresses thought blocks.
 */
import { parseFences } from './protocol-bridge.js';

/**
 * @param {string} agentText
 * @param {{ quiet?: boolean }} [opts]
 * @returns {{ html: string, blocks: import('../../packages/protocol/src/fence.js').Block[] }}
 */
export function renderAgentMessage(agentText, opts = {}) {
  let blocks = parseFences(agentText);
  if (opts.quiet) {
    blocks = blocks.filter((b) => b.type !== 'thought');
  }

  const parts = blocks.map((b) => {
    switch (b.type) {
      case 'thought':
        return `<details class="me-soul-thought" open><summary>思绪</summary><div class="me-soul-thought-body">${escapeHtml(b.content)}</div></details>`;
      case 'confirm':
        return renderConfirmCard(b);
      case 'tool':
        return `<details class="me-soul-tool"><summary>🔧 ${escapeHtml(b.meta?.name || 'tool')}</summary><pre>${escapeHtml(b.content)}</pre></details>`;
      case 'attachment':
        return `<div class="me-soul-attachment" data-path="${escapeHtml(b.meta?.path || '')}">📎 ${escapeHtml(b.meta?.path || b.content)}</div>`;
      case 'text':
      default:
        return `<div class="me-soul-text">${escapeHtml(b.content)}</div>`;
    }
  });

  return { html: parts.join('\n'), blocks };
}

/**
 * @param {import('../../packages/protocol/src/fence.js').Block} b
 */
function renderConfirmCard(b) {
  const title = b.meta?.title || 'Confirm';
  const path = b.meta?.path || b.attrs?.path || '';
  const body = b.meta?.body || b.content;
  const actions = (b.meta?.actions || ['accept', 'reject']).join(',');
  const ctype = b.attrs?.type || b.meta?.type || '';
  return [
    `<div class="me-soul-confirm" data-path="${escapeHtml(path)}" data-type="${escapeHtml(ctype)}" data-actions="${escapeHtml(actions)}">`,
    `<div class="me-soul-confirm-title">${escapeHtml(title)}</div>`,
    `<div class="me-soul-confirm-body">${escapeHtml(body)}</div>`,
    `<div class="me-soul-confirm-actions">`,
    `<button data-action="accept">Accept</button>`,
    `<button data-action="reject">Reject</button>`,
    `</div></div>`,
  ].join('');
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * List skills for `/` menu from skill ids.
 * @param {string[]} skillIds
 */
export function formatSkillMenu(skillIds) {
  return (skillIds || []).map((id) => ({ id, label: `/${id}` }));
}

/**
 * Build user message with @ references.
 * @param {string} text
 * @param {{ path: string, excerpt?: string }[]} refs
 */
export function composeWithRefs(text, refs = []) {
  if (!refs.length) return text;
  const chips = refs.map((r) => `@${r.path}`).join(' ');
  const bodies = refs
    .map((r) => `---\n# Ref: ${r.path}\n\n${r.excerpt || '(path only)'}\n`)
    .join('\n');
  return `${chips}\n\n${text}\n\n## Attached context\n\n${bodies}`;
}
