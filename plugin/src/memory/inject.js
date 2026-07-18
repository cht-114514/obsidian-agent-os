/**
 * Forced soul pack injection for every chat turn.
 * Pure helpers — pass file contents in from vault reader.
 */

export const DEFAULT_CAPS = {
  identity: 1200,
  soul: 2500,
  profile: 2500,
  style: 1200,
  retrievedEach: 1500,
  retrievedMax: 3,
};

/**
 * @param {string} text
 * @param {number} max
 * @param {{ preferSections?: string[] }} [opts]
 */
export function truncateText(text, max, opts = {}) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= max) return s;

  const prefer = opts.preferSections || [];
  if (prefer.length) {
    const chunks = [];
    for (const title of prefer) {
      const re = new RegExp(
        `(^|\\n)##?\\s*${escapeReg(title)}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
        'i'
      );
      const m = s.match(re);
      if (m) chunks.push(`## ${title}\n${m[2].trim()}`);
    }
    if (chunks.length) {
      const joined = chunks.join('\n\n');
      if (joined.length <= max) return joined;
      return joined.slice(0, max - 1) + '…';
    }
  }

  const head = Math.floor(max * 0.7);
  const tail = max - head - 5;
  return s.slice(0, head) + '\n…\n' + s.slice(-tail);
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {{
 *   identity?: string,
 *   soul?: string,
 *   profile?: string,
 *   style?: string,
 *   constitution?: string,
 *   retrieved?: { path: string, title?: string, excerpt: string }[],
 *   userMessage: string,
 *   caps?: Partial<typeof DEFAULT_CAPS>,
 * }} pack
 */
export function buildTurnPrompt(pack) {
  const caps = { ...DEFAULT_CAPS, ...(pack.caps || {}) };
  const parts = [];

  parts.push('# Me.Soul 强制上下文（每轮注入，勿忽略）');
  parts.push(
    '以下 IDENTITY / SOUL / PROFILE / STYLE 是你的稳定人格与用户模型。回答时遵守边界与偏好。'
  );

  if (pack.constitution) {
    parts.push('\n## CONSTITUTION（摘要）\n');
    parts.push(truncateText(pack.constitution, 600));
  }

  parts.push('\n## IDENTITY\n');
  parts.push(truncateText(pack.identity, caps.identity) || '（缺失 IDENTITY.md）');

  parts.push('\n## SOUL\n');
  parts.push(
    truncateText(pack.soul, caps.soul, {
      preferSections: ['硬边界', '默认行为', '边界', '禁止'],
    }) || '（缺失 SOUL.md）'
  );

  parts.push('\n## PROFILE（用户模型）\n');
  parts.push(
    truncateText(pack.profile, caps.profile, {
      preferSections: ['工作方式偏好', '身份', '禁忌', '学科学习'],
    }) || '（缺失 profile.md）'
  );

  parts.push('\n## STYLE\n');
  parts.push(truncateText(pack.style, caps.style) || '（缺失 style.md）');

  const retrieved = pack.retrieved || [];
  if (retrieved.length) {
    parts.push('\n## 相关记忆（预检索：hybrid 关键词 + embedding）\n');
    retrieved.slice(0, caps.retrievedMax).forEach((r, i) => {
      parts.push(
        `### ${i + 1}. ${r.title || r.path}\n路径：\`${r.path}\`\n\n${truncateText(r.excerpt, caps.retrievedEach)}\n`
      );
    });
  } else {
    parts.push('\n## 相关记忆\n（本轮无检索命中或已跳过）\n');
  }

  parts.push('\n## 用户本轮消息\n');
  parts.push(String(pack.userMessage || ''));

  return parts.join('\n');
}

/**
 * Load soul pack from a readFile(rel) => string|null async fn.
 * @param {(rel: string) => Promise<string|null>} readFile
 */
export async function loadSoulPack(readFile) {
  const [identity, soul, profile, style, constitution] = await Promise.all([
    readFile('agent-inbox/soul/IDENTITY.md'),
    readFile('agent-inbox/soul/SOUL.md'),
    readFile('agent-inbox/soul/profile.md'),
    readFile('agent-inbox/soul/style.md'),
    readFile('AGENTS.md'),
  ]);
  return { identity, soul, profile, style, constitution };
}
