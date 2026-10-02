/**
 * Browser entry for the phone preview. Mocks the Obsidian element helpers.
 */
import { mountAgentApp } from '../src/ui/app-view.js';
import { previewMessages, previewNow, previewSessions, previewSkills } from '../tests/fixtures/mobile-preview-state.js';

function enhance(el) {
  if (!el || el.__aos) return el;
  el.__aos = true;
  el.createDiv = (opts) => make('div', opts, el);
  el.createEl = (tag, opts) => make(tag, opts, el);
  el.createSpan = (opts) => make('span', opts, el);
  el.empty = () => {
    el.replaceChildren();
  };
  el.addClass = (name) => el.classList.add(name);
  el.removeClass = (name) => el.classList.remove(name);
  el.toggleClass = (name, on) => el.classList.toggle(name, on);
  el.hasClass = (name) => el.classList.contains(name);
  el.setText = (text) => {
    el.textContent = text ?? '';
  };
  el.setAttr = (key, value) => el.setAttribute(key, value);
  return el;
}

function make(tag, opts, parent) {
  const el = enhance(document.createElement(tag));
  if (opts?.cls) el.className = opts.cls;
  if (opts?.text != null) el.textContent = opts.text;
  if (opts?.attr) {
    for (const [key, value] of Object.entries(opts.attr)) el.setAttribute(key, value);
  }
  parent?.appendChild(el);
  return el;
}

function miniMarkdown(markdown) {
  const escaped = String(markdown)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n\n/)
    .map((block) => {
      if (block.startsWith('|')) {
        const rows = block.split('\n').filter((row) => !/^\|\s*-+/.test(row.trim()));
        const cells = rows.map(
          (row) => `<tr>${row.split('|').filter((cell) => cell.trim()).map((cell) => `<td>${cell.trim()}</td>`).join('')}</tr>`
        );
        return `<table>${cells.join('')}</table>`;
      }
      if (block.startsWith('```')) {
        const code = block.replace(/^```.*\n?/, '').replace(/```$/, '');
        return `<pre><code>${code}</code></pre>`;
      }
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function fakePlugin(mode) {
  const live = mode !== 'offline' && mode !== 'pairing';
  return {
    settings: {
      agentName: 'Agent',
      agentId: 'main',
      quiet: false,
      skills: previewSkills.map((skill) => skill.id),
      hideMobileNavbar: (() => {
        const q = new URLSearchParams(
          location.hash.includes('&') ? location.hash.slice(location.hash.indexOf('&') + 1) : location.search.slice(1)
        );
        return q.get('hideNav') === '1';
      })(),
    },
    kernelModels: [{ id: 'default', name: 'Default' }],
    thinkingChoices: () => [
      { id: 'off', label: '关闭' },
      { id: 'low', label: '低' },
      { id: 'high', label: '高' },
    ],
    resolveOutgoingThinking: () => 'off',
    connectionPrefs: () => ({ model: 'default' }),
    ensureOperator: async () => null,
    takeChatLaunch: () => null,
    sessionStore: () => memorySessionStore,
    operator: {
      status: {
        state: mode === 'pairing' ? 'pairing' : live ? 'live' : 'offline',
        message: mode === 'pairing' ? '在运行插件的电脑上批准这台设备' : live ? '已连接' : '网关不在线',
        approveCommand: mode === 'pairing' ? 'openclaw devices approve demo' : '',
      },
      onStatus: () => () => {},
      prompt: async () => ({ runId: 'preview' }),
    },
  };
}

const memorySessionStore = (() => {
  const pending = {};
  const transcripts = {};
  return {
    loadTranscript: (key) => transcripts[key] || [],
    saveTranscript(key, rows) {
      transcripts[key] = rows;
    },
    saveSessions() {},
    saveActiveKey() {},
    loadSessions: () => [],
    loadActiveKey: () => '',
    listPending: (key) => Object.values(pending).filter((row) => !key || row.sessionKey === key),
    pendingFor: (id) => pending[id] || null,
    activePending(key) {
      return this.listPending(key).filter((row) => row.status !== 'sent');
    },
    saveTurnWithPending(sessionKey, messages, record) {
      pending[record.turnId] = { status: 'queued', attempts: 0, ...record, sessionKey };
      transcripts[sessionKey] = messages;
      return { ok: true, record: pending[record.turnId] };
    },
    markSending(id) {
      if (pending[id]) pending[id].status = 'sending';
      return { ok: true };
    },
    markSent(id) {
      if (pending[id]) pending[id].status = 'sent';
      return { ok: true };
    },
    markUnknown(id) {
      if (pending[id]) pending[id].status = 'unknown';
      return { ok: true };
    },
    markFailed(id, reason) {
      if (pending[id]) {
        pending[id].status = 'failed';
        pending[id].reason = reason || '';
      }
      return { ok: true };
    },
    markPending(id, patch) {
      if (pending[id]) Object.assign(pending[id], patch || {});
      return pending[id] || null;
    },
    markQueuedForRetry(id) {
      if (pending[id]) pending[id].status = 'queued';
      return { ok: true };
    },
    dropTurn(id) {
      delete pending[id];
      return { ok: true };
    },
  };
})();

const mode = (location.hash || '#thread').slice(1).split('&')[0] || 'thread';
const theme = new URLSearchParams(location.hash.slice(1).includes('&') ? location.hash.slice(location.hash.indexOf('&') + 1) : location.search).get('theme');
document.body.classList.add('is-mobile', 'is-phone', theme === 'light' ? 'theme-light' : 'theme-dark');

const host = enhance(document.getElementById('app'));
const plugin = fakePlugin(mode);
const which = mode === 'tools' ? 'tools' : mode === 'empty' || mode === 'offline' || mode === 'pairing' || mode === 'drawer' ? 'empty' : 'thread';

mountAgentApp(host, {
  app: { isMobile: true, vault: { getAbstractFileByPath: () => null } },
  plugin,
  mode: 'fullscreen',
  preview: {
    sessions: previewSessions,
    messages: mode === 'history' ? previewMessages('thread') : previewMessages(which),
    activeKey: 'agent:main:main',
    drawer: mode === 'drawer',
    keyboard: mode === 'keyboard' ? '280px' : '',
    now: previewNow,
  },
  MarkdownRenderer: {
    render: async (_app, markdown, el) => {
      el.innerHTML = miniMarkdown(markdown);
    },
  },
  Notice: (message) => {
    document.body.dataset.notice = String(message || '');
  },
});
