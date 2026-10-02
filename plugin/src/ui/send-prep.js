/** Context preparation for one send. A stale token must not start a turn. */

export const PREP_TIMEOUT_MS = 5000;

export function isCompletePack(pack) {
  if (!pack || typeof pack !== 'object') return false;
  return ['identity', 'soul', 'profile', 'style'].some((key) => String(pack[key] || '').trim());
}

/**
 * @param {() => Promise<any>} work
 * @param {number} ms
 * @param {{ cancelled?: boolean }} [token]
 */
export function withDeadline(work, ms, token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('上下文读取超时'), { code: 'PREP_TIMEOUT' }));
    }, ms);
    Promise.resolve()
      .then(() => work())
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (token?.cancelled) {
          reject(Object.assign(new Error('准备已取消'), { code: 'PREP_CANCELLED' }));
          return;
        }
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Fresh pack wins. A timeout may use a previous complete cache.
 * Without either, the send must stop.
 */
export function choosePack(fresh, cache, error) {
  if (!error && isCompletePack(fresh)) return { ok: true, pack: fresh, source: 'fresh' };
  if (isCompletePack(cache)) return { ok: true, pack: cache, source: 'cache' };
  return { ok: false, source: 'failed', code: error?.code || 'PREP_FAILED' };
}
