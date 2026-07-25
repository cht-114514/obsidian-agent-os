import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGrokProfiles,
  resolveGrokRuntime,
  buildGrokAgentArgs,
  buildGrokChildEnv,
  buildGrokSpawnPlan,
  buildGrokStdioArgs,
  buildThirdPartyConfigToml,
  normalizeOpenAiBaseUrl,
  grokRuntimeSignature,
  formatGrokRuntimeLabel,
  formatModelDisplayName,
  formatProfileOptionLabel,
  formatReasoningEffortLabel,
  normalizeReasoningEffort,
  validateGrokRuntime,
  THIRD_PARTY_MODEL_ALIAS,
  DEFAULT_GROK_PROFILES,
  SUPERGROK_LABEL,
} from '../src/grok-runtime.js';

describe('grok-runtime', () => {
  it('normalizeOpenAiBaseUrl appends /v1 when missing', () => {
    assert.equal(normalizeOpenAiBaseUrl('https://www.dmxapi.cn'), 'https://www.dmxapi.cn/v1');
    assert.equal(
      normalizeOpenAiBaseUrl('https://www.dmxapi.cn/v1'),
      'https://www.dmxapi.cn/v1'
    );
    assert.equal(
      normalizeOpenAiBaseUrl('https://www.dmxapi.cn/v1/'),
      'https://www.dmxapi.cn/v1'
    );
    assert.equal(normalizeOpenAiBaseUrl(''), '');
  });

  it('normalizeGrokProfiles always includes supergrok as Grok订阅', () => {
    const p = normalizeGrokProfiles([
      { id: 'cheap', label: 'DMX', model: 'gpt-4o-mini', baseUrl: 'https://x' },
    ]);
    assert.equal(p[0].id, 'supergrok');
    assert.equal(p[0].label, SUPERGROK_LABEL);
    assert.equal(p.some((x) => x.id === 'cheap'), true);
    assert.equal(p.find((x) => x.id === 'cheap')?.baseUrl, 'https://x/v1');
  });

  it('normalizeGrokProfiles migrates legacy SuperGrok / 第三方模型 labels', () => {
    const p = normalizeGrokProfiles([
      { id: 'supergrok', label: 'SuperGrok (官方)', model: 'grok-build' },
      { id: 'tp', label: '第三方模型', model: 'gpt-5.6-luna', baseUrl: 'https://x/v1' },
    ]);
    assert.equal(p.find((x) => x.id === 'supergrok')?.label, 'Grok订阅');
    assert.equal(p.find((x) => x.id === 'tp')?.label, 'GPT-5.6 Luna');
  });

  it('formatModelDisplayName pretty-prints common ids', () => {
    assert.equal(formatModelDisplayName('gpt-5.6-luna'), 'GPT-5.6 Luna');
    assert.equal(formatModelDisplayName('claude-sonnet-4'), 'Claude Sonnet 4');
    assert.equal(formatModelDisplayName(''), '');
  });

  it('formatProfileOptionLabel prefers concrete names', () => {
    assert.equal(
      formatProfileOptionLabel({ id: 'supergrok', label: 'SuperGrok', model: 'grok-build' }),
      'Grok订阅'
    );
    assert.equal(
      formatProfileOptionLabel({
        id: 'tp',
        label: '第三方模型',
        model: 'gpt-5.6-luna',
      }),
      'GPT-5.6 Luna'
    );
    assert.equal(
      formatProfileOptionLabel({ id: 'tp', label: '我的 Luna', model: 'gpt-5.6-luna' }),
      '我的 Luna'
    );
  });

  it('resolveGrokRuntime uses active profile then global fallbacks', () => {
    const rt = resolveGrokRuntime({
      grokActiveProfile: 'cheap',
      grokApiBaseUrl: 'https://global.example/v1',
      grokApiKey: 'global-key',
      grokProfiles: [
        ...DEFAULT_GROK_PROFILES,
        {
          id: 'cheap',
          label: 'Cheap',
          model: 'deepseek-v3',
          baseUrl: '',
          apiKey: '',
        },
      ],
    });
    assert.equal(rt.model, 'deepseek-v3');
    assert.equal(rt.baseUrl, 'https://global.example/v1');
    assert.equal(rt.apiKey, 'global-key');
    assert.equal(rt.profileId, 'cheap');
    assert.equal(rt.isThirdParty, true);
    assert.equal(rt.reasoningEffort, '');
  });

  it('supergrok ignores global third-party base/key', () => {
    const rt = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokApiBaseUrl: 'https://global.example/v1',
      grokApiKey: 'global-key',
      grokProfiles: DEFAULT_GROK_PROFILES,
    });
    assert.equal(rt.baseUrl, '');
    assert.equal(rt.apiKey, '');
    assert.equal(rt.model, 'grok-build');
    assert.equal(rt.isThirdParty, false);
    assert.equal(rt.label, 'Grok订阅');
  });

  it('profile baseUrl/apiKey override globals', () => {
    const rt = resolveGrokRuntime({
      grokActiveProfile: 'p',
      grokApiBaseUrl: 'https://global/v1',
      grokApiKey: 'g',
      grokProfiles: [
        {
          id: 'p',
          label: 'P',
          model: 'm1',
          baseUrl: 'https://p/v1',
          apiKey: 'pk',
        },
      ],
    });
    assert.equal(rt.baseUrl, 'https://p/v1');
    assert.equal(rt.apiKey, 'pk');
  });

  it('normalizeReasoningEffort accepts CLI levels', () => {
    assert.equal(normalizeReasoningEffort('high'), 'high');
    assert.equal(normalizeReasoningEffort('XHIGH'), 'xhigh');
    assert.equal(normalizeReasoningEffort('default'), '');
    assert.equal(normalizeReasoningEffort('max'), '');
    assert.equal(formatReasoningEffortLabel('medium'), '中');
    assert.equal(formatReasoningEffortLabel(''), '默认');
  });

  it('buildGrokStdioArgs inserts --reasoning-effort before stdio', () => {
    assert.deepEqual(buildGrokStdioArgs({ model: 'grok-build', reasoningEffort: 'high' }), [
      'agent',
      '--reasoning-effort',
      'high',
      '-m',
      'grok-build',
      'stdio',
    ]);
    assert.deepEqual(
      buildGrokStdioArgs({ useThirdPartyAlias: true, reasoningEffort: 'low' }),
      ['agent', '--reasoning-effort', 'low', '-m', THIRD_PARTY_MODEL_ALIAS, 'stdio']
    );
  });

  it('buildGrokSpawnPlan third-party uses alias and isolated home flags', () => {
    const rt = resolveGrokRuntime({
      grokActiveProfile: 'p',
      grokReasoningEffort: 'medium',
      grokProfiles: [
        {
          id: 'p',
          label: 'DMX',
          model: 'gpt-5.6-luna',
          baseUrl: 'https://www.dmxapi.cn',
          apiKey: 'sk-test',
        },
      ],
    });
    const plan = buildGrokSpawnPlan(rt, { grokHomeDir: '/tmp/gh' });
    assert.equal(plan.isThirdParty, true);
    assert.equal(plan.reasoningEffort, 'medium');
    assert.deepEqual(plan.args, [
      'agent',
      '--reasoning-effort',
      'medium',
      '-m',
      THIRD_PARTY_MODEL_ALIAS,
      'stdio',
    ]);
    assert.equal(plan.envPatch.GROK_HOME, '/tmp/gh');
    assert.ok(plan.clearEnvKeys.includes('XAI_API_KEY'));
    assert.match(plan.configToml || '', /gpt-5\.6-luna/);
    assert.match(plan.configToml || '', /dmxapi\.cn\/v1/);
    assert.match(plan.configToml || '', /sk-test/);
  });

  it('buildThirdPartyConfigToml disables stream_tool_calls for gateways', () => {
    const t = buildThirdPartyConfigToml({
      model: 'gpt-4o-mini',
      baseUrl: 'https://www.dmxapi.cn/v1',
      apiKey: 'sk-x',
      label: 'DMX',
    });
    assert.match(t, /stream_tool_calls = false/);
    assert.match(t, /api_backend = "chat_completions"/);
  });

  it('buildThirdPartyConfigToml quotes safely', () => {
    const t = buildThirdPartyConfigToml({
      model: 'gpt-4o',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-"x"',
      label: 'Ex',
    });
    assert.match(t, /api_key = "sk-\\"x\\""/);
  });

  it('validateGrokRuntime requires key for third-party', () => {
    const err = validateGrokRuntime({
      profileId: 'p',
      label: 'p',
      model: 'm',
      baseUrl: 'https://x/v1',
      apiKey: '',
      binPath: 'g',
      isThirdParty: true,
      reasoningEffort: '',
    });
    assert.match(err || '', /API Key/);
  });

  it('buildGrokAgentArgs places model and base before stdio (legacy)', () => {
    const args = buildGrokAgentArgs({
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
      reasoningEffort: 'low',
    });
    assert.deepEqual(args, [
      'agent',
      '--reasoning-effort',
      'low',
      '-m',
      'gpt-4o-mini',
      '--xai-api-base-url',
      'https://api.example.com/v1',
      '--cli-chat-proxy-base-url',
      'https://api.example.com/v1',
      'stdio',
    ]);
  });

  it('buildGrokChildEnv third-party clears ambient keys', () => {
    const env = buildGrokChildEnv(
      { PATH: '/bin', XAI_API_KEY: 'super', HOME: '/h' },
      { isThirdParty: true, grokHome: '/tmp/gh' }
    );
    assert.equal(env.PATH, '/bin');
    assert.equal(env.XAI_API_KEY, undefined);
    assert.equal(env.GROK_HOME, '/tmp/gh');
  });

  it('grokRuntimeSignature changes when model or key or effort changes', () => {
    const a = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokProfiles: DEFAULT_GROK_PROFILES,
    });
    const b = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokProfiles: [{ ...DEFAULT_GROK_PROFILES[0], model: 'other' }],
    });
    const c = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokReasoningEffort: 'high',
      grokProfiles: DEFAULT_GROK_PROFILES,
    });
    assert.notEqual(grokRuntimeSignature(a), grokRuntimeSignature(b));
    assert.notEqual(grokRuntimeSignature(a), grokRuntimeSignature(c));
  });

  it('formatGrokRuntimeLabel shows host for third-party and effort', () => {
    const label = formatGrokRuntimeLabel({
      profileId: 'x',
      label: 'GPT-5.6 Luna',
      model: 'gpt-5.6-luna',
      baseUrl: 'https://www.dmxapi.cn/v1',
      apiKey: '',
      binPath: 'g',
      isThirdParty: true,
      reasoningEffort: 'high',
    });
    assert.match(label, /GPT-5\.6 Luna/);
    assert.match(label, /dmxapi/);
    assert.match(label, /思考高/);
  });
});
