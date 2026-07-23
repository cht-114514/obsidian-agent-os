/**
 * Grok Build runtime: model profiles + third-party OpenAI-compatible endpoints.
 *
 * Official SuperGrok uses the user's real ~/.grok (login / XAI_API_KEY).
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
 * }} GrokSpawnPlan
 */

/** Config section name for plugin-managed third-party model. */
export const THIRD_PARTY_MODEL_ALIAS = 'obsidian_tp';

/** Built-in profile: official SuperGrok / xAI (uses grok login or XAI_API_KEY). */
export const DEFAULT_GROK_PROFILES = [
  {
    id: 'supergrok',
    label: 'SuperGrok (官方)',
    model: 'grok-build',
    baseUrl: '',
    apiKey: '',
  },
];

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
    out.push({
      id,
      label: String(p.label || p.model || id).trim() || id,
      model: String(p.model || '').trim() || 'grok-build',
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

  return {
    profileId: profile?.id || '',
    label: profile?.label || model,
    model,
    baseUrl,
    apiKey,
    binPath: String(s.grokBin || '~/.grok/bin/grok').trim() || '~/.grok/bin/grok',
    isThirdParty,
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
  const name = opts.label || model;
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
 * Full spawn plan for ACP client.
 * @param {GrokRuntime} rt
 * @param {{ grokHomeDir?: string | null }} [opts]
 * @returns {GrokSpawnPlan}
 */
export function buildGrokSpawnPlan(rt, opts = {}) {
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
      args: ['agent', '-m', THIRD_PARTY_MODEL_ALIAS, 'stdio'],
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
    };
  }

  // Official SuperGrok / default
  const args = ['agent'];
  if (rt.model) args.push('-m', rt.model);
  args.push('stdio');
  /** @type {Record<string, string>} */
  const envPatch = {};
  if (rt.apiKey) {
    envPatch.XAI_API_KEY = rt.apiKey;
    envPatch.GROK_CODE_XAI_API_KEY = rt.apiKey;
  }
  return {
    model: rt.model || '',
    args,
    envPatch,
    clearEnvKeys: [],
    grokHome: null,
    configToml: null,
    isThirdParty: false,
    label: rt.label || rt.model || 'SuperGrok',
  };
}

/**
 * @param {{ model?: string, baseUrl?: string, isThirdParty?: boolean }} opts
 * @deprecated prefer buildGrokSpawnPlan
 */
export function buildGrokAgentArgs(opts = {}) {
  if (opts.isThirdParty && opts.baseUrl) {
    return ['agent', '-m', THIRD_PARTY_MODEL_ALIAS, 'stdio'];
  }
  const args = ['agent'];
  if (opts.model) args.push('-m', opts.model);
  if (opts.baseUrl) {
    args.push('--xai-api-base-url', opts.baseUrl);
    args.push('--cli-chat-proxy-base-url', opts.baseUrl);
  }
  args.push('stdio');
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
  if (rt.baseUrl) {
    let host = rt.baseUrl;
    try {
      host = new URL(rt.baseUrl).host || rt.baseUrl;
    } catch {
      /* keep */
    }
    return `${rt.label || model} · ${host}`;
  }
  return rt.label || model;
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
