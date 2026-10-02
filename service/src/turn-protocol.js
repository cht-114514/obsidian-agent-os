/**
 * Shared rules for model switching, history reconciliation, and progress text.
 * OpenClaw's chat.send accepts thinking, not model. The model is applied with
 * sessions.patch and must succeed before the message is sent.
 */

const TERMINAL_STOPS = new Set(['stop', 'end_turn', 'end', 'stop_sequence', 'length']);

export function sessionPatchForTurn(turn) {
  const model = String(turn?.model || '').trim();
  const thinking = String(turn?.thinking || '').trim();
  if (!model && !thinking) return null;
  return {
    key: turn.sessionKey,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {}),
  };
}

/** chat.send body. Model is intentionally absent. */
export function chatSendParams(turn) {
  return {
    sessionKey: turn.sessionKey,
    message: turn.message,
    idempotencyKey: turn.runId,
    ...(turn.thinking ? { thinking: turn.thinking } : {}),
  };
}

export function messageText(row) {
  if (!row) return '';
  if (typeof row.text === 'string' && row.text) return row.text;
  if (typeof row.content === 'string') return row.content;
  if (Array.isArray(row.content)) {
    return row.content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * A run is finished only when an assistant row for that run actually stopped.
 * A tool-use assistant row is an intermediate step, not a result.
 * No matching rows is uncertain: absence is not proof the run never started.
 */
export function classifyRun(messages, runId) {
  const id = String(runId || '');
  const rows = (messages || []).filter(
    (row) => row?.__openclaw?.runId === id || row?.idempotencyKey === id
  );
  if (!rows.length) return { found: false, finished: false, uncertain: true, text: '' };
  const assistants = rows.filter((row) => row.role === 'assistant');
  const finals = assistants.filter((row) => {
    const stop = String(row.stopReason || '').trim();
    if (stop === 'toolUse' || stop === 'tool_use') return false;
    if (!stop) return messageText(row).trim().length > 0;
    return TERMINAL_STOPS.has(stop);
  });
  const text = finals.map(messageText).filter(Boolean).join('\n\n');
  return {
    found: true,
    finished: finals.length > 0,
    uncertain: finals.length === 0,
    text,
  };
}

/** Keep streaming updates moving after the stored preview is capped. */
export function progressPreview(text, max = 4000) {
  const full = String(text || '');
  if (full.length <= max) return full;
  return `…(${full.length})\n${full.slice(-max)}`;
}
