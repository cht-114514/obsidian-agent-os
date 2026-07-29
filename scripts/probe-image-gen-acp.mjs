#!/usr/bin/env node
/**
 * One-shot: spawn grok agent stdio, ask for a tiny image_gen, dump tool updates.
 * Usage: node scripts/probe-image-gen-acp.mjs
 */
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

const grok = path.join(os.homedir(), '.grok/bin/grok');
const cwd =
  process.env.VAULT_ROOT ||
  path.resolve(
    os.homedir(),
    'Library/Mobile Documents/iCloud~md~obsidian/Documents/Me.Inc'
  );

const child = spawn(grok, ['agent', 'stdio'], {
  cwd,
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let nextId = 0;
const pending = new Map();
const toolEvents = [];

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params) {
  const id = ++nextId;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, 300000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(t);
        reject(e);
      },
    });
  });
}

function onLine(line) {
  if (!line.startsWith('{')) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'err'));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.id != null && msg.method === 'session/request_permission') {
    const options = msg.params?.options || [];
    const allow =
      options.find((o) => (o.kind || '') === 'allow_once') ||
      options.find((o) => /allow/i.test(o.kind || o.name || '')) ||
      options[0];
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        outcome: allow
          ? { outcome: 'selected', optionId: allow.optionId }
          : { outcome: 'cancelled' },
      },
    });
    return;
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update;
    if (
      u &&
      (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
    ) {
      toolEvents.push(u);
      console.error('--- TOOL EVENT ---');
      console.error(JSON.stringify(u, null, 2).slice(0, 8000));
    }
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    onLine(line);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  const s = String(d);
  if (/error|fail|imagine|image/i.test(s)) process.stderr.write('[stderr] ' + s.slice(0, 500));
});

try {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const sess = await request('session/new', { cwd, mcpServers: [] });
  console.error('session', sess.sessionId);
  const prompt =
    'Call the image_gen tool exactly once with prompt "a tiny red circle on white background" and aspect_ratio "1:1". ' +
    'After it completes, reply with ONLY the absolute path of the saved image file. No other text.';
  const res = await request('session/prompt', {
    sessionId: sess.sessionId,
    prompt: [{ type: 'text', text: prompt }],
  });
  console.error('stopReason', res?.stopReason);
  console.log(JSON.stringify({ count: toolEvents.length, events: toolEvents }, null, 2));
} catch (e) {
  console.error('PROBE FAILED', e);
  console.log(JSON.stringify({ count: toolEvents.length, events: toolEvents }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill();
}
