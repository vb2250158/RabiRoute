import wx from 'wx';
import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { createModelHistory } from './model-history.js';

function visibleMessage(content) {
  try {
    const value = JSON.parse(content);
    if (value.protocol === 'rabi-agent/v1') return typeof value.text === 'string' ? value.text : '';
  } catch (_) { /* Plain language is a supported model answer. */ }
  return content;
}

export const modelHistoryPageMethods = {
  modelHistory() {
    const scope = sha256Text(JSON.stringify([this.data.lingzhuAgentId || '',
      this.data.lingzhuSystemPrompt || '', this.deviceAgentProfile?.personaRef || null]));
    if (this.aiuiModelHistoryScope !== scope) {
      this.aiuiModelHistory = createModelHistory({ scope,
        read: key => wx.getStorageSync(key), write: (key, value) => wx.setStorageSync(key, value) });
      this.aiuiModelHistoryScope = scope;
    }
    return this.aiuiModelHistory;
  },
  localConversationRows() {
    const rows = [];
    for (const row of this.modelHistory().recent(64)) {
      const message = row.input.find(item => item.role === 'user');
      if (!message) continue;
      let text;
      try {
        const input = JSON.parse(message.content);
        // Tool observations remain model context, never visible user bubbles.
        if (input.kind === 'user-input') text = input.text;
      } catch (_) { text = message.content; }
      if (typeof text === 'string' && text) rows.push({ id: 'history-' + row.sequence,
        text, answer: '', status: 'unconfirmed' });
      const selected = rows[rows.length - 1];
      if (selected && row.state === 'completed') {
        const answer = visibleMessage(row.text);
        if (answer) { selected.answer = answer; selected.status = 'answered'; }
      }
    }
    return rows;
  }
};
