/**
 * Grok Build runtime: model profiles + third-party OpenAI-compatible endpoints.
 *
 * Official Grok subscription uses the user's real ~/.grok (login / XAI_API_KEY).
 * Third-party profiles use an isolated GROK_HOME with a generated config.toml
 * so inference hits the gateway with the profile's api_key — env-only overrides
 * cause 401 + silent SuperGrok re-auth loops.
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   model: string,
 *   baseUrl?: string,
 *   apiKey?: string,
 * }} GrokProfile
 *
 * @typedef {{
 *   profileId: string,
 *   label: string,
 *   model: string,
 *   baseUrl: string,
 *   apiKey: string,
 *   binPath: string,
 *   isThirdParty: boolean,
 *   reasoningEffort: string,
 * }} GrokRuntime
 *
 * @typedef {{
 *   model: string,
 *   args: string[],
 *   envPatch: Record<string, string>,
 *   clearEnvKeys: string[],
 *   grokHome: string | null,
 *   configToml: string | null,
 *   isThirdParty: boolean,
 *   label: string,
 *   reasoningEffort: string,
 * }} GrokSpawnPlan
 */

/** Config section name for plugin-managed third-party model. */
export const THIRD_PARTY_MODEL_ALIAS = 'obsidian_tp';

/** Display name for the built-in official / subscription profile. */
export const SUPERGROK_LABEL = 'Grok订阅';

/**
 * Reasoning effort levels accepted by `grok agent --reasoning-effort`
 * (none | minimal | low | medium | high | xhigh). Empty = omit flag (model default).
 * @type {readonly string[]}
 */
export const REASONING_EFFORT_LEVELS = Object.freeze([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

/** Chinese labels for the thinking-level picker. */
export const REASONING_EFFORT_LABELS = Object.freeze({
  '': '默认',
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
});

/** Built-in profile: Grok subscription / xAI (uses grok login or XAI_API_KEY). */
export const DEFAULT_GROK_PROFILES = [
  {
    id: 'supergrok',
    label: SUPERGROK_LABEL,
    model: 'grok-build',
    baseUrl: '',
    apiKey: '',
  },
];

/** Legacy / generic labels we rewrite to a clearer display name. */
const LEGACY_SUPERGROK_LABELS = new Set([
  'supergrok',
  'SuperGrok',
  'SuperGrok (官方)',
  '官方',
  '官方 SuperGrok',
]);

const GENERIC_THIRD_PARTY_LABELS = new Set([
  '第三方模型',
  '第三方',
  'third-party',
  'Third-party',
  'Third Party',
  'third party',
]);

/**
 * @param {string} label
 */
export function isGenericThirdPartyLabel(label) {
  return GENERIC_THIRD_PARTY_LABELS.has(String(label || '').trim());
}

/**
 * Pretty-print a model id for UI: `gpt-5.6-luna` → `GPT-5.6 Luna`.
 * @param {string} model
 */
export function formatModelDisplayName(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  const parts = m.split(/[-_]+/).filter(Boolean);
  /** @type {string[]} */
  const out = [];
  for (const tok of parts) {
    // Dotted versions attach to the prior brand token: gpt + 5.6 → GPT-5.6
    if (/^\d+\.\d+/.test(tok) && out.length) {
      out[out.length - 1] = `${out[out.length - 1]}-${tok}`;
      continue;
    }
    if (/^(gpt|o\d*|claude|gemini|grok|qwen|deepseek|llama|mistral|glm|kimi)$/i.test(tok)) {
      out.push(tok.length <= 4 ? tok.toUpperCase() : tok[0].toUpperCase() + tok.slice(1));
      continue;
    }
    out.push(tok.charAt(0).toUpperCase() + tok.slice(1));
  }
  return out.join(' ');
}

/**
 * Option / chip label for a profile in model switchers.
 * @param {GrokProfile} profile
 */
export function formatProfileOptionLabel(profile) {
  if (!profile) return '';
  if (profile.id === 'supergrok') {
    const label = String(profile.label || '').trim();
    if (!label || LEGACY_SUPERGROK_LABELS.has(label)) return SUPERGROK_LABEL;
    return label;
  }
  const label = String(profile.label || '').trim();
  if (!label || GENERIC_THIRD_PARTY_LABELS.has(label)) {
    return formatModelDisplayName(profile.model) || profile.model || profile.id;
  }
  return label;
}

/**
 * Normalize / validate reasoning effort from settings.
 * @param {unknown} raw
 * @returns {string} empty string or a REASONING_EFFORT_LEVELS value
 */
export function normalizeReasoningEffort(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!v || v === 'default' || v === 'auto') return '';
  return REASONING_EFFORT_LEVELS.includes(v) ? v : '';
}

/**
 * Human label for a thinking level value.
 * @param {string} effort
 */
export function formatReasoningEffortLabel(effort) {
  const e = normalizeReasoningEffort(effort);
  return REASONING_EFFORT_LABELS[e] || REASONING_EFFORT_LABELS[''] || '默认';
}

/**
 * @param {any} raw
 * @returns {GrokProfile[]}
 */
export function normalizeGrokProfiles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {GrokProfile[]} */
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').trim() || `p_${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const model = String(p.model || '').trim() || 'grok-build';
    let label = String(p.label || '').trim();
    if (id === 'supergrok') {
      if (!label || LEGACY_SUPERGROK_LABELS.has(label)) label = SUPERGROK_LABEL;
    } else if (!label || GENERIC_THIRD_PARTY_LABELS.has(label)) {
      label = formatModelDisplayName(model) || model || id;
    }
    out.push({
      id,
      label: label || id,
      model,
      baseUrl: p.baseUrl != null ? normalizeOpenAiBaseUrl(String(p.baseUrl).trim()) : '',
      apiKey: p.apiKey != null ? String(p.apiKey) : '',
    });
  }
  if (!out.length) {
    return DEFAULT_GROK_PROFILES.map((p) => ({ ...p }));
  }
  if (!out.some((p) => p.id === 'supergrok')) {
    out.unshift({ ...DEFAULT_GROK_PROFILES[0] });
  }
  return out;
}

/**
 * Ensure OpenAI-compatible roots end with /v1.
 * `https://www.dmxapi.cn` → `https://www.dmxapi.cn/v1`
 * Leaves paths that already include /v1 (or deeper) alone.
 * @param {string} url
 */
export function normalizeOpenAiBaseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  // already has /v1 as a path segment
  if (/\/v1(\/|$)/i.test(u)) return u.replace(/\/+$/, '');
  // bare host or host/api → append /v1
  try {
    const parsed = new URL(u);
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${parsed.origin}/v1`;
    }
  } catch {
    /* keep raw */
  }
  return `${u}/v1`;
}

/**
 * Resolve active model + endpoint from plugin settings.
 * @param {Record<string, any>} settings
 * @returns {GrokRuntime}
 */
export function resolveGrokRuntime(settings) {
  const s = settings || {};
  const profiles = normalizeGrokProfiles(s.grokProfiles);
  const activeId = String(s.grokActiveProfile || '').trim();
  const profile =
    profiles.find((p) => p.id === activeId) ||
    profiles.find((p) => p.id === 'supergrok') ||
    profiles[0];

  const model =
    (profile?.model || '').trim() ||
    String(s.grokModel || '').trim() ||
    'grok-build';

  const isOfficial = profile?.id === 'supergrok';
  const profileBase = profile?.baseUrl != null ? String(profile.baseUrl).trim() : '';
  const profileKey = profile?.apiKey != null ? String(profile.apiKey).trim() : '';
  const globalBase = normalizeOpenAiBaseUrl(String(s.grokApiBaseUrl || '').trim());
  const globalKey = String(s.grokApiKey || '').trim();

  const baseUrl = isOfficial
    ? normalizeOpenAiBaseUrl(profileBase)
    : normalizeOpenAiBaseUrl(profileBase || globalBase);
  const apiKey = isOfficial ? profileKey : profileKey || globalKey;
  const isThirdParty = !isOfficial && !!baseUrl;
  const reasoningEffort = normalizeReasoningEffort(s.grokReasoningEffort);

  return {
    profileId: profile?.id || '',
    label: formatProfileOptionLabel(profile) || model,
    model,
    baseUrl,
    apiKey,
    binPath: String(s.grokBin || '~/.grok/bin/grok').trim() || '~/.grok/bin/grok',
    isThirdParty,
    reasoningEffort,
  };
}

/**
 * @param {GrokRuntime} rt
 */
export function grokRuntimeSignature(rt) {
  return [
    rt.binPath || '',
    rt.model || '',
    rt.baseUrl || '',
    rt.isThirdParty ? 'tp:1' : 'tp:0',
    rt.apiKey ? 'key:1' : 'key:0',
    rt.apiKey ? simpleHash(rt.apiKey) : '',
    rt.reasoningEffort ? `eff:${rt.reasoningEffort}` : 'eff:',
  ].join('|');
}

/**
 * @param {string} s
 */
function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Escape a string for double-quoted TOML.
 * @param {string} s
 */
export function tomlQuote(s) {
  return `"${String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')}"`;
}

/**
 * Isolated GROK_HOME config for a third-party OpenAI-compatible model.
 * @param {{ model: string, baseUrl: string, apiKey: string, label?: string }} opts
 */
export function buildThirdPartyConfigToml(opts) {
  const model = opts.model || 'gpt-4o-mini';
  const baseUrl = normalizeOpenAiBaseUrl(opts.baseUrl || '');
  const apiKey = opts.apiKey || '';
  const name = opts.label || formatModelDisplayName(model) || model;
  // stream_tool_calls=false: many OpenAI-compatible gateways (e.g. dmxapi) reject
  // partial/empty tool_calls[].function.name during streaming tool assembly
  // (400: Invalid 'messages[n].tool_calls[0].function.name': empty string).
  return [
    '# Generated by Obsidian Agent OS — do not edit by hand',
    '[models]',
    `default = ${tomlQuote(THIRD_PARTY_MODEL_ALIAS)}`,
    'stream_tool_calls = false',
    '',
    `[model.${THIRD_PARTY_MODEL_ALIAS}]`,
    `model = ${tomlQuote(model)}`,
    `base_url = ${tomlQuote(baseUrl)}`,
    `name = ${tomlQuote(name)}`,
    `api_key = ${tomlQuote(apiKey)}`,
    'api_backend = "chat_completions"',
    'stream_tool_calls = false',
    'context_window = 128000',
    '',
  ].join('\n');
}

/**
 * Build `grok agent … stdio` argv, optionally with `--reasoning-effort`.
 * Effort must precede the `stdio` subcommand.
 * @param {{ model?: string, reasoningEffort?: string, useThirdPartyAlias?: boolean }} opts
 */
export function buildGrokStdioArgs(opts = {}) {
  /** @type {string[]} */
  const args = ['agent'];
  const effort = normalizeReasoningEffort(opts.reasoningEffort);
  if (effort) args.push('--reasoning-effort', effort);
  if (opts.useThirdPartyAlias) {
    args.push('-m', THIRD_PARTY_MODEL_ALIAS);
  } else if (opts.model) {
    args.push('-m', opts.model);
  }
  args.push('stdio');
  return args;
}

/**
 * Full spawn plan for ACP client.
 * @param {GrokRuntime} rt
 * @param {{ grokHomeDir?: string | null }} [opts]
 * @returns {GrokSpawnPlan}
 */
export function buildGrokSpawnPlan(rt, opts = {}) {
  const reasoningEffort = normalizeReasoningEffort(rt.reasoningEffort);

  if (rt.isThirdParty && rt.baseUrl) {
    if (!rt.apiKey) {
      // still produce plan; caller should fail early with clear message
    }
    const configToml = buildThirdPartyConfigToml({
      model: rt.model,
      baseUrl: rt.baseUrl,
      apiKey: rt.apiKey,
      label: rt.label,
    });
    return {
      model: THIRD_PARTY_MODEL_ALIAS,
      args: buildGrokStdioArgs({
        useThirdPartyAlias: true,
        reasoningEffort,
      }),
      envPatch: {
        GROK_HOME: opts.grokHomeDir || '',
      },
      // Prevent SuperGrok session token / ambient XAI key from hijacking auth
      clearEnvKeys: [
        'XAI_API_KEY',
        'GROK_CODE_XAI_API_KEY',
        'GROK_MODELS_BASE_URL',
        'GROK_CLI_CHAT_PROXY_BASE_URL',
      ],
      grokHome: opts.grokHomeDir || null,
      configToml,
      isThirdParty: true,
      label: rt.label || rt.model,
      reasoningEffort,
    };
  }

  // Official Grok subscription / default
  /** @type {Record<string, string>} */
  const envPatch = {};
  if (rt.apiKey) {
    envPatch.XAI_API_KEY = rt.apiKey;
    envPatch.GROK_CODE_XAI_API_KEY = rt.apiKey;
  }
  return {
    model: rt.model || '',
    args: buildGrokStdioArgs({
      model: rt.model || '',
      reasoningEffort,
    }),
    envPatch,
    clearEnvKeys: [],
    grokHome: null,
    configToml: null,
    isThirdParty: false,
    label: rt.label || rt.model || SUPERGROK_LABEL,
    reasoningEffort,
  };
}

/**
 * @param {{ model?: string, baseUrl?: string, isThirdParty?: boolean, reasoningEffort?: string }} opts
 * @deprecated prefer buildGrokSpawnPlan
 */
export function buildGrokAgentArgs(opts = {}) {
  if (opts.isThirdParty && opts.baseUrl) {
    return buildGrokStdioArgs({
      useThirdPartyAlias: true,
      reasoningEffort: opts.reasoningEffort,
    });
  }
  const args = buildGrokStdioArgs({
    model: opts.model || '',
    reasoningEffort: opts.reasoningEffort,
  });
  if (opts.baseUrl) {
    // insert base-url flags before trailing `stdio`
    const stdio = args.pop();
    args.push('--xai-api-base-url', opts.baseUrl);
    args.push('--cli-chat-proxy-base-url', opts.baseUrl);
    args.push(stdio || 'stdio');
  }
  return args;
}

/**
 * @param {Record<string, string|undefined>} baseEnv
 * @param {{ apiKey?: string, baseUrl?: string, isThirdParty?: boolean, grokHome?: string }} opts
 * @deprecated prefer buildGrokSpawnPlan + apply
 */
export function buildGrokChildEnv(baseEnv, opts = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v != null) env[k] = String(v);
  }
  if (opts.isThirdParty) {
    delete env.XAI_API_KEY;
    delete env.GROK_CODE_XAI_API_KEY;
    delete env.GROK_MODELS_BASE_URL;
    delete env.GROK_CLI_CHAT_PROXY_BASE_URL;
    if (opts.grokHome) env.GROK_HOME = opts.grokHome;
    return env;
  }
  if (opts.apiKey) {
    env.XAI_API_KEY = opts.apiKey;
    env.GROK_CODE_XAI_API_KEY = opts.apiKey;
  }
  if (opts.baseUrl) {
    env.GROK_MODELS_BASE_URL = opts.baseUrl;
  }
  return env;
}

/**
 * Apply spawn plan to a base env object.
 * @param {Record<string, string|undefined>} baseEnv
 * @param {GrokSpawnPlan} plan
 */
export function applySpawnPlanEnv(baseEnv, plan) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v != null) env[k] = String(v);
  }
  for (const k of plan.clearEnvKeys || []) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(plan.envPatch || {})) {
    if (v) env[k] = v;
  }
  return env;
}

/**
 * @param {GrokRuntime} rt
 */
export function formatGrokRuntimeLabel(rt) {
  const model = rt.model || 'default';
  const name = rt.label || formatModelDisplayName(model) || model;
  const effort = normalizeReasoningEffort(rt.reasoningEffort);
  const effortSuffix = effort ? ` · 思考${formatReasoningEffortLabel(effort)}` : '';
  if (rt.baseUrl) {
    let host = rt.baseUrl;
    try {
      host = new URL(rt.baseUrl).host || rt.baseUrl;
    } catch {
      /* keep */
    }
    return `${name} · ${host}${effortSuffix}`;
  }
  return `${name}${effortSuffix}`;
}

/**
 * Human-readable validation before spawn.
 * @param {GrokRuntime} rt
 * @returns {string | null} error message or null if ok
 */
export function validateGrokRuntime(rt) {
  if (rt.isThirdParty) {
    if (!rt.baseUrl) {
      return '第三方配置档需要 Base URL（例如 https://www.dmxapi.cn/v1）';
    }
    if (!rt.apiKey) {
      return '第三方配置档需要 API Key（配置档或全局 Key）';
    }
    if (!rt.model) {
      return '第三方配置档需要模型 ID';
    }
  }
  return null;
}
