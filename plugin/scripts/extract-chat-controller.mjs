/**
 * One-off: build kernel/chat-controller.js body from ui/app-view.js session engine.
 * Run: node scripts/extract-chat-controller.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appView = fs.readFileSync(path.join(__dirname, '../src/ui/app-view.js'), 'utf8');

const header = `/**
 * Plugin-level chat session controller (fullscreen + companion share one queue).
 * Generated/extracted from app-view session engine — edit here for shared turn logic.
 */
import { buildTurnPrompt, loadSoulPack } from '../memory/inject.js';
import { recallMemory } from '../memory/index-ops.js';
import { scheduleFormationAfterTurn } from '../memory/turn-memory.js';
import { historyToTurns, mergeTranscript, newMessageId } from '../ui/turns.js';
import { newIdempotencyKey } from './transport.js';
import { isTransportNoise } from './session-store.js';
import { createOutboxRunner, isRetryable } from './outbox-runner.js';
import { serviceMessagesFromPayload, serviceSessionsFromPayload } from './service-payload.js';
import { isUserSession, sessionKey, sessionLabel } from '../ui/sidebar.js';
import { nextStepFor, phaseLabel } from '../ui/turn-phase.js';
import { choosePack, isCompletePack, withDeadline, PREP_TIMEOUT_MS } from '../ui/send-prep.js';
import { AOS_BUILD } from '../ui/build-id.js';
import { chooseSession, isEphemeralLocalKey } from './chat-session-sync.js';
import { formatSnapshotForPrompt } from '../context-snapshot.js';

/**
 * @param {any} plugin
 * @param {import('obsidian').App} app
 * @param {{ Notice?: any }} hooks
 */
export function createChatController(plugin, app, hooks = {}) {
  const deps = { Notice: hooks.Notice };
  const listeners = new Set();
  const viewHooks = [];

  function emit() {
    for (const fn of listeners) fn();
  }

  function emitThread() {
    for (const h of viewHooks) h.onThread?.();
  }

  const state = {
    sessions: [],
    activeKey: '',
    messages: [],
    busy: false,
    startedAt: 0,
    progressLabel: '思考中',
    syncHint: '',
    sessionsLoading: false,
    saveError: '',
    serviceError: '',
    stage: { build: AOS_BUILD, savedAt: 0, prep: '', receipt: '', poll: '' },
  };

  let sessionRestored = false;
  let soulCache = null;
  const prepTokens = new Map();
  const livePolls = new Set();
  let resumingTurns = false;

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function attachView(hooks) {
    viewHooks.push(hooks);
    return () => {
      const i = viewHooks.indexOf(hooks);
      if (i >= 0) viewHooks.splice(i, 1);
    };
  }

  function getState() {
    return state;
  }

`;

const footer = `
  return {
    state,
    getState,
    subscribe,
    attachView,
    loadLocalCache,
    persistLocal,
    send,
    abort,
    openSession,
    removeSession,
    newSession,
    refreshSessions,
    flushOutbox,
    recoverFromBackground,
    pendingAction,
    regenerate,
    connectionState,
    entryMode,
    isLive,
    sessionCache,
    explainSendError,
    applyTurnStatus,
    continueRecent,
  };
}
`;

// Functions to extract from app-view (between mountAgentApp internals)
const names = [
  'sessionCache',
  'persistLocal',
  'hydratePending',
  'sessionHasLocalContent',
  'loadLocalCache',
  'settleLoaded',
  'connectionState',
  'isLive',
  'entryMode',
  'isForeground',
  'explainSendError',
  'fetchSessions',
  'fetchHistory',
  'serviceMessageToRow',
  'refreshSessions',
  'openSession',
  'removeSession',
  'newSession',
  'continueRecent',
  'readRel',
  'readPack',
  'onTurnSent',
  'continuePrep',
  'send',
  'restartPrep',
  'draftFor',
  'saveSessionTranscript',
  'deliverTurnViaGateway',
  'deliverTurnViaService',
  'paintWait',
  'deliverTurn',
  'applyTurnStatus',
  'flushOutbox',
  'pendingAction',
  'regenerate',
  'abort',
  'showDiagnosis',
  'checkService',
  'recoverFromBackground',
  'resumePendingTurns',
  'resumePendingTurnsInner',
  'resumeSessionTurns',
];

function extractFunction(src, name) {
  const re = new RegExp(`\\n  (async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n  }(?=\\n  (async )?function |\\n  const outbox|\\n  if \\(deps\\.preview\\))`);
  const m = src.match(re);
  if (!m) {
    console.error('Missing', name);
    return '';
  }
  let body = m[0];
  body = body.replace(/\bpaintChrome\(\)/g, 'emit()');
  body = body.replace(/\bpaintThread\(\)/g, 'emitThread()');
  body = body.replace(/\bcomposer\.focus\(\)/g, 'viewHooks.forEach((h) => h.onComposerFocus?.())');
  body = body.replace(/if \(mobile\) state\.sidebarOpen = false;/g, 'viewHooks.forEach((h) => h.onCloseSidebar?.())');
  return body;
}

let body = '';
for (const name of names) {
  body += extractFunction(appView, name);
  body += '\n';
}

// Extract outbox block
const outboxMatch = appView.match(/\n  const outbox = createOutboxRunner\([\s\S]*?\n  }\);\n/);
if (outboxMatch) {
  let ob = outboxMatch[0];
  ob = ob.replace(/\bpaintThread\(\)/g, 'emitThread()');
  ob = ob.replace(/\bpaintChrome\(\)/g, 'emit()');
  ob = ob.replace(/deps\.Notice/g, 'deps.Notice');
  body += ob;
}

const out = header + body + footer;
fs.writeFileSync(path.join(__dirname, '../src/kernel/chat-controller.js'), out);
console.log('Wrote chat-controller.js', out.length, 'bytes');

NODE