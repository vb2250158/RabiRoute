// Presentation and scheduling only. The task owner persists subscriptions,
// terminal facts and generated summaries before this page renders anything.
export const taskFollowPageMethods = {
  stopTaskFollow() {
    const owner = this.taskFollowSession;
    this.taskFollowSession = null;
    if (owner?.timer) clearTimeout(owner.timer);
    this.chatConversation?.dispose();
    this.chatConversation = null;
  },
  startTaskFollow() {
    const monitor = this.taskFollowRuntime, assistant = this.chatAssistant;
    if (!monitor || !assistant || this.taskFollowSession) return;
    const conversation = this.aiuiRuntime.createConversation({ scope: monitor.scope, receipts: monitor.receipts });
    this.chatConversation = conversation;
    const owner = { monitor, assistant, conversation, generated: new Set(), timer: null };
    this.taskFollowSession = owner;
    const current = () => this.taskFollowSession === owner && this.taskFollowRuntime === monitor
      && this.chatAssistant === assistant && this.pageVisible && !this.destroyed;
    const idle = () => current() && !this.deviceAgentTurnActive && !assistant.getState().busy
      && !this.aiuiRuntime.getState().inputPending && !this.aiuiGuidanceQueue?.length
      && !this.data.agentSpeaking && !this.data.assistantSpeaking
      && !this.speechPlayback?.getState?.().active && !this.speechPlayback?.getState?.().queued;
    const present = text => new Promise(resolve => {
      if (!idle()) { resolve(false); return; }
      const outputEpoch = this.aiuiOutputEpoch;
      const timer = setTimeout(() => resolve(false), 1500);
      this.setData({ agentReplyText: text, assistantReplyText: text, agentStatus: '后台任务有新结果' }, () => {
        clearTimeout(timer); resolve(idle() && this.aiuiOutputEpoch === outputEpoch);
      });
    });
    const tick = async () => {
      owner.timer = null;
      if (!current() || owner.running) return;
      owner.running = true;
      try {
        await monitor.poll();
        if (!current()) return;
        const pending = monitor.pending();
        for (const id of owner.generated) {
          if (!pending.some(row => row.id === id)) {
            await conversation.acknowledge(id);
            owner.generated.delete(id);
          }
        }
        if (!idle()) return;
        let row = pending[0];
        if (!row) return;
        if (!row.summary) {
          const update = await conversation.observe(row.observation);
          if (!current() || update.status !== 'processed') return;
          // A stop request while summary generation was in flight wins.
          if (!monitor.pending().some(value => value.id === row.id)) {
            await conversation.acknowledge(row.id);
            return;
          }
          row = monitor.saveSummary(row.id, update.result.text);
          owner.generated.add(row.id);
        }
        if (!await present(row.summary) || !current()) return;
        if (!monitor.pending().some(value => value.id === row.id)) return;
        // The receipt confirms a saved summary and a completed setData callback,
        // not that the user read it or that a speaker played it.
        if (owner.generated.has(row.id)) await conversation.acknowledge(row.id);
        else await monitor.receipts.acknowledge(monitor.scope, row.id);
        owner.generated.delete(row.id);
        if (idle()) {
          this.aiuiSpeechSuppressed = false;
          this.speakText(row.summary, 'enqueue');
        }
      } catch (error) {
        if (!current()) return;
        this.setData({ agentStatus: '后台结果未确认，原任务保留，可查询记录' });
        // A failed model observation retires its backend adapter. Recreate the
        // whole session on the next foreground input, never re-dispatch a task.
        if (!assistant.getState().ready) this.cleanupChatModel();
      } finally {
        owner.running = false;
        if (current()) owner.timer = setTimeout(tick, 1000);
      }
    };
    owner.pause = () => { if (owner.timer) clearTimeout(owner.timer); owner.timer = null; };
    owner.resume = () => { if (current() && !owner.timer) owner.timer = setTimeout(tick, 0); };
    owner.resume();
  }
};
