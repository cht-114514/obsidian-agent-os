/**
 * OpenAI-compatible embeddings client (DMX / any compatible relay).
 * Never logs apiKey.
 */

const DEFAULT_BATCH = 16;

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   texts: string[],
 *   signal?: AbortSignal,
 *   batchSize?: number,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(opts) {
  const base = String(opts.baseUrl || '').replace(/\/$/, '');
  const apiKey = String(opts.apiKey || '').trim();
  const model = String(opts.model || '').trim();
  const texts = (opts.texts || []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!base) throw new Error('embed: 缺少 baseUrl');
  if (!apiKey) throw new Error('embed: 缺少 API Key');
  if (!model) throw new Error('embed: 缺少 model');
  if (!texts.length) return [];

  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new Error('embed: 当前环境无 fetch');

  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  /** @type {number[][]} */
  const all = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const url = `${base}/embeddings`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input: batch.length === 1 ? batch[0] : batch,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      throw new Error(`embed 网络错误：${e?.message || e}`);
    }

    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`embed 响应非 JSON（HTTP ${res.status}）`);
    }

    if (!res.ok) {
      const msg =
        body?.error?.message ||
        body?.error ||
        body?.message ||
        `HTTP ${res.status}`;
      throw new Error(`embed 失败：${msg}`);
    }

    const data = Array.isArray(body?.data) ? body.data : [];
    // OpenAI sorts by index; ensure order
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (sorted.length !== batch.length) {
      throw new Error(
        `embed 返回条数不匹配：期望 ${batch.length}，得到 ${sorted.length}`
      );
    }
    for (const row of sorted) {
      const emb = row?.embedding;
      if (!Array.isArray(emb) || !emb.length) {
        throw new Error('embed 返回空向量');
      }
      all.push(emb.map((x) => Number(x)));
    }
  }

  return all;
}

/**
 * Default DMX settings (no secret).
 */
export const DEFAULT_EMBED_SETTINGS = {
  embedEnabled: true,
  embedBaseUrl: 'https://www.dmxapi.cn/v1',
  embedApiKey: '',
  embedModel: 'bge-m3',
  embedTopK: 3,
  embedMinScore: 0.28,
  retrieveMode: 'hybrid', // keyword | vector | hybrid
};
