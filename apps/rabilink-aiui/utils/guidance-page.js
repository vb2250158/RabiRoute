import { transcriptFingerprint } from './transcript-policy.js';
import { createAiuiInputLedger } from './aiui-input-ledger.js';
import { getAgentProtocolFailureReason } from './agent-decision-protocol.js';
export const guidancePageMethods = {
  inputLedger() {
    if (!this.aiuiInputLedger) this.aiuiInputLedger = createAiuiInputLedger({
      read: () => this.readAiuiInputState(), write: value => this.writeAiuiInputState(value)
    });
    return this.aiuiInputLedger;
  },
  recoverAiuiInputs() {
    try {
      const pending = this.inputLedger().recover();
      this.refreshAiuiInputReview?.();
      if (pending.length) this.setData({ agentStatus: `${pending.length} 条语音待核对，未自动重放`, assistantReplyText: pending[pending.length - 1].text, agentReplyText: pending[pending.length - 1].text });
    } catch (_) { this.setData({ agentStatus: '语音任务记录读取失败，请检查设备存储' }); }
  },
  isAiuiPlaybackEcho(text) {
    const value = transcriptFingerprint(text), playing = transcriptFingerprint(this.aiuiPlaybackText || '');
    return !!value && !!playing && (value === playing || (value.length >= 4 && playing.includes(value)));
  },
  stopAiuiPlaybackForInput(text) {
    if (!String(text || '').trim() || ((this.speechActive || this.data.agentSpeaking) && this.isAiuiPlaybackEcho(text))) return false;
    this.interruptAiuiPlayback('transcript');
    return true;
  },
  interruptAiuiPlayback(reason = 'input', fromVoice = false) {
    if (!fromVoice && this.voiceInteraction) return this.voiceInteraction.interruptSpeech(reason);
    this.aiuiOutputEpoch = Number(this.aiuiOutputEpoch || 0) + 1;
    if (this.deviceAgentTurnActive) {
      if (!this.aiuiSpeechSuppressed) console.info('[RabiLink AIUI] speech:suppressed', reason);
      this.aiuiSpeechSuppressed = true;
    }
    if (fromVoice || this.speechActive || this.data.agentSpeaking) {
      this.cancelSpeech();
      this.setData({ agentStatus: this.deviceAgentTurnActive ? '已停播，推理继续；等待完整引导' : '正在聆听' });
    }
  },
  enqueueAiuiGuidance(text) {
    const queue = this.aiuiGuidanceQueue || [];
    if (queue.length >= 16 || String(text).length > 16000) { this.setData({ agentStatus: '引导队列已满，请稍后输入' }); return false; }
    const ticket = this.beginAiuiConversation?.(text) || null;
    const owner = this.aiuiTurnInputOwner;
    if (owner && ['executing-tool','interjecting','waiting-tool'].includes(this.chatTurnRuntime?.getState?.().turn?.state)) {
      try {
        owner.assertCurrent();
        const input = this.inputLedger().retain(text, owner.scope, ticket);
        this.refreshAiuiInputReview?.();
        const entry = { text, ticket, input, owner, phase: 'pending', outputEpoch: Number(this.aiuiOutputEpoch || 0) + 1 };
        this.aiuiOutputEpoch = entry.outputEpoch;
        this.aiuiGuidanceQueue = [...queue, entry];
        this.aiuiSpeechSuppressed = true;
        this.setData({ agentStatus: '已保存新输入，原任务继续' });
        void this.processAiuiInterjection(entry);
        return true;
      } catch (_) {
        this.setData({ agentStatus: '新输入未提交，请检查连接或设备存储', assistantReplyText: text, agentReplyText: text });
        return false;
      }
    }
    this.aiuiGuidanceQueue = [...queue, { text, ticket }];
    this.aiuiSpeechSuppressed = true;
    this.chatTurnRuntime?.notifyGuidance?.();
    this.setData({ agentStatus: '引导已接收，当前推理继续；下一步采用' });
    return true;
  },
  async processAiuiInterjection(entry) {
    try {
      this.inputLedger().submit(entry.input);
      this.refreshAiuiInputReview?.();
      const result = await this.chatTurnRuntime.interject(entry.input, { assertCurrent: entry.owner.assertCurrent });
      const protocolFailureReason = getAgentProtocolFailureReason(result);
      if (protocolFailureReason) console.warn('[RabiLink AIUI] interjection validation failed:', protocolFailureReason);
      this.inputLedger().settle(entry.input, result);
      if (['deferred','returned','unavailable'].includes(result.status)) {
        entry.phase = 'queued';
        this.drainAiuiGuidance();
        return;
      }
      this.aiuiGuidanceQueue = (this.aiuiGuidanceQueue || []).filter(item => item !== entry);
      if (result.status === 'answered') {
        this.finishAiuiConversation?.(entry.ticket, result.text);
        entry.owner.assertCurrent();
        if (this.aiuiOutputEpoch !== entry.outputEpoch || this.aiuiRuntime?.getState().inputPending) return;
        this.setData({ agentReplyText: result.text, assistantReplyText: result.text, agentStatus: '已回应，原任务继续' });
        this.aiuiSpeechSuppressed = false;
        this.speakText(result.text, 'enqueue');
      } else if (!this.destroyed && this.pageVisible) this.setData({ agentStatus: '新输入处理未确认，已保留原话；未自动重试' });
    } catch (_) {
      this.aiuiGuidanceQueue = (this.aiuiGuidanceQueue || []).filter(item => item !== entry);
      if (!this.destroyed && this.pageVisible) this.setData({ agentStatus: '新输入记录或归属未确认，未自动重试' });
    } finally {
      this.refreshAiuiInputReview?.();
      if (!this.deviceAgentTurnActive) {
        this.drainAiuiGuidance(); this.resumeDeviceAgentClaim?.();
        if (!this.destroyed && this.pageVisible && !this.deviceAgentTurnActive && !this.aiuiGuidanceQueue?.length) this.applyPendingDeviceAgentProfile();
      }
    }
  },
  drainAiuiGuidance() {
    if (this.destroyed || !this.pageVisible || this.deviceAgentTurnActive || !this.aiuiGuidanceQueue?.length) return;
    const next = this.aiuiGuidanceQueue.shift();
    if (next.input && next.phase !== 'queued') { this.aiuiGuidanceQueue.unshift(next); return; }
    if (next.input) {
      try { next.owner.assertBinding(); }
      catch (_) { this.setData({ agentStatus: '原连接已变更，新输入已保留；未转交其他任务' }); this.drainAiuiGuidance(); return; }
    }
    void this.executeLingzhuAgentPrompt(next.text, { guided: true, ticket: next.ticket, inputEntry: next.input ? next : null });
  }
};
