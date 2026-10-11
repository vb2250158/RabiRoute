// Presentation for the one generic API runtime. Persona selection is never an
// authorization filter, and refreshing this surface creates no business request.
export const apiResultPageMethods = {
  setKnowledgePageData(patch) {
    this.setData({ ...patch, ...(patch.knowledgeToolStatus ? { knowledgeToolHudText: patch.knowledgeToolStatus.slice(0, 22) } : {}) });
  },
  async refreshAgentAndApiTools() { await this.refreshDeviceAgentProfile(); await this.refreshApiTools(); await this.startDeviceAgentOwner?.(); },
  clearKnowledgeResultView() { this.knowledgeResultView = null; this.setData({ knowledgeToolResultText: '' }); },
  browseKnowledgeResultFromSpeech(text) {
    const command = String(text || '').trim().replace(/[。！!？?]$/, '');
    if (!['读出工具结果', '下一条工具结果'].includes(command)) return false;
    const view = this.knowledgeResultView;
    if (!view?.api || !view.confirmed || view.scope !== this.agentProfileScope(this.rabiApiConfig())) {
      this.clearKnowledgeResultView(); this.setKnowledgePageData({ knowledgeToolStatus: '没有当前连接已确认的工具记录' }); return true;
    }
    if (this.deviceAgentTurnActive || this.data.assistantModelBusy) { this.setKnowledgePageData({ knowledgeToolStatus: '正在回答，请稍后读出工具结果' }); return true; }
    if (!view.pages.length) { this.setKnowledgePageData({ knowledgeToolStatus: '工具记录无可展示正文' }); return true; }
    if (command === '下一条工具结果') view.index = Math.min(view.index + 1, view.pages.length - 1);
    const content = view.pages[view.index];
    this.setData({ agentReplyText: content, assistantReplyText: content });
    this.setKnowledgePageData({ knowledgeToolStatus: `工具记录 ${view.index + 1}/${view.pages.length}${view.truncated ? '（已限长）' : ''}` });
    this.speakText(`工具记录，第${view.index + 1}段。${content}`, 'enqueue');
    return true;
  },
  async refreshApiTools() {
    const config = this.rabiApiConfig();
    const scope = this.agentProfileScope(config);
    if (this.apiResultScope !== scope) { this.clearKnowledgeResultView(); this.apiResultScope = scope; this.apiToolsRebuildPending = true; }
    this.setKnowledgePageData({ knowledgeToolStatus: config ? 'Rabi 通用接口 · HTTP 中转，调用状态待核验' : 'Rabi 通用接口未连接' });
  },
  applyPendingApiTools() {
    if (!this.apiToolsRebuildPending || this.deviceAgentTurnActive || this.data.assistantModelBusy) return;
    this.cleanupChatModel(); this.apiToolsRebuildPending = false;
  }
};
