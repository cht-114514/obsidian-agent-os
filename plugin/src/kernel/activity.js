const STATUS_LABELS = {
  preparing_workspace: '准备中',
  preparing_context: '整理上下文',
  starting_model: '思考中',
};

export function emptyActivity() {
  return { reasoning: '', tools: [], status: '' };
}

function cloneActivity(activity) {
  return {
    reasoning: activity?.reasoning || '',
    status: activity?.status || '',
    tools: (activity?.tools || []).map((tool) => ({ ...tool })),
  };
}

function summarizeArgs(value) {
  if (value == null || value === '') return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

function upsertTool(tools, patch) {
  const id = String(patch.id || patch.name || '').trim();
  if (!id) return;
  const index = tools.findIndex((tool) => tool.id === id);
  const prev = index >= 0 ? tools[index] : null;
  const phase = patch.phase || prev?.phase || 'start';
  const done = phase === 'done' || phase === 'error';
  const args = patch.args != null && patch.args !== '' ? summarizeArgs(patch.args) : prev?.args || '';
  const next = {
    id,
    name: patch.name || prev?.name || 'tool',
    phase,
    title: patch.title || prev?.title || '',
    args,
    startedAt: prev?.startedAt || patch.startedAt || Date.now(),
    endedAt: done ? prev?.endedAt || Date.now() : prev?.endedAt || 0,
  };
  if (index >= 0) tools[index] = next;
  else tools.push(next);
}

function applyReasoning(activity, data) {
  const delta = typeof data?.delta === 'string' ? data.delta : '';
  const snapshot =
    typeof data?.text === 'string'
      ? data.text
      : typeof data?.thinking === 'string'
        ? data.thinking
        : typeof data?.reasoning === 'string'
          ? data.reasoning
          : '';
  if (data?.replace && snapshot) {
    activity.reasoning = snapshot;
    return;
  }
  if (snapshot && snapshot.length >= activity.reasoning.length && snapshot.startsWith(activity.reasoning)) {
    activity.reasoning = snapshot;
    return;
  }
  if (delta) activity.reasoning += delta;
  else if (snapshot && !activity.reasoning) activity.reasoning = snapshot;
}

function reasoningFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && /think|reason/i.test(String(part.type || '')))
    .map((part) => part.text || part.thinking || part.reasoning || '')
    .filter(Boolean)
    .join('\n');
}

/**
 * Fold one gateway frame into the live reasoning / tool activity for a turn.
 * Unknown frames leave the activity unchanged.
 */
export function reduceActivity(activity, frame) {
  const next = cloneActivity(activity);
  if (frame?.type !== 'event') return next;
  const payload = frame.payload || {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

  if (frame.event === 'chat' && payload.state === 'status' && payload.phase) {
    next.status = STATUS_LABELS[payload.phase] || String(payload.phase);
    return next;
  }

  if (frame.event === 'chat') {
    const reasoning = reasoningFromContent(payload.message?.content);
    if (reasoning) next.reasoning = reasoning;
    return next;
  }

  if (frame.event !== 'agent') return next;
  const stream = String(payload.stream || '');

  if (stream === 'tool' || stream === 'item') {
    const phase = String(data.phase || '');
    const done = phase === 'result' || phase === 'end';
    upsertTool(next.tools, {
      id: data.toolCallId || data.itemId || data.name,
      name: data.name || data.title || 'tool',
      title: data.title || '',
      args: data.arguments || data.args || data.input || '',
      phase: data.isError ? 'error' : done ? 'done' : 'start',
    });
    next.status = '';
    return next;
  }

  if (/think|reason/i.test(stream)) {
    applyReasoning(next, data);
    next.status = next.reasoning ? '' : next.status;
  }
  return next;
}

export function toolLabel(tool) {
  return tool?.title || tool?.name || 'tool';
}
