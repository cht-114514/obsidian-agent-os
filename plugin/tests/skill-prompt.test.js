import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrokSkillPrompt,
  isGrokSkill,
  loadSkillMarkdown,
  FALLBACK_SKILLS,
  parseSlashSkillCommand,
} from '../src/skill-prompt.js';

describe('skill-prompt', () => {
  it('recognizes slash skills', () => {
    assert.equal(isGrokSkill('me-digest'), true);
    assert.equal(isGrokSkill('memorized'), true);
    assert.equal(isGrokSkill('me-imagine'), true);
    assert.equal(isGrokSkill('__new'), false);
  });

  it('buildGrokSkillPrompt includes skill body, confirm protocol, user intent', () => {
    const p = buildGrokSkillPrompt({
      skillId: 'me-digest',
      skillMd: FALLBACK_SKILLS['me-digest'],
      userText: '把所有日记消化一下',
      contextBlock: '## 附带上下文\n\nhello',
      activePath: '手记/x.md',
    });
    assert.match(p, /Skill execution: \/me-digest/);
    assert.match(p, /:::confirm/);
    assert.match(p, /把所有日记消化一下/);
    assert.match(p, /手记\/x\.md/);
    assert.match(p, /附带上下文/);
    assert.match(p, /Grok Build/);
  });

  it('buildGrokSkillPrompt injects prior conversation for deixis', () => {
    const p = buildGrokSkillPrompt({
      skillId: 'me-imagine',
      skillMd: FALLBACK_SKILLS['me-imagine'],
      userText: '输出该物理模型的简要图像',
      contextBlock: '',
      conversation:
        '### 用户\n质量 m 在倾角 θ 木板上\n\n### 助手\n受力：mg sinθ …',
    });
    assert.match(p, /本会话此前对话/);
    assert.match(p, /倾角 θ 木板/);
    assert.match(p, /不要转去搜索其它笔记/);
    assert.match(p, /输出该物理模型的简要图像/);
  });

  it('loadSkillMarkdown falls back when readFile misses', async () => {
    const md = await loadSkillMarkdown('me-digest', async () => null);
    assert.match(md, /me-digest/);
    assert.match(md, /pending_review/);
  });

  it('loadSkillMarkdown uses vault file when present', async () => {
    const md = await loadSkillMarkdown('me-care-check', async (rel) =>
      rel.includes('me-care-check') ? '# custom care\ncap=1\n' : null
    );
    assert.match(md, /custom care/);
  });

  it('me-reindex falls back to memorized skill body', async () => {
    const md = await loadSkillMarkdown('me-reindex', async () => null);
    assert.match(md, /type=memorized|memorized/i);
  });

  it('all grok skill ids have fallback bodies', () => {
    for (const id of [
      'me-digest',
      'me-write-insight',
      'me-reflect-feedback',
      'me-care-check',
      'me-soul-promote',
      'me-imagine',
      'memorized',
      'me-reindex',
      'me-apply-pending',
      'me-apply-insight',
    ]) {
      assert.equal(isGrokSkill(id), true);
      assert.ok(FALLBACK_SKILLS[id] || FALLBACK_SKILLS.memorized);
    }
  });

  it('parseSlashSkillCommand extracts skill + rest', () => {
    assert.deepEqual(parseSlashSkillCommand('/me-imagine 画火箭'), {
      skillId: 'me-imagine',
      rest: '画火箭',
    });
    assert.equal(parseSlashSkillCommand('/unknown x'), null);
    assert.equal(parseSlashSkillCommand('no slash'), null);
  });
});
