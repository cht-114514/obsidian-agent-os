/**
 * Non-blocking connection banner. Live state hides it and leaves the composer usable.
 * @param {HTMLElement} el
 * @param {{ state?: string, message?: string, requestId?: string, approveCommand?: string, needsPairing?: boolean, paired?: boolean }} status
 * @param {{ onRetry?: () => void, onCopy?: (text: string) => void, onPair?: () => void }} actions
 */
export function renderConnection(el, status, actions = {}) {
  const state = status?.state || 'offline';
  if (state === 'live' && !status?.serviceError) {
    el.empty();
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.empty();
  const banner = el.createDiv({ cls: `aos-banner is-${state}` });
  const title = status?.needsPairing
    ? '还没有配对'
    : state === 'pairing'
      ? '等待批准'
      : state === 'connecting'
        ? '正在连接'
        : '未连接';
  banner.createSpan({ cls: 'aos-banner-title', text: title });
  const defaultMsg = status?.needsPairing
    ? '在 Mac 上生成一次性配对码，然后在这里输入。'
    : state === 'connecting'
      ? '后台同步中，你可以先写消息。'
      : state === 'offline'
        ? '未连接。消息会排队，连上后自动发出。'
        : '未连接。消息会留在这台设备上，恢复后继续核对。';
  banner.createSpan({ cls: 'aos-banner-msg', text: status?.message || defaultMsg });
  if (status?.approveCommand) {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '复制批准命令', attr: { type: 'button' } }).onclick =
      () => actions.onCopy?.(status.approveCommand);
  }
  if (status?.needsPairing && actions.onPair) {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '配对这台设备', attr: { type: 'button' } }).onclick =
      () => actions.onPair();
  }
  if (actions.onDetails) {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '连接详情', attr: { type: 'button' } }).onclick =
      () => actions.onDetails();
  }
  if (state !== 'connecting' || status?.serviceError) {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '重试', attr: { type: 'button' } }).onclick = () =>
      actions.onRetry?.();
  }
}

export function placeholderFor(state, agentName) {
  const name = agentName || 'Agent';
  if (state === 'pairing') return '等待批准设备后发送';
  if (state === 'live') return `发消息给 ${name}`;
  if (state === 'connecting') return `发消息给 ${name}（会先排队）`;
  return `发消息给 ${name}（离线也会排队）`;
}
