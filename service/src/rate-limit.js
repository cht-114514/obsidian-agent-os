/**
 * In-memory sliding-window rate limiting.
 *
 * Two separate budgets: normal business requests per credential/IP, and a much
 * tighter budget for pairing attempts (which are guessable by nature).
 */

export function createRateLimiter({ windowMs = 60000, max = 240 } = {}) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();
  let lastSweep = 0;

  function sweep(now) {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((ts) => now - ts < windowMs);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }

  return {
    /**
     * @param {string} key
     * @param {number} [cost]
     * @param {number} [overrideMax] tighter budget for a specific bucket
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    check(key, cost = 1, overrideMax) {
      const limit = Number.isFinite(overrideMax) && overrideMax > 0 ? overrideMax : max;
      const now = Date.now();
      sweep(now);
      const stamps = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
      if (stamps.length + cost > limit) {
        const oldest = stamps[0] || now;
        hits.set(key, stamps);
        return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
      }
      for (let i = 0; i < cost; i += 1) stamps.push(now);
      hits.set(key, stamps);
      return { allowed: true, remaining: Math.max(0, limit - stamps.length), retryAfterMs: 0 };
    },
    reset(key) {
      if (key === undefined) hits.clear();
      else hits.delete(key);
    },
    size() {
      return hits.size;
    },
  };
}
