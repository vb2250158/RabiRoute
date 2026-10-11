import wx from 'wx';
import { createApiToolRuntime } from './api-tool-runtime.js';
import { requestDeviceApi, getMobileState } from './rabilink-api.js';
import { formatApiResult } from './api-result-view.js';
import { callApiStreamTool } from './api-stream-tool.js';
const KEY = 'rabilink-aiui-api-ledger-v1';
export const apiToolPageMethods = {
  rabiApiConfig() {
    const value = this.deviceAgentProfileConfig() || this.config();
    return value?.relayBaseUrl && value.token ? { ...value, targetDeviceId: this.deviceAgentProfile?.personaRef?.sourceDeviceId || value.targetDeviceId || '' } : null;
  },
  cleanupRabiApiRuntime() { this.rabiApiRuntime?.dispose(); this.rabiApiRuntime = null; },
  async prepareRabiApiTools() {
    this.cleanupRabiApiRuntime();
    let config = this.rabiApiConfig();
    if (!config) return { tools: [], runtime: null };
    if (!config.targetDeviceId) {
      try {
        const state = await getMobileState(config,12000);
        const target = state.selectedTargetDeviceId || state.selectedWorker?.id || (state.workers?.length === 1 ? state.workers[0].id : '');
        if (!target) throw new Error('API_TARGET_REQUIRED');
        config = { ...config, targetDeviceId: target };
      } catch (_) { return { tools: [], runtime: null }; }
    }
    const scope = this.agentProfileScope(config);
    // Capture the actual target at model creation. A later persona change never
    // reroutes an in-flight tool call, and Relay never interprets profile revisions.
    const targetDeviceId = config.targetDeviceId;
    const request = (packet, target = targetDeviceId) => requestDeviceApi(config, { request: packet, targetDeviceId: target });
    const previous = wx.getStorageSync(KEY), counter = (Number.isSafeInteger(previous?.counter) ? previous.counter : 0) + 1;
    if (!Number.isSafeInteger(counter)) throw new Error('API_SESSION_LIMIT');
    const record = { scope, counter, rows: [] };
    wx.setStorageSync(KEY, record);
    const current = () => !this.destroyed && scope === this.agentProfileScope(this.rabiApiConfig());
    const runtime = createApiToolRuntime({ sessionId: 'aiui-' + counter, defaultTargetDeviceId: targetDeviceId,
      storage: { load: () => record.rows, save: rows => {
        const saved = wx.getStorageSync(KEY);
        if (!current() || saved?.counter !== counter || saved.scope !== scope) throw new Error('API_SCOPE_CHANGED');
        wx.setStorageSync(KEY, { ...record, rows }); record.rows = rows;
      } },
      call: async packet => {
        if (!current()) throw new Error('API_SCOPE_CHANGED');
        const { targetDeviceId: requestedTarget, ...http } = packet;
        const target = requestedTarget || targetDeviceId;
        const before = await request({ method: 'GET', path: '/meta' }, target);
        const meta = before?.structuredContent?.data;
        if (!current() || !meta?.applicationGenerationId || !meta.managerInstanceId || meta.health?.live !== true || meta.health?.requiredReady !== true || !['healthy', 'degraded'].includes(meta.health.state)) throw new Error('API_MANAGER_NOT_READY');
        const prepared={ ...http, headers: { ...http.headers,
          'x-rabiroute-expected-application-generation-id': meta.applicationGenerationId,
          'x-rabiroute-expected-manager-instance-id': meta.managerInstanceId } };
        const result = http.mode ? await callApiStreamTool(config,{...prepared,targetDeviceId:target},current) : await request(prepared,target);
        if ((packet.mode==='websocket' && packet.messages?.length>0) || !['GET', 'HEAD', 'OPTIONS'].includes(packet.method)) {
          try {
            const after = (await request({ method: 'GET', path: '/meta' }, target)).structuredContent.data;
            if (after.applicationGenerationId !== meta.applicationGenerationId || after.managerInstanceId !== meta.managerInstanceId) throw new Error();
          } catch (_) { return { structuredContent: { ok: false, uncertain: true, operationId: packet.operationId, code: 'API_IDENTITY_UNCONFIRMED' } }; }
        }
        return result;
      },
      onResult: output => {
        if (!current()) return;
        const view = formatApiResult(output.result);
        this.knowledgeResultView = { ...view, scope, role: '', index: 0, api: true };
        this.setKnowledgePageData({ knowledgeToolStatus: output.summary, knowledgeToolResultText: view.confirmed ? view.pages.join('\n').slice(0, 12000) : '' });
        this.speakText(output.summary, 'enqueue');
      }
    });
    this.rabiApiRuntime = runtime;
    return { tools: await runtime.loadTools(), runtime, scope };
  },
  handleRabiApiToolCall(event) { return this.rabiApiRuntime ? this.rabiApiRuntime.handleToolCall(event) : Promise.reject(new Error('API_NOT_CONNECTED')); }
};
