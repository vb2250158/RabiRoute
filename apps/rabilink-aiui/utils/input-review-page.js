// Read-only presentation of the ledger. Opening a record never recovers or submits it.
const statusLabels = {
  retained: '原话已保留', submitted: '处理结果待确认', deferred: '等待后续处理',
  running: '正在处理', answered: '答案已保存', completed: '助手轮已结束', unconfirmed: '结果未确认，请核对原任务'
};

// Bound each frame to two short lines, including whitespace and supplementary characters.
function inputReviewLines(text) {
  const lines = []; let chunk = '', columns = 0;
  for (const char of String(text)) {
    chunk += char;
    if (char === '\n' || ++columns >= 24) {
      lines.push(chunk); chunk = ''; columns = 0;
    }
  }
  if (chunk || !lines.length) lines.push(chunk);
  return lines;
}
export function inputReviewPages(text) {
  const lines = inputReviewLines(text), pages = [];
  for (let index = 0; index < lines.length; index += 2) pages.push(lines.slice(index, index + 2).join(''));
  return pages;
}

export const inputReviewPageMethods = {
  refreshAiuiInputReview(recordDelta = 0, pageDelta = 0) {
    if (this.destroyed) return;
    try {
      const rows = this.inputLedger().snapshot();
      const selected = rows.findIndex(row => row.id === this.data.inputReviewId);
      const index = Math.max(0, Math.min(rows.length - 1, (selected < 0 ? rows.length - 1 : selected) + recordDelta));
      const row = rows[index];
      const pages = inputReviewPages(row ? `你：${row.text}${row.answer ? '\n回复：' + row.answer : ''}` : '暂无语音输入记录');
      const previousPage = row?.id === this.data.inputReviewId && !recordDelta ? Number(this.data.inputReviewPage || 0) : 0;
      const page = Math.max(0, Math.min(pages.length - 1, previousPage + pageDelta));
      const lines = inputReviewLines(pages[page]).map(line => line.replace(/[\r\n]/g, '').replace(/\t/g, ' '));
      this.setData({ inputRecordCount: rows.length, inputRecordError: false, inputReviewId: row?.id || '', inputReviewPage: page,
        inputReviewTitle: row ? `语音记录 ${index + 1}/${rows.length}` : '语音记录',
        inputReviewStatus: row ? statusLabels[row.status] : '没有保存的独立输入',
        inputReviewText: pages[page], inputReviewLineOne: lines[0] || '', inputReviewLineTwo: lines[1] || '',
        inputReviewPosition: `${page + 1}/${pages.length}`,
        inputReviewPreviousRecord: index > 0, inputReviewNextRecord: index + 1 < rows.length,
        inputReviewPreviousPage: page > 0, inputReviewNextPage: page + 1 < pages.length });
    } catch (_) {
      this.setData({ inputRecordError: true, inputReviewTitle: '语音记录', inputReviewStatus: '读取失败，请检查设备存储',
        inputReviewId: '', inputReviewText: '', inputReviewLineOne: '', inputReviewLineTwo: '', inputReviewPosition: '', inputReviewPreviousRecord: false,
        inputReviewNextRecord: false, inputReviewPreviousPage: false, inputReviewNextPage: false });
    }
  },
  openAiuiInputReview() {
    if (this.destroyed || !this.pageVisible) return;
    this.refreshAiuiInputReview();
    this.setData({ inputReviewOpen: true });
  },
  closeAiuiInputReview() { this.setData({ inputReviewOpen: false }); },
  previousAiuiInputRecord() { this.refreshAiuiInputReview(-1); },
  nextAiuiInputRecord() { this.refreshAiuiInputReview(1); },
  previousAiuiInputPage() { this.refreshAiuiInputReview(0, -1); },
  nextAiuiInputPage() { this.refreshAiuiInputReview(0, 1); },
  consumeAiuiInputReviewTap() {},
  handleAiuiInputReviewKey(code, event) {
    const actions = { arrowleft: 'previousAiuiInputRecord', arrowright: 'nextAiuiInputRecord',
      arrowup: 'previousAiuiInputPage', arrowdown: 'nextAiuiInputPage', enter: 'closeAiuiInputReview',
      globalhook: 'closeAiuiInputReview', backspace: 'closeAiuiInputReview' };
    const action = actions[code];
    if (action) { this[action](); event?.preventDefault?.(); }
  }
};
