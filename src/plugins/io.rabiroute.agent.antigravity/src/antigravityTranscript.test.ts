import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { antigravityTranscriptPath, readAntigravityHistory, readAntigravityTranscript, type AntigravityTranscriptMessage } from './antigravityTranscript.js';

/** A transcript fixture shaped exactly like a real `transcript_full.jsonl`. */
function fixture(lines: readonly Record<string, unknown>[], id = '11111111-2222-3333-4444-555555555555') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-transcript-'));
  const logs = path.join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'), lines.map(line => JSON.stringify(line)).join('\n'), 'utf8');
  return { home, id };
}

const user = (text: string, at = '2026-09-21T10:28:08Z') => ({
  source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: at,
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>`
});
const answer = (text: string, at = '2026-09-21T10:28:18Z') => ({ source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: at, content: text });

test('a transcript yields only the user request and the model prose', () => {
  const { home, id } = fixture([
    user('谷歌搜索也算额度吗'),
    answer('取决于你用的是 API 还是网页端。'),
    // A planner frame with tool calls has no prose and must not become a message.
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-09-21T10:28:09Z' },
    // Injection and settings frames are execution detail, not conversation.
    { source: 'SYSTEM', type: 'GENERIC', created_at: '2026-09-21T10:28:09Z', content: 'system note' }
  ]);
  const messages = readAntigravityTranscript(id, home);
  assert.deepEqual(messages.map((message: AntigravityTranscriptMessage) => [message.role, message.text]), [
    ['user', '谷歌搜索也算额度吗'],
    ['assistant', '取决于你用的是 API 还是网页端。']
  ]);
  assert.equal(messages[0]!.time, '2026-09-21T10:28:08Z');
});

test('the envelope around a user request is stripped, not shown as text', () => {
  const { home, id } = fixture([user('请总结这份文档')]);
  const [message] = readAntigravityTranscript(id, home);
  assert.equal(message!.text, '请总结这份文档');
  assert.doesNotMatch(message!.text, /USER_REQUEST|ADDITIONAL_METADATA/);
});

test('history pages the newest turn and leaves the rest behind a cursor', () => {
  const { home, id } = fixture(Array.from({ length: 10 }, (_, index) => [
    user(`问 ${index}`, `2026-09-21T10:0${index}:00Z`), answer(`答 ${index}`, `2026-09-21T10:0${index}:30Z`)
  ]).flat());
  const page = readAntigravityHistory(id, { limit: 4, homeDir: home });
  assert.equal(page.entries.length, 4);
  assert.deepEqual(page.entries.map((entry: { record: { content: Array<{ text: string }> } }) => entry.record.content[0]!.text), ['问 8', '答 8', '问 9', '答 9']);
  assert.equal(page.nextCursor, '16');
  // The shared reader recognizes this envelope, so the rows render without a new contract.
  assert.equal(page.entries[0]!.record.role, 'user');
  assert.equal(page.entries[1]!.record.role, 'assistant');
  assert.equal(page.entries[0]!.record.content[0]!.type, 'input_text');
});

test('a missing or malformed id never throws and returns no rows', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-empty-'));
  assert.equal(antigravityTranscriptPath('not-a-uuid', home), undefined);
  assert.deepEqual(readAntigravityTranscript('not-a-uuid', home), []);
  assert.deepEqual(readAntigravityTranscript('11111111-2222-3333-4444-555555555555', home), []);
  assert.deepEqual(readAntigravityHistory('11111111-2222-3333-4444-555555555555', { homeDir: home }), { entries: [], nextCursor: null });
});

test('a corrupt line is skipped instead of failing the whole transcript', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-corrupt-'));
  const id = '11111111-2222-3333-4444-555555555555';
  const logs = path.join(home, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'transcript_full.jsonl'),
    [JSON.stringify(user('第一个问题')), '{ broken json', JSON.stringify(answer('正常回复'))].join('\n'), 'utf8');
  const messages = readAntigravityTranscript(id, home);
  assert.deepEqual(messages.map((message: AntigravityTranscriptMessage) => message.role), ['user', 'assistant']);
});

test('both frame shapes carry the answer, because builds differ in where the prose lives', () => {
  // Observed: one build puts the answer in PLANNER_RESPONSE, another in GENERIC.
  const { home, id } = fixture([
    user('优化这个 HTML'),
    { source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-09-24T08:48:00Z', content: '' },
    { source: 'MODEL', type: 'GENERIC', created_at: '2026-09-24T08:48:05Z', content: '这里是重写后的版本。' }
  ]);
  const messages = readAntigravityTranscript(id, home);
  assert.deepEqual(messages.map((message: AntigravityTranscriptMessage) => [message.role, message.text]), [
    ['user', '优化这个 HTML'],
    ['assistant', '这里是重写后的版本。']
  ]);
});
