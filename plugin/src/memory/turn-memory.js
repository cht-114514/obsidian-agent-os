/**
 * Bridge chat turns → formation pipeline (non-blocking).
 */
import { runFormationAfterTurn } from './lifecycle.js';

/**
 * @param {any} app
 * @param {any} plugin
 * @param {{ sessionKey: string, turnId: string, rows: { role: string, text?: string, ts?: number, turnId?: string }[] }} args
 */
export function scheduleFormationAfterTurn(app, plugin, args) {
  const turnId = args.turnId;
  const rows = args.rows || [];
  const user = rows.find((m) => m.turnId === turnId && m.role === 'user');
  const assistant = rows.find((m) => m.turnId === turnId && m.role === 'assistant');
  const userText = String(user?.text || '').trim();
  const assistantText = String(assistant?.text || '').trim();
  if (!assistantText) return;

  void runFormationAfterTurn(app, plugin, {
    sessionKey: args.sessionKey,
    userText,
    assistantText,
    ts: assistant?.ts || Date.now(),
  }).catch((e) => {
    console.warn('scheduleFormationAfterTurn', e);
  });
}
