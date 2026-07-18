/**
 * Minimal OpenClaw gateway client (fetch + optional SSE).
 */

/**
 * @param {{ baseUrl: string, token?: string, message: string, signal?: AbortSignal }} opts
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
export async function sendChat(opts) {
  const base = (opts.baseUrl || 'http://127.0.0.1:18789').replace(/\/$/, '');
  const url = `${base}/v1/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: opts.signal,
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: opts.message }],
        stream: false,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = await res.json();
    const text =
      data?.choices?.[0]?.message?.content ||
      data?.message ||
      data?.content ||
      JSON.stringify(data);
    return { ok: true, text: String(text) };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export function defaultGatewaySettings() {
  return {
    gatewayUrl: 'http://127.0.0.1:18789',
    token: '',
    quiet: false,
    skills: [
      'me-digest',
      'me-write-insight',
      'me-care-check',
      'me-apply-pending',
      'me-apply-insight',
      'me-soul-promote',
      'me-reindex',
    ],
  };
}
