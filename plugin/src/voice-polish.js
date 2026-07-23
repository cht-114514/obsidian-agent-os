/**
 * Typeless-style dictation polish:
 * - strip fillers / stutters / self-corrections
 * - optional LLM pass for grammar & structure (xAI chat)
 */

/**
 * Fast local cleanup — always available, no network.
 * @param {string} raw
 * @returns {string}
 */
export function polishDictationLocal(raw) {
  let t = String(raw || '').trim();
  if (!t) return '';

  // Unify whitespace first
  t = t.replace(/[\u00a0\u3000]/g, ' ');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');

  // English fillers
  t = t.replace(
    /\b(um+|uh+|er+|ah+|hmm+|like|you know|i mean|sort of|kind of|basically|literally)\b/gi,
    ''
  );

  // Chinese fillers / hesitations
  t = t.replace(
    /(?:嗯+|啊+|呃+|额+|诶+|那个|这那个|就是说|怎么说呢|怎么讲|然后那个|就是就是|的话的话|然后然后)/g,
    ''
  );

  // Self-correction cues: drop the abandoned prefix when user revises mid-sentence
  // e.g. "我们周三见，不对，周四见" → keep rest after cue via multi-pass
  t = t.replace(
    /(?:^|[。！？\n；;])([^。！？\n；;]{0,48}?)(?:不对|不是|错了|说错了|更正一下|我是说|应该是|改成)[，,：:\s]*/g,
    (m, _abandoned, offset, whole) => {
      // Keep the sentence delimiter if any
      const lead = m.match(/^[。！？\n；;]/);
      return lead ? lead[0] : '';
    }
  );
  // Mid-string "X，不对，Y" where X is short clause
  t = t.replace(/[^。！？\n]{1,36}?(?:不对|不是|错了|说错了)[，,：:\s]+/g, '');

  // Immediate consecutive phrase stutter: "今天今天" / "hello hello"
  t = t.replace(/([\u4e00-\u9fff]{1,12})\1+/g, '$1');
  t = t.replace(/\b([A-Za-z][\w']*)(?:\s+\1\b)+/gi, '$1');

  // "的的" "了了" type doubles
  t = t.replace(/([的了着呢过])\1+/g, '$1');

  // Punctuation / space tidy
  t = t.replace(/\s+([，。！？；：、,.!?;:）】」』])/g, '$1');
  t = t.replace(/([（【「『])\s+/g, '$1');
  t = t.replace(/[，,]{2,}/g, '，');
  t = t.replace(/[。.]{2,}/g, '。');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/^[，,。.\s]+/, '');
  t = t.replace(/\s+$/g, '');

  return t.trim();
}

const POLISH_SYSTEM = `你是口播整理助手（类似 Typeless）。把语音识别得到的原文整理成干净、可直接发进输入框的文字。

硬性规则：
1. 删除语气词、口头禅、无意义重复（嗯/啊/那个/就是说/um/uh 等）
2. 识别口误与自我纠正（“不对”“我是说”“应该是”），只保留最终意图
3. 修正明显错别字与断句；中文用自然标点，英文用正常拼写
4. 不添加原文没有的信息，不改变原意，不扩写、不总结
5. 若原文已很干净，只做最小必要清理
6. 只输出整理后的正文，不要引号、不要解释、不要前缀`;

/**
 * Optional LLM polish via xAI Chat Completions.
 * Falls back to local polish on any failure.
 * @param {string} raw
 * @param {{ apiKey?: string, model?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function polishDictation(raw, opts = {}) {
  const local = polishDictationLocal(raw);
  if (!local) return '';

  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) return local;
  // Short clips: local is enough
  if (local.length < 12) return local;

  const model = String(opts.model || 'grok-3-mini').trim() || 'grok-3-mini';
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
        try {
          controller.abort();
        } catch {
          /* */
        }
      }, timeoutMs)
    : null;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.15,
        max_tokens: Math.min(2048, Math.max(256, Math.ceil(local.length * 1.5))),
        messages: [
          { role: 'system', content: POLISH_SYSTEM },
          { role: 'user', content: local },
        ],
      }),
      signal: controller?.signal,
    });
    if (!res.ok) {
      console.warn('voice polish HTTP', res.status);
      return local;
    }
    const data = await res.json();
    const out = String(
      data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || ''
    )
      .trim()
      .replace(/^["「『]|["」』]$/g, '');
    if (!out) return local;
    // Guard against model refusal / meta chatter
    if (/^(抱歉|对不起|as an ai|i cannot)/i.test(out) && out.length > local.length * 1.5) {
      return local;
    }
    return polishDictationLocal(out) || out;
  } catch (e) {
    console.warn('voice polish failed', e);
    return local;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Append polished dictation to existing composer text.
 * @param {string} base
 * @param {string} polished
 * @param {(a: string, b: string) => string} [joinFn]
 */
export function appendPolished(base, polished, joinFn) {
  const a = String(base || '').replace(/\s+$/, '');
  const b = String(polished || '').trim();
  if (!b) return a;
  if (!a) return b;
  if (typeof joinFn === 'function') return joinFn(a, b);
  // Default: space between latin, none between CJK-ish
  const cjk = /[\u3000-\u9fff\uf900-\ufaff]/;
  if (cjk.test(a[a.length - 1]) || cjk.test(b[0])) return a + b;
  return `${a} ${b}`;
}
