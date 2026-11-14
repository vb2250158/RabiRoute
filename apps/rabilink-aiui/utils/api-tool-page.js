import wx from 'wx';
import { createApiToolRuntime } from './api-tool-runtime.js';
import { requestDeviceApi, getMobileState } from './rabilink-api.js';
import { formatApiResult } from './api-result-view.js';
import { callApiStreamTool } from './api-stream-tool.js';
import { openApiToolLedger } from './api-tool-ledger.js';
import { sha256Text } from '../../../packages/rabi-api-contract/fingerprint.mjs';
import { createTaskFollowRuntime, TASK_FOLLOW_TOOL } from './task-follow-runtime.js';
export const apiToolPageMethods = {
  rabiApiConfig() {
    const value = this.deviceAgentProfileConfig() || this.config();
    return value?.relayBaseUrl && value.token ? { ...value, targetDeviceId: this.deviceAgentProfile?.personaRef?.sourceDeviceId || value.targetDeviceId || '' } : null;
  },
  cleanupRabiApiRuntime() { this.stopTaskFollow?.(); this.rabiApiRuntime?.dispose(); this.rabiApiRuntime = null; this.taskFollowRuntime = null; },
  async prepareRabiApiTools({ isCurrent = () => true, signal } = {}) {
    const assertOwner = () => {
      if (this.destroyed || signal?.aborted || !isCurrent()) throw new Error('VOICE_CONTEXT_CHANGED');
    };
    assertOwner();
    this.cleanupRabiApiRuntime();
    let config = this.rabiApiConfig();
    if (!config) return { tools: [], runtime: null };
    if (!config.targetDeviceId) {
      try {
        const state = await getMobileState(config,12000);
        const target = state.selectedTargetDeviceId || state.selectedWorker?.id || (state.workers?.length === 1 ? state.workers[0].id : '');
        if (!target) throw new Error('API_TARGET_REQUIRED');
        config = { ...config, targetDeviceId: target };
      } catch (_) { assertOwner(); return { tools: [], runtime: null }; }
    }
    assertOwner();
    const scope = this.agentProfileScope(config);
    // Capture the actual target at model creation. A later persona change never
    // reroutes an in-flight tool call, and Relay never interprets profile revisions.
    const targetDeviceId = config.targetDeviceId;
    const request = (packet, target = targetDeviceId) => requestDeviceApi(config, { request: packet, targetDeviceId: target });
    const contextCurrent = () => !this.destroyed && !signal?.aborted && isCurrent() && scope === this.agentProfileScope(this.rabiApiConfig());
    const ledger = openApiToolLedger({ storage: wx, scope, isCurrent: contextCurrent });
    const current = () => ledger.isCurrent();
    const call = async (packet, execution = { isCurrent: current }) => {
        const executionCurrent = () => current() && execution.isCurrent();
        const { targetDeviceId: requestedTarget, ...http } = packet;
        const target = requestedTarget || targetDeviceId;
        let meta;
        try {
          if (!executionCurrent()) throw new Error('API_SCOPE_CHANGED');
          const before = await request({ method: 'GET', path: '/meta' }, target);
          meta = before?.structuredContent?.data;
          if (!executionCurrent()) throw new Error('API_SCOPE_CHANGED');
          if (!meta?.applicationGenerationId || !meta.managerInstanceId || meta.health?.live !== true || !['healthy', 'degraded'].includes(meta.health.state)) throw new Error('API_MANAGER_NOT_READY');
        } catch (error) {
          // Only preflight lives in this catch. The actual API may already have
          // committed when its response fails, so it must retain unknown status.
          throw Object.assign(new Error(error?.message || 'API_PREFLIGHT_FAILED'), {
            code: error?.code || 'API_PREFLIGHT_FAILED', requestDispatched: false
          });
        }
        const prepared={ ...http, headers: { ...http.headers,
          'x-rabiroute-expected-application-generation-id': meta.applicationGenerationId,
          'x-rabiroute-expected-manager-instance-id': meta.managerInstanceId } };
        const result = http.mode ? await callApiStreamTool(config,{...prepared,targetDeviceId:target},executionCurrent) : await request(prepared,target);
        if ((packet.mode==='websocket' && packet.messages?.length>0) || !['GET', 'HEAD', 'OPTIONS'].includes(packet.method)) {
          try {
            const after = (await request({ method: 'GET', path: '/meta' }, target)).structuredContent.data;
            if (after.applicationGenerationId !== meta.applicationGenerationId || after.managerInstanceId !== meta.managerInstanceId) throw new Error();
          } catch (_) { return { structuredContent: { ok: false, uncertain: true, operationId: packet.operationId, code: 'API_IDENTITY_UNCONFIRMED' } }; }
        }
        return result;
      };
    const taskScope = sha256Text(JSON.stringify([scope, targetDeviceId, this.data?.lingzhuAgentId || '',
      this.deviceAgentSystemInstructions?.(this.data?.lingzhuSystemPrompt || '') || this.data?.lingzhuSystemPrompt || '']));
    const taskFollow = createTaskFollowRuntime({ storage: wx, scope: taskScope, ownerId: ledger.sessionId,
      defaultTargetDeviceId: targetDeviceId, read: call, isCurrent: current });
    const api = createApiToolRuntime({ sessionId: ledger.sessionId, defaultTargetDeviceId: targetDeviceId,
      storage: ledger.storage, call,
      onResult: output => {
        if (!current()) return;
        const view = formatApiResult(output.result);
        this.knowledgeResultView = { ...view, scope, role: '', index: 0, api: true };
        this.setKnowledgePageData({ knowledgeToolStatus: output.summary, knowledgeToolResultText: view.confirmed ? view.pages.join('\n').slice(0, 12000) : '' });
        // The turn owner speaks after interpreting the actual receipt. A tool
        // callback must not queue a second, fixed reply ahead of that answer.
      }
    });
    const runtime = { ...api,
      loadTools: async () => [...await api.loadTools(), TASK_FOLLOW_TOOL],
      handleToolCall: event => event.functionName === 'rabi_task_follow' ? taskFollow.handleToolCall(event) : api.handleToolCall(event),
      dispose() { taskFollow.dispose(); api.dispose(); }
    };
    try {
      const tools = await runtime.loadTools();
      assertOwner();
      if (!current()) throw new Error('API_SCOPE_CHANGED');
      this.rabiApiRuntime = runtime;
      this.taskFollowRuntime = taskFollow;
      return { tools, runtime, scope };
    } catch (error) { runtime.dispose(); throw error; }
  },
  handleRabiApiToolCall(event) { return this.rabiApiRuntime ? this.rabiApiRuntime.handleToolCall(event) : Promise.reject(new Error('API_NOT_CONNECTED')); }
};
