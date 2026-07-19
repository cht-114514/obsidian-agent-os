import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGrokSkillPrompt,
  isGrokSkill,
  loadSkillMarkdown,
  FALLBACK_SKILLS,
} from '../src/skill-prompt.js';

describe('skill-prompt', () => {
  it('recognizes slash skills', () => {
    assert.equal(isGrokSkill('me-digest'), true);
    assert.equal(isGrokSkill('memorized'), true);
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
      'me-care-check',
      'me-soul-promote',
      'memorized',
      'me-reindex',
      'me-apply-pending',
      'me-apply-insight',
    ]) {
      assert.equal(isGrokSkill(id), true);
      assert.ok(FALLBACK_SKILLS[id] || FALLBACK_SKILLS.memorized);
    }
  });
});
