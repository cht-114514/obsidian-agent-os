/** Static chat states for the phone preview. No secrets. */

const now = Date.parse('2026-10-01T15:20:00+08:00');

export const previewSkills = [
  { id: 'me-digest' },
  { id: 'me-write-insight' },
  { id: 'me-care-check' },
  { id: 'me-reflect-feedback' },
];

export const previewSessions = [
  {
    key: 'agent:main:main',
    derivedTitle: '主会话',
    updatedAt: now - 3 * 60_000,
    lastMessagePreview: '9.9 比 9.11 大，因为十分位 9 > 1。',
    totalTokens: 42000,
    contextTokens: 200000,
  },
  {
    key: 'agent:main:math',
    derivedTitle: '小数比较',
    updatedAt: now - 2 * 3600_000,
    lastMessagePreview: '先对齐小数点，再从左往右比。',
    hasActiveRun: true,
  },
  {
    key: 'agent:main:old',
    label: '上周复盘',
    updatedAt: now - 8 * 86400_000,
    lastMessagePreview: '把错因写成一句话。',
  },
];

const tableReply = [
  '9.9 比 9.11 大。',
  '',
  '| 数 | 十分位 | 百分位 |',
  '| --- | --- | --- |',
  '| 9.9 | 9 | 0 |',
  '| 9.11 | 1 | 1 |',
  '',
  '十分位上 9 已经大于 1，后面不用再比。',
  '',
  '```text',
  '9.90',
  '9.11',
  '```',
].join('\n');

export function previewMessages(which) {
  if (which === 'empty') return [];
  const tools = ['read', 'read', 'exec', 'exec', 'search', 'fetch', 'write'].map((name, i) => ({
    id: `t${i}`,
    name,
    title: name === 'exec' ? 'node compare.js' : `file-${i}.md`,
    phase: i === 6 ? 'error' : 'done',
    startedAt: now - 292_000 + i * 1000,
    endedAt: now - 292_000 + (i + 1) * 40_000,
  }));
  const user = {
    id: 'u1',
    role: 'user',
    text: '比较 9.9 和 9.11，哪个大？',
    ts: now - 5 * 60_000,
    turnId: 't',
  };
  const assistant = {
    id: 'a1',
    role: 'assistant',
    text: which === 'tools' ? '比较完了：9.9 更大。' : tableReply,
    ts: now - 4 * 60_000,
    turnId: 't',
    activity: {
      reasoning: which === 'tools' ? '先补零，再比十分位。9 大于 1，所以 9.9 更大。' : '',
      status: '',
      tools: which === 'tools' ? tools : tools.slice(0, 2),
      startedAt: now - 292_000,
    },
  };
  return [user, assistant];
}

export const previewNow = now;
