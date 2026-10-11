import { transcriptFingerprint } from './transcript-policy.js';
export const guidancePageMethods = {
  isAiuiPlaybackEcho(text) {
    const value = transcriptFingerprint(text), playing = transcriptFingerprint(this.aiuiPlaybackText || '');
    return !!value && !!playing && (value === playing || (value.length >= 4 && playing.includes(value)));
  },
  stopAiuiPlaybackForInput(text) {
    if (!String(text || '').trim() || ((this.speechActive || this.data.agentSpeaking) && this.isAiuiPlaybackEcho(text))) return false;
    if (this.deviceAgentTurnActive) this.aiuiSpeechSuppressed = true;
    if (this.speechActive || this.data.agentSpeaking) {
      this.cancelSpeech();
      this.setData({ agentStatus: this.deviceAgentTurnActive ? '已停播，推理继续；等待完整引导' : '正在聆听' });
    }
    return true;
  },
  enqueueAiuiGuidance(text) {
    const queue = this.aiuiGuidanceQueue || [];
    if (queue.length >= 16 || String(text).length > 16000) { this.setData({ agentStatus: '引导队列已满，请稍后输入' }); return false; }
    const ticket = this.beginAiuiConversation?.(text) || null;
    this.aiuiGuidanceQueue = [...queue, { text, ticket }];
    this.aiuiSpeechSuppressed = true;
    this.setData({ agentStatus: '引导已接收，当前推理继续；下一步采用' });
    return true;
  },
  drainAiuiGuidance() {
    if (this.destroyed || !this.pageVisible || this.deviceAgentTurnActive || !this.aiuiGuidanceQueue?.length) return;
    const next = this.aiuiGuidanceQueue.shift();
    void this.executeLingzhuAgentPrompt(next.text, { guided: true, ticket: next.ticket });
  }
};
