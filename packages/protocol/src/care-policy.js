/**
 * Care / 牵挂 policy — pure.
 */

/**
 * @typedef {{
 *   dailyCap: number,
 *   quietHours: { start: string, end: string },
 *   blacklist: Array<{ when?: string, scope?: string, reason?: string }>,
 *   quietToday?: boolean,
 * }} CareConfig
 */

/**
 * @typedef {{
 *   id: string,
 *   message: string,
 *   evidence: string[],
 *   priority?: number,
 * }} CareItem
 */

const DEFAULT_CAP = 3;
const DEFAULT_QUIET = { start: '23:30', end: '07:00' };

/**
 * Parse cares.md loosely for daily_cap, quiet hours, blacklist table, quiet flag.
 * @param {string} md
 * @returns {CareConfig}
 */
export function parseCaresMarkdown(md) {
  const text = String(md || '');
  let dailyCap = DEFAULT_CAP;
  const capFm = text.match(/daily_cap:\s*(\d+)/i);
  if (capFm) dailyCap = Number(capFm[1]);
  const capBody = text.match(/每日主动消息\s*\*?\*?≤\s*\*?\*?\s*(\d+)/);
  if (capBody) dailyCap = Number(capBody[1]);

  let quietHours = { ...DEFAULT_QUIET };
  const qh = text.match(/Quiet hours[：:]\s*默认\s*(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/i);
  if (qh) quietHours = { start: qh[1], end: qh[2] };
  const qh2 = text.match(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})\s*不主动/);
  if (qh2) quietHours = { start: qh2[1], end: qh2[2] };

  /** @type {CareConfig['blacklist']} */
  const blacklist = [];
  // table rows under ## 黑名单 only (stop at next ## heading)
  const afterBl = text.split(/##\s*黑名单/)[1] || '';
  const tableSection = afterBl.split(/\n##\s+/)[0] || '';
  for (const line of tableSection.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    if (/何时|----|^\|\s*-+/.test(line)) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length >= 1 && cells[0] && cells[0] !== '（空）' && cells[0] !== '(空)') {
      blacklist.push({ when: cells[0], scope: cells[1] || '', reason: cells[2] || '' });
    }
  }

  const quietToday = /quietToday:\s*true/i.test(text) || /今日少说话:\s*true/i.test(text);

  return { dailyCap, quietHours, blacklist, quietToday };
}

/**
 * @param {string} hhmm e.g. "23:30"
 * @returns {number} minutes from midnight
 */
export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Quiet hours spanning midnight supported (e.g. 23:30–07:00).
 * @param {Date} now
 * @param {{ start: string, end: string }} quietHours
 */
export function isInQuietHours(now, quietHours) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = timeToMinutes(quietHours.start);
  const end = timeToMinutes(quietHours.end);
  if (start === end) return false;
  if (start < end) {
    return mins >= start && mins < end;
  }
  // wraps midnight
  return mins >= start || mins < end;
}

/**
 * Whether proactivity is allowed right now.
 * @param {CareConfig} config
 * @param {Date} [now]
 * @param {{ sentToday?: number }} [state]
 */
export function canSendCare(config, now = new Date(), state = {}) {
  if (config.quietToday) {
    return { ok: false, reason: 'quiet today / 今日少说话' };
  }
  if (config.blacklist?.length) {
    // any active blacklist entry suppresses (simple model)
    const active = config.blacklist.filter((b) => b.when && b.when !== '（空）');
    if (active.length) {
      return { ok: false, reason: `blacklist: ${active[0].reason || active[0].when}` };
    }
  }
  if (isInQuietHours(now, config.quietHours || DEFAULT_QUIET)) {
    return { ok: false, reason: 'quiet hours' };
  }
  const sent = state.sentToday ?? 0;
  const cap = config.dailyCap ?? DEFAULT_CAP;
  if (sent >= cap) {
    return { ok: false, reason: `daily cap ${cap} reached` };
  }
  return { ok: true, reason: 'ok', remaining: cap - sent };
}

/**
 * Filter care candidates to evidence-backed items within remaining cap.
 * @param {CareItem[]} candidates
 * @param {CareConfig} config
 * @param {{ sentToday?: number, now?: Date }} [state]
 * @returns {{ items: CareItem[], suppressedReason?: string }}
 */
export function selectCareItems(candidates, config, state = {}) {
  const gate = canSendCare(config, state.now || new Date(), { sentToday: state.sentToday ?? 0 });
  if (!gate.ok) {
    return { items: [], suppressedReason: gate.reason };
  }
  const remaining = gate.remaining ?? config.dailyCap ?? DEFAULT_CAP;
  const valid = (candidates || []).filter(
    (c) => c && c.message && Array.isArray(c.evidence) && c.evidence.length > 0 && c.evidence.every(Boolean)
  );
  valid.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return { items: valid.slice(0, remaining) };
}

/**
 * Serialize items to pending-care.md body.
 * @param {CareItem[]} items
 * @returns {string}
 */
export function serializePendingCare(items) {
  const list = items || [];
  const fm = [
    '---',
    'title: 待展示牵挂',
    'type: pending-care',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    `items: ${list.length}`,
    '---',
    '',
    '# Pending Care',
    '',
  ];
  if (!list.length) {
    return fm.join('\n') + '当前无未读牵挂。\n';
  }
  const body = list
    .map((it, i) => {
      const ev = it.evidence.map((e) => `  - ${e}`).join('\n');
      return `## ${i + 1}. ${it.id}\n\n${it.message}\n\n证据:\n${ev}\n`;
    })
    .join('\n');
  return fm.join('\n') + body;
}

/**
 * Parse pending-care.md items count for cap accounting.
 * @param {string} md
 * @returns {number}
 */
export function countPendingCareItems(md) {
  const m = String(md || '').match(/^items:\s*(\d+)/m);
  if (m) return Number(m[1]);
  const headers = String(md || '').match(/^##\s+\d+\./gm);
  return headers ? headers.length : 0;
}
