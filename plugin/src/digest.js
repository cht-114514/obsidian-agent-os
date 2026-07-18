/**
 * Model-backed digest helpers (Grok Build ACP).
 * Wiki is written as pending_review; accept finalizes, reject deletes.
 */

/**
 * @param {string} sourcePath vault-relative
 * @param {string} sourceContent full note text
 * @param {{ maxChars?: number }} [opts]
 */
export function buildDigestPrompt(sourcePath, sourceContent, opts = {}) {
  const max = opts.maxChars ?? 100000;
  let body = String(sourceContent || '');
  let truncated = false;
  if (body.length > max) {
    body = body.slice(0, max);
    truncated = true;
  }

  return [
    '你是 Obsidian vault 的 wiki 编译器（agent-inbox/wiki）。',
    '任务：把下面「源笔记」编译成一篇完整、可检索的 wiki 页，供以后的 Agent 使用。',
    '',
    '## 硬规则',
    '1. 只输出 wiki 的 Markdown 全文，不要寒暄、不要解释过程。',
    '2. 必须以 YAML frontmatter 开头，字段至少包含：',
    '   - type: wiki-source',
    '   - wiki_status: pending_review',
    `   - source_paths: ${JSON.stringify([sourcePath])}`,
    '   - managed_by: me-digest',
    '   - created: (今天的 YYYY-MM-DD)',
    '3. 忠于原文；不要编造源文没有的事实。不确定处写「[待核实]」。',
    '4. 必须写完整，禁止机械截断式半句结尾。',
    '5. 建议结构（可按材料调整小节名，但信息要全）：',
    '   # 标题',
    '   ## 核心结论',
    '   ## 要点拆解',
    '   ## 细节与证据',
    '   ## 可行动 / 对我意味着什么',
    '   ## 开放问题',
    '   ## Source（用 wikilink 指回源路径）',
    '6. 不要写入人区路径建议之外的操作；不要声称已修改四主区。',
    truncated
      ? '7. 注意：源文过长已截断输入；请根据已给部分尽力编译，并在文末注明「源文输入截断」。'
      : '',
    '',
    `## 源路径`,
    sourcePath,
    '',
    '## 源内容',
    '```markdown',
    body,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Strip model chatter; keep markdown doc (with optional frontmatter).
 * @param {string} raw
 */
export function extractWikiMarkdown(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';

  // strip ```markdown ... ``` or ``` ... ```
  const fenced = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenced) t = fenced[1].trim();

  // if model wrapped with prose before ---, start at first frontmatter
  const fmIdx = t.indexOf('---\n');
  if (fmIdx > 0 && fmIdx < 200) {
    t = t.slice(fmIdx);
  }

  // drop trailing prose after last meaningful section if model added "希望以上..."
  // keep as-is if has frontmatter
  return t.trim();
}

/**
 * Ensure required frontmatter keys; set wiki_status.
 * @param {string} md
 * @param {{
 *   sourcePath: string,
 *   wikiStatus: 'pending_review' | 'accepted' | 'rejected',
 *   created?: string,
 * }} meta
 */
export function ensureWikiDocument(md, meta) {
  const created = meta.created || new Date().toISOString().slice(0, 10);
  const extracted = extractWikiMarkdown(md);
  const fmMatch = extracted.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  /** @type {Record<string, string>} */
  const fields = {
    type: 'wiki-source',
    wiki_status: meta.wikiStatus,
    managed_by: 'me-digest',
    created,
    source_paths: JSON.stringify([meta.sourcePath]),
  };

  let body = extracted;
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!m) continue;
      const k = m[1];
      // force critical keys
      if (k === 'wiki_status' || k === 'type' || k === 'managed_by' || k === 'source_paths') continue;
      if (k === 'created' && fields.created) continue;
      fields[k] = m[2].trim();
    }
    body = fmMatch[2].replace(/^\n+/, '');
  }

  fields.type = 'wiki-source';
  fields.wiki_status = meta.wikiStatus;
  fields.managed_by = 'me-digest';
  fields.source_paths = JSON.stringify([meta.sourcePath]);
  if (!fields.created) fields.created = created;

  const fm = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  if (!body.trim()) {
    body = `# Digest\n\n（模型未返回正文）\n\n## Source\n\n- [[${meta.sourcePath}]]\n`;
  }

  // ensure source link exists
  if (!body.includes(meta.sourcePath) && !body.includes('[[')) {
    body = body.trimEnd() + `\n\n## Source\n\n- [[${meta.sourcePath}]]\n`;
  }

  return `---\n${fm}\n---\n\n${body.trim()}\n`;
}

/**
 * Update wiki_status in an existing wiki doc.
 * @param {string} md
 * @param {'pending_review'|'accepted'|'rejected'} status
 */
export function setWikiStatus(md, status) {
  if (/^---\n[\s\S]*?\n---/.test(md)) {
    if (/^wiki_status:/m.test(md) || /\nwiki_status:/m.test(md)) {
      return md.replace(/^(wiki_status:\s*).+$/m, `$1${status}`);
    }
    return md.replace(/^---\n/, `---\nwiki_status: ${status}\n`);
  }
  return `---\nwiki_status: ${status}\ntype: wiki-source\n---\n\n${md}`;
}

/**
 * Build pending file for digest confirmation.
 */
export function buildDigestPending({
  date,
  title,
  wikiRel,
  sourcePath,
  preview,
}) {
  return [
    '---',
    'status: pending',
    'type: digest',
    `title: ${title}`,
    `created: ${date}`,
    `path: ${wikiRel}`,
    `wiki_path: ${wikiRel}`,
    `source_paths: ${JSON.stringify([sourcePath])}`,
    '---',
    '',
    '## 确认 digest',
    '',
    `- **源**：\`[[${sourcePath}]]\``,
    `- **Wiki（待审）**：\`${wikiRel}\`（\`wiki_status: pending_review\`）`,
    '',
    '### 操作语义',
    '',
    '- **Accept**：wiki 定稿（`wiki_status: accepted`），pending → approved',
    '- **Reject**：删除该 wiki 文件，pending → rejected',
    '',
    '### 预览（截取）',
    '',
    preview || '（无）',
    '',
  ].join('\n');
}

/**
 * Short plain preview from wiki body for confirm card.
 * @param {string} wikiMd
 * @param {number} max
 */
export function wikiPreview(wikiMd, max = 280) {
  const body = String(wikiMd || '')
    .replace(/^---[\s\S]*?---\n/, '')
    .replace(/[#>*`]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
  return body.length > max ? body.slice(0, max) + '…' : body;
}
