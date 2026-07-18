/**
 * Plugin confirm approve/reject — pure FS-free; caller writes vault.
 */
import {
  approvePendingMarkdown,
  rejectPendingMarkdown,
  checkWritePolicy,
  parsePendingMarkdown,
} from './protocol-bridge.js';

/**
 * Approve a pending markdown body. Returns new markdown + record.
 * Guarantees human-zone paths in the plan are NOT auto-written here.
 */
export function handleConfirmAccept(pendingMarkdown) {
  const result = approvePendingMarkdown(pendingMarkdown);
  if (!result.ok) return result;
  const rec = parsePendingMarkdown(result.markdown);
  // Safety: if pending targets a human zone path, flag needs apply skill later
  const target = rec.path || '';
  const policy = checkWritePolicy(target, { approvedPending: false });
  return {
    ok: true,
    markdown: result.markdown,
    record: result.record,
    // Plugin only writes the pending file under agent-inbox; never human zones.
    writeTargets: [
      // pending file path is known by caller
    ],
    humanZoneTarget: checkWritePolicy(target).allowed === false && target
      ? target
      : null,
    note: policy.allowed
      ? 'target is agent-inbox; apply skill may merge'
      : 'target is outside free-write; only pending status updated',
  };
}

export function handleConfirmReject(pendingMarkdown) {
  const result = rejectPendingMarkdown(pendingMarkdown);
  if (!result.ok) return result;
  return {
    ok: true,
    markdown: result.markdown,
    record: result.record,
    writeTargets: [],
    humanZoneTarget: null,
  };
}

/**
 * Assert that a batch of write paths is safe for plugin auto-write.
 * Plugin may only auto-write agent-inbox paths.
 */
export function filterPluginSafeWrites(paths) {
  const safe = [];
  const blocked = [];
  for (const p of paths || []) {
    const r = checkWritePolicy(p);
    if (r.allowed) safe.push(p);
    else blocked.push({ path: p, reason: r.reason });
  }
  return { safe, blocked };
}
