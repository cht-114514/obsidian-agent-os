import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeFeedbackId,
  normalizeVote,
  formatFeedbackEntry,
  parseFeedbackFile,
  replaceFeedbackSection,
  setVoteInFile,
  setNoteInFile,
  feedbackDayMeta,
} from '../src/feedback-store.js';

describe('feedback-store pure', () => {
  it('makeFeedbackId is unique-ish', () => {
    const a = makeFeedbackId();
    const b = makeFeedbackId();
    assert.match(a, /^f_/);
    assert.notEqual(a, b);
  });

  it('normalizeVote', () => {
    assert.equal(normalizeVote('up'), '👍');
    assert.equal(normalizeVote('down'), '👎');
    assert.equal(normalizeVote('note'), '📝');
    assert.equal(normalizeVote(null), null);
  });

  it('format + parse roundtrip', () => {
    const id = 'f_test_1';
    const section = formatFeedbackEntry({
      id,
      time: '12:34',
      vote: '👍',
      excerpt: 'hello\nworld',
      note: '少用客服腔',
    });
    const file = `# Feedback 2026-07-23\n${section}`;
    const entries = parseFeedbackFile(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].vote, '👍');
    assert.equal(entries[0].time, '12:34');
    assert.match(entries[0].excerpt, /hello/);
    assert.equal(entries[0].note, '少用客服腔');
  });

  it('replace deletes and updates vote', () => {
    const id = 'f_a';
    const s1 = formatFeedbackEntry({
      id,
      time: '10:00',
      vote: '👍',
      excerpt: 'msg',
    });
    const s2 = formatFeedbackEntry({
      id: 'f_b',
      time: '10:01',
      vote: '👎',
      excerpt: 'other',
    });
    let md = `# Feedback\n${s1}${s2}`;
    const up = setVoteInFile(md, id, '👎');
    assert.equal(up.found, true);
    let e = parseFeedbackFile(up.md).find((x) => x.id === id);
    assert.equal(e.vote, '👎');
    assert.equal(parseFeedbackFile(up.md).length, 2);

    const del = replaceFeedbackSection(up.md, id, null);
    assert.equal(del.found, true);
    assert.equal(parseFeedbackFile(del.md).length, 1);
    assert.equal(parseFeedbackFile(del.md)[0].id, 'f_b');
  });

  it('setNoteInFile attaches user note', () => {
    const id = 'f_n';
    const s = formatFeedbackEntry({
      id,
      time: '11:00',
      vote: '📝',
      excerpt: 'agent reply',
    });
    const md = `# F\n${s}`;
    const r = setNoteInFile(md, id, '以后更简洁', '👎');
    assert.equal(r.found, true);
    const e = parseFeedbackFile(r.md)[0];
    assert.equal(e.note, '以后更简洁');
    assert.equal(e.vote, '👎');
  });

  it('feedbackDayMeta path', () => {
    const m = feedbackDayMeta(new Date('2026-07-23T08:00:00'));
    assert.equal(m.path, 'agent-inbox/soul/feedback/2026-07-23.md');
  });
});
