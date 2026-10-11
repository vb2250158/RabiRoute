import wx from 'wx';
import { recordAiuiConversation } from './rabilink-api.js';
const KEY = 'rabilink-aiui-conversation-outbox-v1';
export const aiuiConversationPageMethods = {
  recoverAiuiConversations() {
    try {
      const state = wx.getStorageSync(KEY);
      if (!Array.isArray(state?.rows)) return;
      wx.setStorageSync(KEY, { ...state, rows: state.rows.map(row => row.final ? row : { ...row, final: true, version: row.version + 1 }) });
      void this.flushAiuiConversations();
    } catch (_) { this.setData({ deviceAgentProfileStatus: "历史聊天记录待核对" }); }
  },
  beginAiuiConversation(userText) {
    const profile = this.deviceAgentProfile, config = this.deviceAgentProfileConfig();
    if (!profile?.personaRef || !config || this.deviceAgentProfileScope !== this.agentProfileScope(config)) return null;
    const state = wx.getStorageSync(KEY) || { counter: 0, rows: [] };
    if (!Array.isArray(state.rows) || state.rows.length >= 64 || !Number.isSafeInteger(state.counter) || state.counter < 0 || state.counter >= Number.MAX_SAFE_INTEGER) throw new Error('AIUI_HISTORY_STORAGE_FAILED');
    const scope = this.agentProfileScope(config), turnId = 'turn-' + (state.counter + 1);
    const seed = state.seed || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
    const row = { scope, turnId, sessionId: 'device-session-' + seed + ':' + (state.counter + 1), profileRevision: profile.revision,
      personaRef: profile.personaRef, userText, assistantText: null, version: 1, final: false, userConfirmed: false };
    wx.setStorageSync(KEY, { seed, counter: state.counter + 1, rows: [...state.rows, row] });
    void this.flushAiuiConversations();
    return { scope, turnId };
  },
  finishAiuiConversation(ticket, assistantText) {
    if (!ticket) return;
    try {
      const state = wx.getStorageSync(KEY);
      const rows = state.rows.map(row => row.scope === ticket.scope && row.turnId === ticket.turnId ? { ...row, assistantText: assistantText || null, final: true, version: row.version + 1 } : row);
      wx.setStorageSync(KEY, { ...state, rows });
      void this.flushAiuiConversations();
    } catch (_) { this.setData({ deviceAgentProfileStatus: '本轮聊天记录未保存，请检查设备存储' }); }
  },
  async flushAiuiConversations() {
    if (this.aiuiHistoryFlush) return this.aiuiHistoryFlush;
    const config = this.deviceAgentProfileConfig();
    if (!config) return;
    const scope = this.agentProfileScope(config);
    const running = (async () => {
      while (!this.destroyed) {
        const state = wx.getStorageSync(KEY);
        const row = state?.rows?.find(item => item.scope === scope && (item.final || !item.userConfirmed));
        if (!row) return;
        const version = row.version;
        try {
          const receipt = await recordAiuiConversation(config, { personaRef: row.personaRef, profileRevision: row.profileRevision, sessionId: row.sessionId, turnId: row.turnId,
            userText: row.userText, ...(row.assistantText ? { assistantText: row.assistantText } : {}) });
          if (scope !== this.agentProfileScope(this.deviceAgentProfileConfig()) || receipt.roleId !== row.personaRef.roleId || receipt.sourceDeviceId !== row.personaRef.sourceDeviceId) throw new Error('AIUI_HISTORY_SCOPE_CHANGED');
          const latest = wx.getStorageSync(KEY);
          const rows = latest.rows.flatMap(item => {
            if (item.scope !== scope || item.turnId !== row.turnId || item.version !== version) return [item];
            return item.final ? [] : [{ ...item, userConfirmed: true }];
          });
          wx.setStorageSync(KEY, { ...latest, rows });
          this.setData({ deviceAgentProfileStatus: '聊天记录已保存到当前使用的人格' });
        } catch (_) { this.setData({ deviceAgentProfileStatus: '聊天记录待同步，已保留原记录；下轮或刷新时再核对' }); return; }
      }
    })();
    this.aiuiHistoryFlush = running;
    try { await running; } finally { if (this.aiuiHistoryFlush === running) this.aiuiHistoryFlush = null; }
  }
};
