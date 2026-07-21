/**
 * xAI Speech-to-Text for composer voice input.
 * - Streaming: wss://api.x.ai/v1/stt via Node `ws` (needs Authorization header)
 * - Fallback: REST POST /v1/stt with in-memory WAV
 *
 * Key resolution: settings → XAI_API_KEY → OpenClaw openclaw.json → ~/.grok/auth.json
 */

const STT_REST = 'https://api.x.ai/v1/stt';
const STT_WS = 'wss://api.x.ai/v1/stt';

/** @returns {any} */
function nodeRequire() {
  return (
    (typeof require === 'function' && require) ||
    (typeof window !== 'undefined' && window.require) ||
    (typeof globalThis !== 'undefined' && globalThis.require) ||
    null
  );
}

/**
 * @returns {string}
 */
export function resolveXaiApiKey(settings = {}) {
  const fromSettings = String(settings.xaiApiKey || '').trim();
  if (fromSettings) return fromSettings;

  try {
    if (typeof process !== 'undefined' && process.env?.XAI_API_KEY) {
      return String(process.env.XAI_API_KEY).trim();
    }
  } catch {
    /* ignore */
  }

  const req = nodeRequire();
  if (!req) return '';

  try {
    const fs = req('fs');
    const path = req('path');
    const os = req('os');
    const home = os.homedir();

    // OpenClaw config (static apiKey if present)
    const ocPath = path.join(home, '.openclaw', 'openclaw.json');
    if (fs.existsSync(ocPath)) {
      const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
      const xai = oc?.models?.providers?.xai || oc?.providers?.xai || {};
      const k =
        xai.apiKey ||
        xai.api_key ||
        xai.key ||
        oc?.env?.XAI_API_KEY ||
        oc?.skills?.entries?.['xai']?.apiKey;
      if (k && String(k).trim()) return String(k).trim();
    }

    // OpenClaw OAuth profile (xai:email → access JWT) in agent sqlite
    try {
      const Database = req('better-sqlite3');
      const dbPath = path.join(
        home,
        '.openclaw',
        'agents',
        'main',
        'agent',
        'openclaw-agent.sqlite'
      );
      if (fs.existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = db
          .prepare('SELECT store_json FROM auth_profile_store WHERE store_key = ?')
          .get('primary');
        db.close();
        if (row?.store_json) {
          const store = JSON.parse(row.store_json);
          const profiles = store?.profiles || {};
          for (const [id, prof] of Object.entries(profiles)) {
            if (String(id).startsWith('xai:') && prof?.access) {
              return String(prof.access).trim();
            }
            if (prof?.provider === 'xai' && prof?.access) {
              return String(prof.access).trim();
            }
          }
        }
      }
    } catch {
      // better-sqlite3 may be unavailable; fall through to JSON parse via child
    }

    // Fallback: shell-out python/sqlite3 CLI (no native dep)
    try {
      const { execFileSync } = req('child_process');
      const dbPath = path.join(
        home,
        '.openclaw',
        'agents',
        'main',
        'agent',
        'openclaw-agent.sqlite'
      );
      if (fs.existsSync(dbPath)) {
        const out = execFileSync(
          'sqlite3',
          [dbPath, "SELECT store_json FROM auth_profile_store WHERE store_key='primary';"],
          { encoding: 'utf8', timeout: 2000 }
        );
        const store = JSON.parse(out.trim() || '{}');
        for (const [id, prof] of Object.entries(store?.profiles || {})) {
          if ((String(id).startsWith('xai:') || prof?.provider === 'xai') && prof?.access) {
            return String(prof.access).trim();
          }
        }
      }
    } catch {
      /* ignore */
    }

    // Grok desktop OIDC access token (may work as Bearer for some endpoints)
    const authPath = path.join(home, '.grok', 'auth.json');
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      for (const v of Object.values(auth || {})) {
        if (v && typeof v === 'object' && v.key && String(v.key).length > 12) {
          return String(v.key).trim();
        }
      }
    }
  } catch (e) {
    console.warn('resolveXaiApiKey failed', e);
  }
  return '';
}

/**
 * Downsample Float32 mono to target rate.
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 */
export function downsampleBuffer(input, fromRate, toRate) {
  if (toRate === fromRate) return input;
  const ratio = fromRate / toRate;
  const newLen = Math.floor(input.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const idx = Math.floor(i * ratio);
    result[i] = input[idx];
  }
  return result;
}

/**
 * @param {Float32Array} float32
 * @returns {Int16Array}
 */
export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * @param {Int16Array} samples
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }
  return buffer;
}

/**
 * REST transcription of a Blob/ArrayBuffer.
 * @param {{ apiKey: string, body: Blob | ArrayBuffer, filename?: string, language?: string }} opts
 */
export async function transcribeRest(opts) {
  const { apiKey, language } = opts;
  if (!apiKey) throw new Error('缺少 xAI API Key');
  const form = new FormData();
  if (language) {
    form.append('language', language);
    form.append('format', 'true');
  }
  const blob =
    opts.body instanceof Blob
      ? opts.body
      : new Blob([opts.body], { type: 'audio/wav' });
  form.append('file', blob, opts.filename || 'audio.wav');

  const res = await fetch(STT_REST, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`STT 响应非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(`STT 失败：${msg}`);
  }
  return String(data.text || data.transcript || '').trim();
}

/**
 * Join transcript segments with language-aware spacing.
 * CJK/CJK-adjacent: no space; Latin/latin-adjacent: single space.
 * @param {string} a
 * @param {string} b
 */
export function joinSegments(a, b) {
  const left = String(a || '').trimEnd();
  const right = String(b || '').trimStart();
  if (!left) return right;
  if (!right) return left;
  const leftEnd = left[left.length - 1];
  const rightStart = right[0];
  // CJK Unified Ideographs + common CJK punctuation / kana / hangul ranges
  const cjk = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;
  if (cjk.test(leftEnd) || cjk.test(rightStart)) {
    return left + right;
  }
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
  return `${left} ${right}`;
}

/**
 * @typedef {{ committed: string, interim: string }} TranscriptState
 */

/**
 * Pure accumulator for xAI streaming STT events.
 * - interim (is_final=false): replace interim only
 * - chunk/utterance final (is_final or speech_final): append to committed, clear interim
 * @param {TranscriptState} state
 * @param {{ text?: string, is_final?: boolean, speech_final?: boolean, type?: string }} event
 * @returns {{ state: TranscriptState, display: string }}
 */
export function accumulateTranscript(state, event) {
  const prev = {
    committed: String(state?.committed || ''),
    interim: String(state?.interim || ''),
  };
  const text = String(event?.text || '').trim();
  const type = event?.type || 'transcript.partial';

  if (type === 'transcript.done') {
    const finalText = text || joinSegments(prev.committed, prev.interim);
    const next = { committed: finalText, interim: '' };
    return { state: next, display: finalText };
  }

  // partial / unknown treated as partial
  if (!text) {
    return {
      state: prev,
      display: joinSegments(prev.committed, prev.interim),
    };
  }

  const isFinal = !!(event.is_final || event.speech_final);
  let next;
  if (isFinal) {
    next = {
      committed: joinSegments(prev.committed, text),
      interim: '',
    };
  } else {
    next = {
      committed: prev.committed,
      interim: text,
    };
  }
  return {
    state: next,
    display: joinSegments(next.committed, next.interim),
  };
}

/**
 * Display string from accumulator state.
 * @param {TranscriptState} state
 */
export function displayTranscript(state) {
  return joinSegments(state?.committed || '', state?.interim || '');
}

/**
 * Click-to-talk / PTT session: capture mic → stream PCM to xAI (or buffer for REST).
 * Streaming finals are *accumulated* so long dictation keeps earlier chunks.
 */
export class VoiceInputSession {
  /**
   * @param {{
   *   apiKey: string,
   *   language?: string,
   *   onPartial?: (text: string, meta: { isFinal: boolean, speechFinal: boolean }) => void,
   *   onFinal?: (text: string) => void,
   *   onStatus?: (s: string) => void,
   *   onError?: (err: Error) => void,
   * }} opts
   */
  constructor(opts) {
    this.apiKey = opts.apiKey;
    this.language = opts.language || '';
    this.onPartial = opts.onPartial;
    this.onFinal = opts.onFinal;
    this.onStatus = opts.onStatus;
    this.onError = opts.onError;
    this._stream = null;
    this._ctx = null;
    this._processor = null;
    this._source = null;
    this._ws = null;
    this._mode = null; // 'ws' | 'rest'
    /** @type {Int16Array[]} */
    this._restChunks = [];
    /** @type {TranscriptState} */
    this._tx = { committed: '', interim: '' };
    this._closed = false;
  }

  /** @returns {string} */
  get _utterance() {
    return displayTranscript(this._tx);
  }

  async start() {
    if (!this.apiKey) throw new Error('缺少 xAI API Key（设置里填写，或配置 XAI_API_KEY / OpenClaw）');
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error('当前环境无法访问麦克风');
    }

    this.onStatus?.('请求麦克风…');
    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      },
      video: false,
    });

    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ctx.state === 'suspended') await this._ctx.resume();
    this._source = this._ctx.createMediaStreamSource(this._stream);
    // ScriptProcessor: widely available in Electron
    const bufferSize = 4096;
    this._processor = this._ctx.createScriptProcessor(bufferSize, 1, 1);
    const inputRate = this._ctx.sampleRate;
    const targetRate = 16000;

    const started = await this._tryStartWebSocket();
    this._mode = started ? 'ws' : 'rest';
    this.onStatus?.(this._mode === 'ws' ? '聆听中（流式）…' : '聆听中…');

    this._processor.onaudioprocess = (ev) => {
      if (this._closed) return;
      const input = ev.inputBuffer.getChannelData(0);
      const down = downsampleBuffer(input, inputRate, targetRate);
      const pcm = floatTo16BitPCM(down);
      if (this._mode === 'ws' && this._ws && this._ws.readyState === 1) {
        try {
          this._ws.send(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
        } catch (e) {
          console.warn('ws send', e);
        }
      } else {
        this._restChunks.push(pcm);
      }
    };

    this._source.connect(this._processor);
    this._processor.connect(this._ctx.destination);
  }

  /**
   * @returns {Promise<boolean>}
   */
  async _tryStartWebSocket() {
    let WebSocketImpl;
    try {
      // Bundled by esbuild when available; avoids bare require('ws') at runtime
      const mod = await import('ws');
      WebSocketImpl = mod.default || mod.WebSocket || mod;
    } catch {
      try {
        const req = nodeRequire();
        WebSocketImpl = req?.('ws');
      } catch {
        return false;
      }
    }
    if (!WebSocketImpl) return false;

    const params = new URLSearchParams({
      sample_rate: '16000',
      encoding: 'pcm',
      interim_results: 'true',
      // Slightly more conservative end-of-turn for dictation (fewer false cuts)
      smart_turn: '0.75',
      smart_turn_timeout: '3500',
    });
    if (this.language) params.set('language', this.language);

    const url = `${STT_WS}?${params.toString()}`;
    return new Promise((resolve) => {
      let settled = false;
      try {
        const ws = new WebSocketImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        this._ws = ws;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            try {
              ws.close();
            } catch {
              /* */
            }
            this._ws = null;
            resolve(false);
          }
        }, 4000);

        ws.on('open', () => {
          /* wait for transcript.created */
        });
        ws.on('message', (data) => {
          this._handleWsEvent(data, {
            onReady: () => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(true);
              }
            },
          });
        });
        ws.on('error', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this._ws = null;
            resolve(false);
          }
        });
        ws.on('close', () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(false);
          }
        });
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * @param {any} data
   * @param {{ onReady?: () => void }} [hooks]
   */
  _handleWsEvent(data, hooks = {}) {
    let event;
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    if (event.type === 'transcript.created') {
      hooks.onReady?.();
      return;
    }
    if (event.type === 'transcript.partial') {
      const { state, display } = accumulateTranscript(this._tx, {
        type: 'transcript.partial',
        text: event.text,
        is_final: event.is_final,
        speech_final: event.speech_final,
      });
      this._tx = state;
      if (display) {
        this.onPartial?.(display, {
          isFinal: !!event.is_final,
          speechFinal: !!event.speech_final,
        });
      }
      return;
    }
    if (event.type === 'transcript.done') {
      const { state, display } = accumulateTranscript(this._tx, {
        type: 'transcript.done',
        text: event.text,
      });
      this._tx = state;
      if (display) this.onFinal?.(display);
      return;
    }
    if (event.type === 'error') {
      this.onError?.(new Error(event.message || 'STT stream error'));
    }
  }

  /**
   * Stop capture and return final transcript.
   * @returns {Promise<string>}
   */
  async stop() {
    this._closed = true;
    this.onStatus?.('识别中…');

    // disconnect audio
    try {
      this._processor?.disconnect();
      this._source?.disconnect();
      await this._ctx?.close();
    } catch {
      /* */
    }
    try {
      this._stream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* */
    }

    if (this._mode === 'ws' && this._ws) {
      return new Promise((resolve) => {
        const ws = this._ws;
        let done = false;
        const finish = (text) => {
          if (done) return;
          done = true;
          try {
            ws.close();
          } catch {
            /* */
          }
          this.onStatus?.('就绪');
          resolve(String(text || this._utterance || '').trim());
        };
        const timeout = setTimeout(() => finish(this._utterance), 5000);
        ws.on('message', (data) => {
          try {
            const event = JSON.parse(String(data));
            if (event.type === 'transcript.done') {
              const { state, display } = accumulateTranscript(this._tx, {
                type: 'transcript.done',
                text: event.text,
              });
              this._tx = state;
              clearTimeout(timeout);
              finish(display);
              return;
            }
            if (event.type === 'transcript.partial') {
              const { state, display } = accumulateTranscript(this._tx, {
                type: 'transcript.partial',
                text: event.text,
                is_final: event.is_final,
                speech_final: event.speech_final,
              });
              this._tx = state;
              if (display) {
                this.onPartial?.(display, {
                  isFinal: !!event.is_final,
                  speechFinal: !!event.speech_final,
                });
              }
            }
          } catch {
            /* */
          }
        });
        try {
          // xAI PTT: force speech_final, then flush and close
          ws.send(JSON.stringify({ type: 'Finalize' }));
          ws.send(JSON.stringify({ type: 'audio.done' }));
        } catch {
          clearTimeout(timeout);
          finish(this._utterance);
        }
      });
    }

    // REST path: stitch PCM → WAV
    try {
      const total = this._restChunks.reduce((n, c) => n + c.length, 0);
      if (!total) {
        this.onStatus?.('就绪');
        return '';
      }
      const merged = new Int16Array(total);
      let off = 0;
      for (const c of this._restChunks) {
        merged.set(c, off);
        off += c.length;
      }
      const wav = encodeWav(merged, 16000);
      const text = await transcribeRest({
        apiKey: this.apiKey,
        body: wav,
        filename: 'voice.wav',
        language: this.language || undefined,
      });
      this.onFinal?.(text);
      this.onStatus?.('就绪');
      return text;
    } catch (e) {
      this.onStatus?.('就绪');
      this.onError?.(e instanceof Error ? e : new Error(String(e)));
      throw e;
    }
  }

  cancel() {
    this._closed = true;
    try {
      this._processor?.disconnect();
      this._source?.disconnect();
      this._ctx?.close();
    } catch {
      /* */
    }
    try {
      this._stream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* */
    }
    try {
      this._ws?.close?.();
    } catch {
      /* */
    }
    this.onStatus?.('就绪');
  }
}
