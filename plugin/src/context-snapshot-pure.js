/** Pure helpers (no Obsidian import) for tests and apply validation. */

export function contentVersionHash(body) {
  const s = String(body ?? '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function snapshotStillValid(snap, currentBody) {
  if (!snap?.attached || !snap.path) return { ok: false, reason: 'no_snapshot' };
  const ver = contentVersionHash(currentBody);
  if (ver !== snap.contentVersion) return { ok: false, reason: 'version_mismatch' };
  return { ok: true };
}

export function formatSnapshotForPrompt(snap) {
  if (!snap?.attached) {
    return '\n## 当前笔记\n（未附带 Markdown 正文；勿假设上一篇笔记内容。）\n';
  }
  const parts = [];
  parts.push(`## 当前笔记\n路径：\`${snap.path}\``);
  const line = (snap.cursor?.line ?? 0) + 1;
  const ch = (snap.cursor?.ch ?? 0) + 1;
  parts.push(`光标：第 ${line} 行，第 ${ch} 列（1-based）`);
  if (snap.hasSelection && snap.selection) {
    parts.push('## 选中文本');
    parts.push('```');
    parts.push(snap.selection);
    parts.push('```');
  }
  if (snap.noteExcerpt) {
    parts.push(`## 笔记摘录${snap.truncated ? '（已截断）' : ''}`);
    parts.push('```');
    parts.push(snap.noteExcerpt);
    parts.push('```');
  }
  parts.push(
    '本轮为阅读/写作陪伴：解释、讨论、起草、改写。不要调用工具；需要检索或复杂任务时说明可在全屏继续。'
  );
  parts.push(
    '输出格式：第 1 行 APPLY: replace | insert | show；第 2 行空行；其后为正文。'
  );
  return parts.join('\n');
}
