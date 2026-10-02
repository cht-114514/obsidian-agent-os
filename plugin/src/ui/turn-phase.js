/**
 * What the person should read while a turn is in flight.
 * Connection health is separate; this only describes the task.
 */
export function phaseLabel(input = {}) {
  const status = String(input.status || '');
  if (input.confirmingStop) return '正在确认停止';
  if (status === 'saving') return '保存中';
  if (status === 'preparing') return '准备上下文';
  if (status === 'prep_failed') return '上下文读取失败';
  if (status === 'unconfirmed') return '未确认发送';
  if (status === 'queued') return '待发送';
  if (status === 'failed' || status === 'error') return '失败';
  if (status === 'aborted') return '已停止';
  if (status === 'unknown' || status === 'needs_verification') return '核对结果';
  if (input.reconnecting) return '恢复连接';
  if (status === 'sent' || status === 'completed') return '完成';
  if (input.hasText) return '正在回复';
  if (input.delivered) return '已送达';
  if (input.stalled) return '等待模型回复';
  return '等待模型';
}

export function nextStepFor(status, error) {
  const code = String(error?.code || '');
  if (code === 'NOT_PAIRED' || code === 'UNAUTHORIZED') return '重新配对这台设备。';
  if (code === 'MODEL_REJECTED') return '换一个模型后再发。这条没有改用其他模型。';
  if (code === 'NETWORK' || code === 'TIMEOUT') return '重新连接后会继续核对原任务，不会重跑。';
  if (status === 'unknown' || status === 'needs_verification' || code === 'NEEDS_VERIFICATION') {
    return '先检查结果。确认没有执行过，再重试。';
  }
  if (status === 'failed' || status === 'error') return '可以调整后再重试。失败不会自动重发。';
  if (status === 'aborted') return '这条已停止，不会记成成功。';
  return '';
}
