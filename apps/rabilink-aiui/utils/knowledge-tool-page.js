import wx from "wx";
import { formatKnowledgeResult } from "./knowledge-result-view.js";
import { createKnowledgeToolRuntime } from "./knowledge-tool-runtime.js";
import { requestDeviceKnowledge } from "./rabilink-api.js";
const KEY = "rabilink-aiui-knowledge-ledger-v1";
export const KNOWLEDGE_SERVICE_ID = "rabi-knowledge";
export const knowledgeToolPageMethods = {
  setKnowledgePageData(patch) {
    this.setData({ ...patch, ...(patch.knowledgeToolStatus ? { knowledgeToolHudText: patch.knowledgeToolStatus.slice(0, 22) } : {}) });
  },
  async refreshAgentAndKnowledgeTools() { await this.refreshDeviceAgentProfile(); await this.refreshKnowledgeTools(); },
  knowledgeContext() {
    const config = this.deviceAgentProfileConfig();
    if (!config || !this.deviceAgentProfile?.mcp.some(item => item.id === KNOWLEDGE_SERVICE_ID && item.enabled)) return null;
    const scope = this.agentProfileScope(config);
    if (scope !== this.deviceAgentProfileScope) return null;
    return { config, scope };
  },
  clearKnowledgeResultView() { this.knowledgeResultView = null; this.setData({ knowledgeToolResultText: "" }); },
  browseKnowledgeResultFromSpeech(text) {
    const command = String(text || "").trim().replace(/[。！!？?]$/, "");
    if (!["读出工具结果", "下一条工具结果"].includes(command)) return false;
    const view = this.knowledgeResultView;
    if (!view || view.scope !== this.knowledgeContext()?.scope || view.role !== this.knowledgeSelectedRole || !view.confirmed) {
      this.clearKnowledgeResultView(); this.setKnowledgePageData({ knowledgeToolStatus: "没有当前角色已确认的工具记录" }); return true;
    }
    if (this.deviceAgentTurnActive || this.data.assistantModelBusy) { this.setKnowledgePageData({ knowledgeToolStatus: "正在回答，请稍后读出工具结果" }); return true; }
    if (!view.pages.length) { this.setKnowledgePageData({ knowledgeToolStatus: "工具记录无可展示正文" }); return true; }
    if (command === "下一条工具结果") view.index = Math.min(view.index + 1, view.pages.length - 1);
    const content = view.pages[view.index];
    this.setData({ agentReplyText: content, assistantReplyText: content });
    this.setKnowledgePageData({ knowledgeToolStatus: `工具记录 ${view.index + 1}/${view.pages.length}${view.truncated ? "（已限长）" : ""}` });
    this.speakText(`工具记录，第${view.index + 1}段。${content}`, "enqueue");
    return true;
  },
  invalidateKnowledgeTools() {
    this.clearKnowledgeResultView();
    this.knowledgeEpoch = (this.knowledgeEpoch || 0) + 1;
    this.knowledgeRequestEpoch = (this.knowledgeRequestEpoch || 0) + 1;
    this.knowledgeCatalog = null; this.knowledgeSelectedRole = "";
    this.knowledgeRuntime?.dispose(); this.knowledgeRuntime = null;
    this.knowledgeRebuildPending = true;
  },
  async refreshKnowledgeTools() {
    const context = this.knowledgeContext();
    if (!context) { this.invalidateKnowledgeTools(); this.setKnowledgePageData({ knowledgeToolStatus: "知识工具未配置" }); return; }
    if (this.knowledgeScope !== context.scope) { this.invalidateKnowledgeTools(); this.knowledgeScope = context.scope; }
    const epoch = this.knowledgeRequestEpoch = (this.knowledgeRequestEpoch || 0) + 1;
    try {
      const catalog = await requestDeviceKnowledge(context.config, { operation: "list" });
      if (this.destroyed || epoch !== this.knowledgeRequestEpoch || context.scope !== this.knowledgeContext()?.scope) return;
      if (!Array.isArray(catalog.allowedRoles) || catalog.allowedRoles.length > 64 || !catalog.allowedRoles.every(id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) || !Array.isArray(catalog.tools) || JSON.stringify(catalog).length > 65536) throw new Error("INVALID_CATALOG");
      const changed = JSON.stringify(this.knowledgeCatalog) !== JSON.stringify(catalog);
      if (changed) { this.clearKnowledgeResultView(); this.knowledgeCatalog = catalog; }
      if (!catalog.allowedRoles.includes(this.knowledgeSelectedRole)) this.knowledgeSelectedRole = "";
      if (changed) this.knowledgeRebuildPending = true;
      this.setKnowledgePageData({ knowledgeToolStatus: this.knowledgeSelectedRole ? "知识目录已更新，下一轮生效" : "请说：使用知识角色 " + catalog.allowedRoles.join(" / ") });
    } catch (_) { if (epoch === this.knowledgeRequestEpoch && context.scope === this.knowledgeContext()?.scope) this.setKnowledgePageData({ knowledgeToolStatus: "知识目录未就绪，请手动刷新" }); }
  },
  selectKnowledgeRoleFromSpeech(text) {
    const match = /^使用知识角色\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[。！!]?$/u.exec(String(text || "").trim());
    if (!match) return false;
    if (!this.knowledgeContext() || this.knowledgeScope !== this.knowledgeContext().scope || !this.knowledgeCatalog?.allowedRoles.includes(match[1])) {
      this.setKnowledgePageData({ knowledgeToolStatus: "角色不在已授权目录，请先刷新知识工具" }); return true;
    }
    this.clearKnowledgeResultView();
    this.knowledgeSelectedRole = match[1]; this.knowledgeRebuildPending = true;
    this.setKnowledgePageData({ knowledgeToolStatus: "已选择知识角色，下一轮生效" }); return true;
  },
  applyPendingKnowledgeTools() {
    if (!this.knowledgeRebuildPending || this.deviceAgentTurnActive || this.data.assistantModelBusy) return;
    this.cleanupChatModel(); this.cleanupKnowledgeRuntime(); this.knowledgeRebuildPending = false;
  },
  cleanupKnowledgeRuntime() { this.knowledgeRuntime?.dispose(); this.knowledgeRuntime = null; },
  cancelKnowledgePresentation() { this.knowledgeRuntime?.cancelPresentation(); },
  async prepareKnowledgeTools() {
    const context = this.knowledgeContext();
    if (!context || context.scope !== this.knowledgeScope || !this.knowledgeCatalog?.allowedRoles.includes(this.knowledgeSelectedRole)) return { tools: [], runtime: null };
    const epoch = this.knowledgeEpoch, role = this.knowledgeSelectedRole, catalog = this.knowledgeCatalog;
    // A single bounded record is replaced per model session; old session runtimes are disposed first.
    this.cleanupKnowledgeRuntime();
    const old = wx.getStorageSync(KEY);
    const counter = old && Number.isSafeInteger(old.counter) && old.counter >= 0 ? old.counter + 1 : 1;
    if (!Number.isSafeInteger(counter)) throw new Error("KNOWLEDGE_SESSION_LIMIT");
    const record = { scope: context.scope, counter, rows: [] };
    wx.setStorageSync(KEY, record);
    const current = () => !this.destroyed && epoch === this.knowledgeEpoch && role === this.knowledgeSelectedRole && context.scope === this.knowledgeContext()?.scope;
    const runtime = createKnowledgeToolRuntime({ authorizedRoles: catalog.allowedRoles, selectedRole: role,
      list: async () => catalog,
      call: request => { if (!current()) throw new Error("KNOWLEDGE_SCOPE_CHANGED"); return requestDeviceKnowledge(context.config, { operation: "call", ...request }); },
      storage: { load: () => record.rows, save: rows => { const saved = wx.getStorageSync(KEY); if (!current() || saved?.counter !== counter || saved?.scope !== context.scope) throw new Error("KNOWLEDGE_SCOPE_CHANGED"); wx.setStorageSync(KEY, { ...record, rows }); record.rows = rows; } },
      onResult: output => { if (!current()) return; const view = formatKnowledgeResult(output.result); this.knowledgeResultView = { ...view, scope: context.scope, role, index: 0 }; this.setKnowledgePageData({ knowledgeToolStatus: view.confirmed ? "查询已返回，说：读出工具结果" : output.summary, knowledgeToolResultText: view.confirmed ? view.pages.join("\n").slice(0, 12000) : "" }); this.speakText(output.summary, "enqueue"); }
    });
    try {
      const tools = await runtime.loadTools();
      if (!current()) { runtime.dispose(); return { tools: [], runtime: null }; }
      this.knowledgeRuntime = runtime; return { tools, runtime, scope: context.scope, role, catalog };
    } catch (error) { runtime.dispose(); throw error; }
  },
  handleKnowledgeToolCall(event, runtime) {
    if (!runtime || runtime !== this.knowledgeRuntime) return;
    void runtime.handleToolCall(event).catch(() => { if (runtime === this.knowledgeRuntime && !this.destroyed) this.setKnowledgePageData({ knowledgeToolStatus: "工具请求未确认，未自动重试" }); });
  }
};
