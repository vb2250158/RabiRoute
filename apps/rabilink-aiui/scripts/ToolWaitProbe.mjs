// Diagnostic-only adapter. Serialized into an isolated AIX by the probe builder;
// never imported by the application or its production packager.
export function installToolWaitProbe(page) {
  const arithmetic = '计算六乘以七是多少，只回答数字，继续遵守全局前缀。';
  const followup = '请查询 /fixture/next 的结果，拿到结果后告诉我第二个回执编号。';
  const prefix = '青杉九一：';
  const originals = { onLoad: page.onLoad, onHide: page.onHide,
    execute: page.executeLingzhuAgentPrompt, process: page.processAiuiInterjection };
  const log = (event, facts) => console.info('[ToolWaitProbe]', event, JSON.stringify(facts));
  const envelope = data => ({ result: { structuredContent: { ok: true, data } } });
  const later = (p, callback) => {
    const timer = setTimeout(() => { p.probe.timers.delete(timer); if (p.pageVisible && !p.destroyed) callback(); }, 500);
    p.probe.timers.add(timer);
  };
  page.onLoad = function(options) {
    this.probe = { timers: new Set(), calls: [], phases: [], originalDone: false, failures: [] };
    // Keep diagnostic inputs out of the user's durable input ledger.
    let state;
    this.readAiuiInputState = () => state;
    this.writeAiuiInputState = value => { state = JSON.parse(JSON.stringify(value)); };
    return originals.onLoad.call(this, { ...options, agentName: '工具等待诊断',
      systemPrompt: '你是测试助手。所有自然语言回复（包括 final.text、say、插话 text）以“青杉九一：”开头。使用真实工具回执，不猜测编号。原任务与独立输入分开处理。' });
  };
  page.onHide = function(...args) {
    for (const timer of this.probe?.timers || []) clearTimeout(timer);
    this.probe?.timers.clear();
    this.probe?.release?.({ uncertain: true });
    return originals.onHide.apply(this, args);
  };
  page.prepareRabiApiTools = async function() {
    const p = this;
    return { tools: [
      { type: 'function', function: { name: 'rabi_api_help', description: '查询隔离测试接口目录；没有真实 PC 连接。', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'rabi_api_call', description: '调用目录中的隔离只读测试接口。', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET'] }, path: { type: 'string', enum: ['/fixture/slow', '/fixture/next'] } }, required: ['method', 'path'] } } }
    ], runtime: { dispose() {}, async handleToolCall(event) {
      if (event.functionName === 'rabi_api_help') {
        log('discovery', { simulated: true });
        return envelope({ endpoints: [{ method: 'GET', path: '/fixture/slow', description: '等待原任务回执' }, { method: 'GET', path: '/fixture/next', description: '独立输入的第二个回执' }] });
      }
      const args = event.arguments;
      if (event.functionName !== 'rabi_api_call' || args?.method !== 'GET' || !['/fixture/slow', '/fixture/next'].includes(args.path)) throw Error('PROBE_TOOL_NOT_ALLOWED');
      p.probe.calls.push(args.path);
      if (args.path === '/fixture/next') {
        log('next-dispatch', { originalDone: p.probe.originalDone, count: p.probe.calls.filter(x => x === args.path).length });
        if (!p.probe.originalDone) p.probe.failures.push('next-before-original-completion');
        return envelope({ receipt: 'NEXT-29', simulated: true });
      }
      log('original-wait', { count: p.probe.calls.filter(x => x === args.path).length });
      if (p.probe.calls.filter(x => x === args.path).length !== 1) throw Error('PROBE_DUPLICATE_ORIGINAL');
      return new Promise(resolve => {
        let released = false;
        p.probe.release = value => {
          if (released) return; released = true;
          log('original-receipt', { simulated: true });
          resolve(value || envelope({ receipt: 'ORIGINAL-17', simulated: true }));
        };
        // Synthetic transcripts enter the real page's normal guidance/ledger path.
        later(p, () => p.handleTranscriptionResult(arithmetic));
      });
    } } };
  };
  page.processAiuiInterjection = async function(entry) {
    await originals.process.call(this, entry);
    const row = this.inputLedger().snapshot().find(value => value.id === entry.input.id);
    const phase = { input: entry.text === arithmetic ? 'answer' : 'defer', status: row?.status || 'missing',
      originalPending: !this.probe.originalDone,
      answerCorrect: entry.text === arithmetic ? /^青杉九一：\s*42[。.!！]?\s*$/.test(row?.answer || '') : undefined };
    this.probe.phases.push(phase); log('interjection', phase);
    if (entry.text === arithmetic && phase.status === 'answered' && phase.answerCorrect) {
      later(this, () => this.handleTranscriptionResult(followup));
    } else {
      if (entry.text === arithmetic || phase.status !== 'deferred') this.probe.failures.push('interjection-contract');
      later(this, () => this.probe.release());
    }
  };
  page.executeLingzhuAgentPrompt = async function(text, options = {}) {
    // Observe the production result; never complete or cancel its work here.
    const result = await originals.execute.call(this, text, options);
    if (options.inputEntry) {
      const facts = { phases: this.probe.phases, calls: this.probe.calls,
        originalCorrect: this.probe.originalCorrect === true,
        nextCorrect: result?.state === 'completed' && result.text.startsWith(prefix) && result.text.includes('NEXT-29'),
        failures: this.probe.failures };
      const passed = facts.originalCorrect && facts.nextCorrect && facts.failures.length === 0
        && facts.calls.join(',') === '/fixture/slow,/fixture/next'
        && facts.phases.length === 2 && facts.phases.every(x => x.originalPending)
        && facts.phases[0].status === 'answered' && facts.phases[0].answerCorrect && facts.phases[1].status === 'deferred';
      log('result', { passed, ...facts });
      this.setData({ agentStatus: passed ? '诊断通过：原任务与插话独立' : '诊断未通过，请查看日志' });
    } else if (result) {
      this.probe.originalDone = true;
      this.probe.originalCorrect = result.state === 'completed' && result.text.startsWith(prefix)
        && result.text.includes('ORIGINAL-17') && !result.text.includes('NEXT-29');
      log('original-complete', { correct: this.probe.originalCorrect, state: result.state });
      if (this.probe.failures.length) this.setData({ agentStatus: '诊断未通过，请查看日志' });
    }
    return result;
  };
}
