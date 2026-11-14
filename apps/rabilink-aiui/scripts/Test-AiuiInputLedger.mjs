import test from 'node:test';
import assert from 'node:assert/strict';
import { createAiuiInputLedger } from '../utils/aiui-input-ledger.js';
import { inputReviewPageMethods, inputReviewPages } from '../utils/input-review-page.js';

function store() {
  let state;
  return { read: () => state === undefined ? undefined : structuredClone(state), write: value => { state = structuredClone(value); } };
}
const result = (input, status, text) => ({ input, status, modelInvoked: !['returned','unavailable'].includes(status), toolDispatched: false, ...(text ? { text } : {}) });

function review(ledger) {
  return { ...inputReviewPageMethods, pageVisible: true, data: {}, inputLedger: () => ledger,
    setData(patch) { Object.assign(this.data, patch); } };
}

test('review pagination preserves complete Unicode and multiline text with a bounded frame', () => {
  for (const text of ['中文𠮷🙂'.repeat(4000), '第一行\n\n第二行\r\n'.repeat(100), '', 'a'.repeat(16000)]) {
    const pages = inputReviewPages(text);
    assert.equal(pages.join(''), text);
    assert.ok(pages.every(page => Array.from(page).length <= 48 && page.split('\n').length <= 3));
  }
});

test('viewing every retained input and saved answer is read-only even during a live reservation', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage);
  const first = ledger.retain('第一条', 'old-scope'); ledger.submit(first);
  const second = ledger.retain('第二条'.repeat(50), 'other-scope'); ledger.submit(second);
  ledger.settle(second, result(second, 'answered', '保存的答案'.repeat(30)));
  const before = storage.read(), p = review(ledger); p.openAiuiInputReview();
  assert.equal(p.data.inputRecordCount, 2); assert.equal(p.data.inputReviewId, second.id);
  let full = p.data.inputReviewText;
  while (p.data.inputReviewNextPage) { p.nextAiuiInputPage(); full += p.data.inputReviewText; }
  assert.equal(full, `你：${second.text}\n回复：${before.rows[1].answer}`);
  p.previousAiuiInputRecord(); assert.equal(p.data.inputReviewId, first.id); assert.equal(p.data.inputReviewPage, 0);
  p.previousAiuiInputRecord(); assert.equal(p.data.inputReviewId, first.id);
  p.closeAiuiInputReview(); p.openAiuiInputReview(); assert.equal(p.data.inputReviewId, first.id);
  assert.deepEqual(storage.read(), before, 'Viewing must not call recover() or mutate active submitted rows');
  const snapshot = ledger.snapshot(); snapshot[0].status = 'completed'; assert.deepEqual(storage.read(), before);
});

test('new records do not steal the selected entry; live settlement refreshes its saved result', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage), input = ledger.retain('问题', 'owner');
  ledger.submit(input); const p = review(ledger); p.openAiuiInputReview();
  ledger.retain('另一个问题', 'owner'); p.refreshAiuiInputReview();
  assert.equal(p.data.inputReviewId, input.id); assert.equal(p.data.inputRecordCount, 2);
  ledger.settle(input, result(input, 'answered', '答案')); p.refreshAiuiInputReview();
  assert.equal(p.data.inputReviewStatus, '答案已保存'); assert.match(p.data.inputReviewText, /答案/);
});

test('read failure clears stale detail and viewing malformed answers never changes storage', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage); ledger.retain('隐私原话', 'owner');
  const p = review(ledger); p.openAiuiInputReview();
  const broken = storage.read(); broken.rows[0].answer = {}; storage.write(broken); p.refreshAiuiInputReview();
  assert.match(p.data.inputReviewStatus, /读取失败/); assert.equal(p.data.inputReviewText, '');
  assert.equal(p.data.inputReviewNextPage, false); assert.deepEqual(storage.read(), broken);
});

test('a fresh ledger reads original input after restart and never turns uncertain work into a new run', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage);
  const first = ledger.retain('原输入', 'original-owner', { turnId: 'history-1' }); ledger.submit(first);
  const next = createAiuiInputLedger(storage), rows = next.recover();
  assert.equal(rows[0].status, 'unconfirmed'); assert.equal(rows[0].id, first.id); assert.equal(rows[0].text, first.text);
  assert.equal(rows[0].ticket.turnId, 'history-1'); assert.throws(() => next.beginRun(first), /STATE_CONFLICT/);
  const second = next.retain('另一个输入', 'original-owner'); assert.notEqual(second.id, first.id);
});

test('defer preserves input identity through a single reserved run and completion cannot run again', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage), input = ledger.retain('任务', 'owner');
  ledger.submit(input); ledger.settle(input, result(input, 'deferred')); ledger.beginRun(input);
  assert.throws(() => ledger.beginRun(input), /STATE_CONFLICT/);
  ledger.finishRun(input, { state: 'completed', text: '实际回复' });
  assert.throws(() => ledger.beginRun(input), /STATE_CONFLICT/);
  assert.equal(createAiuiInputLedger(storage).recover().length, 0);
  assert.equal(storage.read().rows[0].answer, '实际回复');
});

test('mismatched receipts, uncertain tool outcomes and failed readback never certify completion', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage), input = ledger.retain('任务', 'owner'); ledger.submit(input);
  assert.throws(() => ledger.settle(input, result({ ...input, scope: 'another' }, 'answered', 'wrong')), /RECEIPT_INVALID/);
  ledger.settle(input, result(input, 'returned')); ledger.beginRun(input); ledger.finishRun(input, { state: 'uncertain', text: '待核对' });
  assert.equal(ledger.recover()[0].status, 'unconfirmed');
  const noWrites = createAiuiInputLedger({ read: () => undefined, write() {} });
  assert.throws(() => noWrites.retain('不能保存', 'owner'), /STORAGE_FAILED/);
});

test('capacity never evicts unfinished inputs and malformed durable state fails closed', () => {
  const storage = store(), ledger = createAiuiInputLedger(storage);
  for (let n = 0; n < 64; n++) ledger.retain('输入' + n, 'owner');
  assert.throws(() => ledger.retain('溢出', 'owner'), /STORAGE_FULL/); assert.equal(ledger.recover().length, 64);
  const row = storage.read().rows[0]; ledger.submit(row); ledger.settle(row, result(row, 'answered', '已生成'));
  ledger.retain('新增', 'owner'); assert.equal(storage.read().rows.length, 64);
  assert.equal(storage.read().rows.some(item => item.id === row.id), false);
  const broken = storage.read(); broken.rows[1].id = broken.rows[0].id; storage.write(broken);
  assert.throws(() => ledger.recover(), /STORAGE_INVALID/);
});
