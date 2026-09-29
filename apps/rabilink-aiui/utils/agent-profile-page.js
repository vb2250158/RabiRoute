import wx from "wx";
import { validateAgentProfile, buildAgentSystemInstructions } from "./agent-profile.js";
import { loadDeviceCredential, tokenStorageKey } from "./rabilink-store.js";
import { getDeviceAgentProfile, reportDeviceAgentProfileApplied } from "./rabilink-api.js";
const KEY = "rabilink-aiui-agent-profile-v1";
export const agentProfilePageMethods = {
  deviceAgentProfileConfig() {
    const config = this.config();
    const credential = loadDeviceCredential(config.relayBaseUrl, this.asrHostPolicy?.deviceSerialNumber);
    return credential ? { ...config, token: credential } : null;
  },
  restoreDeviceAgentProfile() {
    const config = this.deviceAgentProfileConfig();
    this.synchronizeAgentProfileScope(this.agentProfileScope(config));
    if (!config) return;
    try {
      const stored = wx.getStorageSync(KEY);
      if (!stored || stored.scope !== this.agentProfileScope(config)) return;
      this.deviceAgentProfile = validateAgentProfile(stored.profile);
      this.deviceAgentProfileScope = stored.scope;
      this.showDeviceAgentProfile(this.deviceAgentProfile, "配置已缓存，等待模型应用");
    } catch (_) { this.setData({ deviceAgentProfileStatus: "缓存配置无效，保留原设置" }); }
  },
  agentProfileScope(config) { return config ? `${config.relayBaseUrl}|${this.asrHostPolicy?.deviceSerialNumber || ""}|${tokenStorageKey(config.token)}` : ""; },
  currentAgentProfileScope() { return this.agentProfileScope(this.deviceAgentProfileConfig()); },
  synchronizeAgentProfileScope(scope) {
    if (this.deviceAgentActiveScope === scope) return;
    this.deviceAgentActiveScope = scope;
    this.deviceAgentProfileRequestEpoch = (this.deviceAgentProfileRequestEpoch || 0) + 1;
    this.deviceAgentProfileAckEpoch = (this.deviceAgentProfileAckEpoch || 0) + 1;
    const hadProfile = !!this.deviceAgentProfile;
    this.deviceAgentProfile = null; this.deviceAgentProfileScope = "";
    this.pendingDeviceAgentProfile = null; this.deviceAgentProfileRemoteApplied = null;
    this.chatModelDeviceProfile = null;
    if (hadProfile) {
      this.deviceAgentProfileResetPending = true;
      this.setData({ lingzhuAgentId: "", lingzhuAgentName: "灵珠智能体", lingzhuSystemPrompt: "", deviceAgentProfileStatus: "设备归属已变更，等待新配置" });
      if (!this.deviceAgentTurnActive) { this.cleanupChatModel(); this.deviceAgentProfileResetPending = false; }
    }
  },
  showDeviceAgentProfile(profile, status) {
    this.setData({ lingzhuAgentId: profile.id, lingzhuAgentName: profile.name, lingzhuSystemPrompt: profile.systemPrompt,
      deviceAgentProfileStatus: status + (profile.mcp.some(item => item.enabled) && !status.includes("只读知识工具已应用") ? "；MCP 引用未连接" : "") });
  },
  async refreshDeviceAgentProfile() {
    const config = this.deviceAgentProfileConfig();
    this.synchronizeAgentProfileScope(this.agentProfileScope(config));
    if (!config || this.destroyed) return;
    const scope = this.agentProfileScope(config);
    const epoch = this.deviceAgentProfileRequestEpoch = (this.deviceAgentProfileRequestEpoch || 0) + 1;
    try {
      const result = await getDeviceAgentProfile(config);
      if (this.destroyed || epoch !== this.deviceAgentProfileRequestEpoch || scope !== this.currentAgentProfileScope()) return;
      this.deviceAgentProfileRemoteApplied = result.applied;
      if (!result.profile) { this.setData({ deviceAgentProfileStatus: "手机尚未配置眼镜 Agent" }); return; }
      const profile = validateAgentProfile(result.profile);
      if (profile.revision !== result.savedRevision) throw new Error("INVALID_PROFILE");
      if (this.deviceAgentProfile && profile.revision < this.deviceAgentProfile.revision) throw new Error("INVALID_PROFILE");
      if (this.deviceAgentProfile && profile.revision === this.deviceAgentProfile.revision) {
        if (JSON.stringify(profile) !== JSON.stringify(this.deviceAgentProfile)) throw new Error("INVALID_PROFILE");
        if (this.chatModel && this.chatModelDeviceProfile === this.deviceAgentProfile) await this.acknowledgeDeviceAgentProfile(this.deviceAgentProfile);
        return;
      }
      this.pendingDeviceAgentProfile = { profile, scope: this.agentProfileScope(config) };
      if (this.deviceAgentTurnActive || this.data.assistantModelBusy) {
        this.setData({ deviceAgentProfileStatus: "新配置待应用，当前对话不被打断" }); return;
      }
      this.applyPendingDeviceAgentProfile();
    } catch (_) { if (epoch === this.deviceAgentProfileRequestEpoch && scope === this.currentAgentProfileScope()) this.setData({ deviceAgentProfileStatus: "配置读取失败，保留当前设置" }); }
  },
  applyPendingDeviceAgentProfile() {
    this.synchronizeAgentProfileScope(this.currentAgentProfileScope());
    if (this.deviceAgentTurnActive || this.destroyed) return;
    if (this.deviceAgentProfileResetPending) { this.cleanupChatModel(); this.deviceAgentProfileResetPending = false; }
    if (!this.pendingDeviceAgentProfile) return;
    const pending = this.pendingDeviceAgentProfile;
    if (pending.scope !== this.currentAgentProfileScope()) { this.pendingDeviceAgentProfile = null; return; }
    try { wx.setStorageSync(KEY, pending); }
    catch (_) { this.setData({ deviceAgentProfileStatus: "配置保存失败，保留当前模型" }); return; }
    this.cleanupChatModel();
    this.deviceAgentProfile = pending.profile;
    this.deviceAgentProfileScope = pending.scope;
    this.pendingDeviceAgentProfile = null;
    this.showDeviceAgentProfile(pending.profile, "配置已保存，等待下一轮模型应用");
  },
  deviceAgentSystemInstructions(fallback) {
    return this.deviceAgentProfile && this.deviceAgentProfileScope === this.currentAgentProfileScope() ? buildAgentSystemInstructions(this.deviceAgentProfile) : fallback;
  },
  async acknowledgeDeviceAgentProfile(profile) {
    const config = this.deviceAgentProfileConfig();
    const scope = this.agentProfileScope(config);
    if (!profile || !config || this.destroyed || this.deviceAgentProfile !== profile || this.deviceAgentProfileScope !== scope) return;
    const epoch = this.deviceAgentProfileAckEpoch = (this.deviceAgentProfileAckEpoch || 0) + 1;
    const current = () => !this.destroyed && epoch === this.deviceAgentProfileAckEpoch && scope === this.currentAgentProfileScope() && this.deviceAgentProfile === profile;
    const enabledServices = profile.mcp.filter(item => item.enabled);
    const readToolsReady = enabledServices.length > 0 && enabledServices.every(item => item.id === "rabi-knowledge")
      && !!this.chatModel && this.chatModelDeviceProfile === profile
      && !!this.knowledgeRuntime && this.chatModelKnowledgeRuntime === this.knowledgeRuntime
      && this.chatModelKnowledgeScope === scope && this.knowledgeScope === scope
      && this.chatModelKnowledgeRole === this.knowledgeSelectedRole
      && this.chatModelKnowledgeCatalog === this.knowledgeCatalog
      && !!this.knowledgeCatalog?.allowedRoles.includes(this.knowledgeSelectedRole)
      && this.chatModelReadonlyToolsCount > 0 && !this.knowledgeRebuildPending;
    const unavailable = enabledServices.length > 0 && !readToolsReady;
    try {
      // Historical idempotency receipts are not the current authoritative application state.
      const latest = await getDeviceAgentProfile(config);
      if (!current()) return;
      if (latest.savedRevision !== profile.revision || JSON.stringify(validateAgentProfile(latest.profile)) !== JSON.stringify(profile)) throw new Error("INVALID_PROFILE");
      const remote = latest.applied;
      this.deviceAgentProfileRemoteApplied = remote;
      if (remote?.appliedRevision === profile.revision && remote.status === "applied") {
        this.showDeviceAgentProfile(profile, unavailable ? "此版本已应用；工具当前不可用（不撤销应用记录）" : readToolsReady ? "此版本已应用；只读工具已加载，写入未启用" : "此版本已应用；不代表服务持续在线");
        return;
      }
      if (remote?.appliedRevision === profile.revision && remote.status === "failed" && unavailable && remote.errorCode === "TOOLS_UNAVAILABLE") return;
      const receipt = await reportDeviceAgentProfileApplied(config, { idempotencyKey: `aiui-profile-${profile.revision}-${unavailable ? "tools-unavailable" : "applied"}`,
        appliedRevision: profile.revision, status: unavailable ? "failed" : "applied", ...(unavailable ? { errorCode: "TOOLS_UNAVAILABLE" } : {}) });
      if (!current()) return;
      if (receipt.savedRevision !== profile.revision || JSON.stringify(validateAgentProfile(receipt.profile)) !== JSON.stringify(profile) || (receipt.applied?.errorCode || "") !== (unavailable ? "TOOLS_UNAVAILABLE" : "")) throw new Error("INVALID_RECEIPT");
      if (receipt.idempotencyKey !== `aiui-profile-${profile.revision}-${unavailable ? "tools-unavailable" : "applied"}` || receipt.applied?.appliedRevision !== profile.revision || receipt.applied?.status !== (unavailable ? "failed" : "applied")) throw new Error("INVALID_RECEIPT");
      const confirmed = await getDeviceAgentProfile(config);
      if (!current()) return;
      if (confirmed.savedRevision !== profile.revision || JSON.stringify(validateAgentProfile(confirmed.profile)) !== JSON.stringify(profile)) throw new Error("INVALID_PROFILE");
      this.deviceAgentProfileRemoteApplied = confirmed.applied;
      if (confirmed.applied?.appliedRevision !== receipt.applied.appliedRevision || confirmed.applied?.status !== receipt.applied.status || (confirmed.applied?.errorCode || "") !== (receipt.applied.errorCode || "")) {
        this.setData({ deviceAgentProfileStatus: "历史回执与当前应用记录不一致，请在手机重新保存配置；未确认应用" });
        return;
      }
      this.showDeviceAgentProfile(profile, unavailable ? "指引已应用；工具尚不可用" : readToolsReady ? "模型与只读知识工具已应用；写入未启用" : "模型已应用配置");
    } catch (_) { if (current()) this.setData({ deviceAgentProfileStatus: "模型已应用，回执未确认；手动刷新核对" }); }
  }
};
