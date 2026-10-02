/**
 * Logging with a hard rule: credentials and note text never reach the log.
 *
 * Only operational facts (turn id, session key, status, duration, byte counts)
 * are allowed through. Message bodies and results are replaced with a length.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names that must never be logged, whatever their value. */
const REDACTED_KEYS = /^(token|deviceToken|secret|authorization|auth|password|apiKey|code|codes|message|prompt|result|text|content|body|note|notes|excerpt|markdown)$/i;

function isSensitiveKey(key) {
  return REDACTED_KEYS.test(String(key || ''));
}

/**
 * Replace sensitive values with a shape-only description.
 * @param {any} value
 * @param {string} key
 * @param {boolean} logBody
 */
export function redact(value, key = '', logBody = false) {
  if (isSensitiveKey(key)) {
    if (typeof value === 'string') return `<redacted ${value.length} chars>`;
    return '<redacted>';
  }
  if (value == null) return value;
  if (typeof value === 'string') {
    if (logBody) return value;
    if (value.length > 200) return `${value.slice(0, 40)}…<${value.length} chars>`;
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, key, logBody));
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redact(childValue, childKey, logBody);
    }
    return out;
  }
  return String(value);
}

export function createLogger(opts = {}) {
  const level = LEVELS[opts.level] || LEVELS.info;
  const path = opts.path || '';
  const logBody = !!opts.logBody;
  const sink = opts.sink || null;
  if (path && !existsSync(dirname(path))) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* fall back to stdout only */
    }
  }

  function write(name, message, fields) {
    if ((LEVELS[name] || 0) < level) return;
    const entry = {
      ts: new Date().toISOString(),
      level: name,
      msg: message,
    };
    if (fields && Object.keys(fields).length) entry.fields = redact(fields, '', logBody);
    const line = JSON.stringify(entry);
    if (sink) sink(line);
    else process.stdout.write(`${line}\n`);
    if (path) {
      try {
        appendFileSync(path, `${line}\n`);
      } catch {
        /* logging must never break the service */
      }
    }
  }

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    /** Strict mode for tests: collect lines instead of touching the console. */
    child(extraSink) {
      return createLogger({ ...opts, sink: extraSink || sink });
    },
  };
}
