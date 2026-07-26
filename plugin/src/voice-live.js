/**
 * Agent Live voice shell (MVP):
 * viewport border while listening → polish → hand off to IDE command bar (text reply).
 * No interim transcript UI; no TTS / full-duplex yet.
 */

import { VoiceInputSession, resolveXaiApiKey } from './voice-stt.js';
import { polishDictation } from './voice-polish.js';

/** @typedef {'idle' | 'listening' | 'handing_off' | 'thinking'} LiveState */

/**
 * Pure state transitions for tests / UI class mapping.
 * @param {LiveState} state
 * @param {'start' | 'stop' | 'cancel' | 'busy' | 'idle' | 'empty'} event
 * @returns {LiveState}
 */
export function nextLiveState(state, event) {
  switch (event) {
    case 'start':
      return state === 'listening' || state === 'handing_off' ? state : 'listening';
    case 'stop':
      return state === 'listening' ? 'handing_off' : state;
    case 'cancel':
    case 'empty':
      return 'idle';
    case 'busy':
      return 'thinking';
    case 'idle':
      return 'idle';
    default:
      return state;
  }
}

/**
 * Options passed to commandBar.open after successful dictation.
 * @param {{ text: string, cmdbarOpen: boolean }} opts
 */
export function buildHandoffOpenOpts(opts) {
  const text = String(opts?.text || '').trim();
  return {
    seedText: text,
    autoSubmit: true,
    keepHistory: !!opts?.cmdbarOpen,
    forceOpen: true,
  };
}

/**
 * Map live state → CSS modifier classes on the overlay root.
 * @param {LiveState} state
 */
export function liveStateClasses(state) {
  return {
    'is-listening': state === 'listening',
    'is-handing-off': state === 'handing_off',
    'is-thinking': state === 'thinking',
  };
}

/**
 * @param {import('obsidian').App} _app
 * @param {any} plugin
 * @param {{
 *   Notice: any,
 *   getCommandBar: () => {
 *     open: (opts?: object) => void,
 *     isOpen: () => boolean,
 *     isBusy?: () => boolean,
 *     onBusyChange?: (fn: ((busy: boolean) => void) | null) => void,
 *   } | null | undefined,
 * }} deps
 */
export function createVoiceLiveController(_app, plugin, deps) {
  const { Notice, getCommandBar } = deps;

  /** @type {HTMLElement | null} */
  let root = null;
  /** @type {VoiceInputSession | null} */
  let session = null;
  /** @type {LiveState} */
  let state = 'idle';
  /** @type {(() => void) | null} */
  let removeEsc = null;
  let handoffToken = 0;

  function notify(msg) {
    try {
      new Notice(msg);
    } catch {
      /* */
    }
  }

  function ensureDom() {
    if (root && document.body.contains(root)) return root;
    root = document.createElement('div');
    root.className = 'me-soul-live-root';
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('data-me-soul-live', '1');
    const frame = document.createElement('div');
    frame.className = 'me-soul-live-frame';
    root.appendChild(frame);
    document.body.appendChild(root);
    return root;
  }

  /**
   * @param {LiveState} next
   */
  function setState(next) {
    state = next;
    const el = ensureDom();
    const classes = liveStateClasses(next);
    for (const [cls, on] of Object.entries(classes)) {
      el.classList.toggle(cls, on);
    }
    const active = next !== 'idle';
    el.style.display = active ? 'block' : '';
    el.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function attachEsc() {
    detachEsc();
    const onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      if (state !== 'listening') return;
      ev.preventDefault();
      ev.stopPropagation();
      cancel();
      notify('已取消 Live 语音');
    };
    document.addEventListener('keydown', onKey, true);
    removeEsc = () => document.removeEventListener('keydown', onKey, true);
  }

  function detachEsc() {
    if (removeEsc) {
      removeEsc();
      removeEsc = null;
    }
  }

  function syncBusyListener() {
    const cmd = getCommandBar?.();
    if (!cmd?.onBusyChange) return;
    cmd.onBusyChange((busy) => {
      if (busy) {
        if (state === 'handing_off' || state === 'thinking' || state === 'idle') {
          setState(nextLiveState(state, 'busy'));
        }
        return;
      }
      // Reply finished — drop border unless still listening
      if (state === 'thinking' || state === 'handing_off') {
        setState('idle');
      }
    });
  }

  async function startListening() {
    const cmd = getCommandBar?.();
    if (cmd?.isBusy?.()) {
      notify('Agent 正在回复，稍后再说');
      return;
    }
    if (state === 'listening' || state === 'handing_off') return;

    if (plugin.settings.voiceEnabled === false) {
      notify('语音输入已关闭（设置里可开启）');
      return;
    }
    const apiKey = resolveXaiApiKey(plugin.settings);
    if (!apiKey) {
      notify('未找到 xAI API Key：在设置填写，或配置环境变量 XAI_API_KEY');
      return;
    }

    const next = new VoiceInputSession({
      apiKey,
      language: plugin.settings.voiceLanguage || '',
      // Intentionally no onPartial → UI: no interim transcript
      onError: (err) => {
        notify(err?.message || String(err));
      },
    });
    session = next;
    setState('listening');
    attachEsc();
    try {
      await next.start();
    } catch (e) {
      session = null;
      setState('idle');
      detachEsc();
      notify(e?.message || String(e));
    }
  }

  async function stopAndHandoff() {
    if (!session || state !== 'listening') {
      setState('idle');
      return;
    }
    const current = session;
    session = null;
    detachEsc();
    setState('handing_off');
    const token = ++handoffToken;

    try {
      const raw = await current.stop();
      if (token !== handoffToken) return;
      if (!raw || !String(raw).trim()) {
        notify('没有识别到语音');
        setState('idle');
        return;
      }

      const polished = await polishDictation(raw, {
        apiKey: resolveXaiApiKey(plugin.settings),
        model: plugin.settings.voicePolishModel || 'grok-3-mini',
      });
      if (token !== handoffToken) return;

      const text = String(polished || raw).trim();
      if (!text) {
        notify('没有识别到语音');
        setState('idle');
        return;
      }

      const cmd = getCommandBar?.();
      if (!cmd?.open) {
        notify('命令条不可用');
        setState('idle');
        return;
      }

      const openOpts = buildHandoffOpenOpts({
        text,
        cmdbarOpen: !!cmd.isOpen?.(),
      });
      cmd.open(openOpts);
      // If submit did not flip busy (e.g. empty after race), clear shell
      if (!cmd.isBusy?.()) {
        setState('idle');
      }
    } catch (e) {
      if (token === handoffToken) {
        notify(e?.message || String(e));
        setState('idle');
      }
    }
  }

  function cancel() {
    handoffToken += 1;
    if (session) {
      try {
        session.cancel();
      } catch {
        /* */
      }
      session = null;
    }
    detachEsc();
    setState('idle');
  }

  function toggle() {
    if (state === 'listening') {
      void stopAndHandoff();
      return;
    }
    if (state === 'handing_off') {
      notify('正在交接，请稍候');
      return;
    }
    void startListening();
  }

  function destroy() {
    cancel();
    const cmd = getCommandBar?.();
    cmd?.onBusyChange?.(null);
    if (root) {
      root.remove();
      root = null;
    }
  }

  // Wire busy sync once command bar exists
  syncBusyListener();

  return {
    toggle,
    startListening,
    stopAndHandoff,
    cancel,
    destroy,
    getState: () => state,
    /** @internal test/helper */
    _setState: setState,
  };
}
