import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGrokProfiles,
  resolveGrokRuntime,
  buildGrokAgentArgs,
  buildGrokChildEnv,
  buildGrokSpawnPlan,
  buildThirdPartyConfigToml,
  normalizeOpenAiBaseUrl,
  grokRuntimeSignature,
  formatGrokRuntimeLabel,
  validateGrokRuntime,
  THIRD_PARTY_MODEL_ALIAS,
  DEFAULT_GROK_PROFILES,
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

  it('normalizeGrokProfiles always includes supergrok', () => {
    const p = normalizeGrokProfiles([
      { id: 'cheap', label: 'DMX', model: 'gpt-4o-mini', baseUrl: 'https://x' },
    ]);
    assert.equal(p[0].id, 'supergrok');
    assert.equal(p.some((x) => x.id === 'cheap'), true);
    assert.equal(p.find((x) => x.id === 'cheap')?.baseUrl, 'https://x/v1');
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

  it('buildGrokSpawnPlan third-party uses alias and isolated home flags', () => {
    const rt = resolveGrokRuntime({
      grokActiveProfile: 'p',
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
    assert.deepEqual(plan.args, ['agent', '-m', THIRD_PARTY_MODEL_ALIAS, 'stdio']);
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
    });
    assert.match(err || '', /API Key/);
  });

  it('buildGrokAgentArgs places model and base before stdio (legacy)', () => {
    const args = buildGrokAgentArgs({
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.example.com/v1',
    });
    assert.deepEqual(args, [
      'agent',
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

  it('grokRuntimeSignature changes when model or key changes', () => {
    const a = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokProfiles: DEFAULT_GROK_PROFILES,
    });
    const b = resolveGrokRuntime({
      grokActiveProfile: 'supergrok',
      grokProfiles: [{ ...DEFAULT_GROK_PROFILES[0], model: 'other' }],
    });
    assert.notEqual(grokRuntimeSignature(a), grokRuntimeSignature(b));
  });

  it('formatGrokRuntimeLabel shows host for third-party', () => {
    const label = formatGrokRuntimeLabel({
      profileId: 'x',
      label: 'DMX',
      model: 'm',
      baseUrl: 'https://www.dmxapi.cn/v1',
      apiKey: '',
      binPath: 'g',
      isThirdParty: true,
    });
    assert.match(label, /DMX/);
    assert.match(label, /dmxapi/);
  });
});
