/**
 * Thin agent turn helpers for IDE command bar (and future chat-panel share).
 * Intent is pure natural language — the model decides insert/replace/show.
 */

/**
 * @typedef {import('./editor-apply.js').EditorCapture} EditorCapture
 */

/**
 * Build a command-bar prompt: no local intent classification.
 * Model understands the user request and declares APPLY mode.
 *
 * @param {{
 *   userText: string,
 *   capture: EditorCapture,
 *   injectSoul?: boolean,
 *   soulBlock?: string,
 * }} opts
 * @returns {string}
 */
export function buildCommandBarPrompt(opts) {
  const userText = String(opts.userText || '').trim();
  const cap = opts.capture || {
    path: null,
    selection: '',
    hasSelection: false,
    cursor: { line: 0, ch: 0 },
    vicinityBefore: '',
    vicinityAfter: '',
    noteExcerpt: '',
  };

  const parts = [];
  parts.push('# 任务：Obsidian 编辑器内联助手');
  parts.push('');
  parts.push('你和在 Grok Build 里一样，用**自然语言完整理解**用户在说什么。');
  parts.push('插件**不会**用关键词猜测意图；由你判断该改笔记还是只回答。');
  parts.push('');
  parts.push('## 硬性约束');
  parts.push(
    [
      '- **禁止调用任何工具**（不要 read/search/edit/write/bash/web）',
      '- **禁止**读写磁盘；要写入笔记的内容只放在消息正文里',
      '- 不要输出 :::thought / :::confirm 围栏',
      '- 知识性内容（公式、定理、概念）用你已有知识直接写，不要先去翻文件',
    ].join('\n')
  );
  parts.push('');
  parts.push('## 你如何决定（自然语言理解，不是关键词匹配）');
  parts.push(
    [
      '读懂用户意图后，选择一种动作：',
      '- **replace** — 用户要改写/润色/替换**当前选区**（仅当下面提供了选中文本时）',
      '- **insert** — 用户要你写一段可放进笔记的内容（知识点、续写、起草、补过渡等）→ 插到光标处',
      '- **show** — 用户只是提问、讨论、解释、总结，**不要**改笔记，只回答',
      '',
      '没有选区时不要选 replace（应选 insert 或 show）。',
      '拿不准是否写入时，选 **show**（更安全）。',
    ].join('\n')
  );
  parts.push('');
  parts.push('## 输出格式（必须遵守，便于插件自动应用）');
  parts.push(
    [
      '第 1 行只能是下面之一（不要加其它字）：',
      'APPLY: replace',
      'APPLY: insert',
      'APPLY: show',
      '',
      '第 2 行空行。',
      '从第 3 行起是正文：',
      '- replace / insert：只输出要写入笔记的正文（不要「以下是…」前言）',
      '- show：正常回答即可',
      '',
      '公式可用 $...$ / $$...$$；不要用 markdown 代码围栏包住整篇正文。',
    ].join('\n')
  );
  parts.push('');

  if (opts.injectSoul && opts.soulBlock) {
    parts.push('## 人格（可选注入）');
    parts.push(String(opts.soulBlock).trim());
    parts.push('');
  }

  if (cap.path) {
    parts.push(`## 当前笔记\n路径：\`${cap.path}\``);
  }

  if (cap.hasSelection && cap.selection) {
    parts.push('## 选中文本（若用户要改这段，用 replace）');
    parts.push('```');
    parts.push(cap.selection);
    parts.push('```');
  }

  if (cap.vicinityBefore || cap.vicinityAfter) {
    parts.push('## 光标附近（语气/结构参考；生成时不必复述）');
    if (cap.vicinityBefore) {
      parts.push('### 前文');
      parts.push('```');
      parts.push(cap.vicinityBefore);
      parts.push('```');
    }
    if (cap.vicinityAfter) {
      parts.push('### 后文');
      parts.push('```');
      parts.push(cap.vicinityAfter);
      parts.push('```');
    }
  }

  // Light note context — model decides whether it matters; keep short to avoid tool-loops
  if (cap.noteExcerpt && !cap.hasSelection) {
    const excerpt = String(cap.noteExcerpt);
    const capped =
      excerpt.length > 2000 ? excerpt.slice(0, 2000) + '\n…(截断)' : excerpt;
    parts.push('## 笔记摘录（可选上下文；与用户请求无关时可忽略）');
    parts.push('```');
    parts.push(capped);
    parts.push('```');
  }

  parts.push('## 用户说');
  parts.push(userText || '（空）');

  return parts.join('\n');
}

/**
 * Run one ephemeral ACP turn (does not keep session for chat sidebar).
 *
 * @param {{
 *   acp: {
 *     sessionId?: string | null,
 *     prompt: (text: string, handlers: any) => Promise<{ stopReason?: string }>,
 *     cancel?: () => void,
 *   },
 *   promptText: string,
 *   handlers: {
 *     onText?: (t: string) => void,
 *     onThought?: (t: string) => void,
 *     onToolCall?: (u: any) => void,
 *     onToolUpdate?: (u: any) => void,
 *     onPermission?: (req: any) => void,
 *   },
 *   ephemeral?: boolean,
 * }} opts
 */
export async function runAgentTurn(opts) {
  const acp = opts.acp;
  if (!acp?.prompt) throw new Error('ACP client unavailable');

  const ephemeral = opts.ephemeral !== false;
  const prevSession = acp.sessionId;
  if (ephemeral) {
    acp.sessionId = null;
  }

  let full = '';
  try {
    const handlers = {
      onThought: opts.handlers?.onThought,
      onText: (t) => {
        full += t;
        opts.handlers?.onText?.(t);
      },
      onToolCall: opts.handlers?.onToolCall,
      onToolUpdate: opts.handlers?.onToolUpdate,
      onPermission: opts.handlers?.onPermission,
    };
    const result = await acp.prompt(opts.promptText, handlers);
    return {
      ok: true,
      text: full,
      stopReason: result?.stopReason || 'end_turn',
    };
  } catch (e) {
    return {
      ok: false,
      text: full,
      error: e?.message || String(e),
      stopReason: 'error',
    };
  } finally {
    if (ephemeral) {
      acp.sessionId = prevSession ?? null;
    }
  }
}
