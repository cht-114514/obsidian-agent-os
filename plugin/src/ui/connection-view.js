/**
 * Non-blocking connection banner. Live state hides it and leaves the composer usable.
 * @param {HTMLElement} el
 * @param {{ state?: string, message?: string, requestId?: string, approveCommand?: string }} status
 * @param {{ onRetry?: () => void, onCopy?: (text: string) => void }} actions
 */
export function renderConnection(el, status, actions = {}) {
  const state = status?.state || 'offline';
  if (state === 'live') {
    el.empty();
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.empty();
  const banner = el.createDiv({ cls: `aos-banner is-${state}` });
  const title = state === 'pairing' ? '等待批准' : state === 'connecting' ? '正在连接' : '未连接';
  banner.createSpan({ cls: 'aos-banner-title', text: title });
  banner.createSpan({ cls: 'aos-banner-msg', text: status?.message || '检查网关地址和 token。' });
  if (status?.approveCommand) {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '复制批准命令', attr: { type: 'button' } }).onclick =
      () => actions.onCopy?.(status.approveCommand);
  }
  if (state !== 'connecting') {
    banner.createEl('button', { cls: 'aos-banner-btn', text: '重试', attr: { type: 'button' } }).onclick = () =>
      actions.onRetry?.();
  }
}

export function placeholderFor(state, agentName) {
  const name = agentName || 'Agent';
  if (state === 'live') return `发消息给 ${name}`;
  if (state === 'connecting') return '正在连接…';
  if (state === 'pairing') return '等待批准。连上之后才能发送';
  return '还没连上。连上之后才能发送';
}
