/**
 * Cheap-model boundary detection for MemCell formation.
 */

const FORMATION_SYSTEM = `你是记忆边界检测器。输入是「未闭合对话缓冲」加上「本轮用户+助手」。
判断话题是否应闭合为一个 MemCell。

只输出一个 JSON 对象，无 markdown 围栏：
{
  "action": "continue" | "close",
  "episode": "第三人称叙事摘要（close 时必填）",
  "facts": ["原子事实，每条一句"],
  "foresight": [{"text":"对未来决策可能有影响的预判","start":"YYYY-MM-DD","end":"YYYY-MM-DD"}],
  "scene_title": "主题短标题（close 时必填）",
  "profile_deltas": [{"target":"profile"|"style","text":"稳定偏好或沟通偏好，无则 []"}]
}

规则：
- 闲聊未结束、同一话题延续 → continue
- 明显换题、任务告一段落、或缓冲已很久 → close
- facts 只写可验证陈述，不要废话
- foresight 的 end 可为空字符串表示长期有效
- 若被要求 force_close，必须 action=close`;

/**
 * @param {object} parsed
 */
export function normalizeFormationResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return { action: 'continue' };
  const action = parsed.action === 'close' ? 'close' : 'continue';
  const facts = Array.isArray(parsed.facts)
    ? parsed.facts.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 24)
    : [];
  const foresight = Array.isArray(parsed.foresight)
    ? parsed.foresight
        .map((f) => ({
          text: String(f?.text || '').trim(),
          start: String(f?.start || '').slice(0, 10),
          end: String(f?.end || '').slice(0, 10),
        }))
        .filter((f) => f.text)
        .slice(0, 12)
    : [];
  const profile_deltas = Array.isArray(parsed.profile_deltas)
    ? parsed.profile_deltas
        .map((d) => ({
          target: d?.target === 'style' ? 'style' : 'profile',
          text: String(d?.text || '').trim(),
        }))
        .filter((d) => d.text)
        .slice(0, 8)
    : [];
  return {
    action,
    episode: String(parsed.episode || '').trim(),
    facts,
    foresight,
    scene_title: String(parsed.scene_title || '').trim(),
    profile_deltas,
  };
}

/**
 * Extract JSON object from model text.
 * @param {string} text
 */
export function parseFormationJson(text) {
  const s = String(text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('formation: no JSON object');
  return normalizeFormationResult(JSON.parse(body.slice(start, end + 1)));
}

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   bufferTurns: { role: string, text: string }[],
 *   userText: string,
 *   assistantText: string,
 *   forceClose?: boolean,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} opts
 */
export async function callFormationLlm(opts) {
  const base = String(opts.baseUrl || '').replace(/\/$/, '');
  const apiKey = String(opts.apiKey || '').trim();
  const model = String(opts.model || '').trim();
  if (!base || !apiKey || !model) {
    return { skipped: true, reason: 'no-config' };
  }

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) return { skipped: true, reason: 'no-fetch' };

  const lines = [];
  if (opts.forceClose) lines.push('【系统】缓冲已超过 6 小时，必须 force_close，输出 action=close。');
  for (const t of opts.bufferTurns || []) {
    const who = t.role === 'assistant' ? '助手' : '用户';
    lines.push(`${who}：${String(t.text || '').slice(0, 2000)}`);
  }
  lines.push(`用户（本轮）：${String(opts.userText || '').slice(0, 2000)}`);
  lines.push(`助手（本轮）：${String(opts.assistantText || '').slice(0, 2000)}`);

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutMs = opts.timeoutMs ?? 25000;
  const timer =
    controller &&
    setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* */
      }
    }, timeoutMs);

  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 1200,
        messages: [
          { role: 'system', content: FORMATION_SYSTEM },
          { role: 'user', content: lines.join('\n\n') },
        ],
      }),
      signal: opts.signal || controller?.signal,
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`formation HTTP ${res.status} non-JSON`);
    }
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw new Error(`formation: ${msg}`);
    }
    const content = body?.choices?.[0]?.message?.content || '';
    const result = parseFormationJson(content);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
