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
      if (stored.profile === null) {
        this.setData({ deviceAgentProfileStatus: "已缓存解绑状态，等待当前连接确认" });
        return;
      }
      this.deviceAgentProfile = validateAgentProfile(stored.profile);
      this.deviceAgentProfileScope = stored.scope;
      this.showDeviceAgentProfile(this.deviceAgentProfile, "配置已缓存，等待模型应用");
    } catch (_) { this.setData({ deviceAgentProfileStatus: "缓存配置无效，保留原设置" }); }
  },
  agentProfileScope(config) { return config ? `${config.relayBaseUrl}|${this.asrHostPolicy?.deviceSerialNumber || ""}|${tokenStorageKey(config.token)}` : ""; },
  currentAgentProfileScope() { return this.agentProfileScope(this.deviceAgentProfileConfig()); },
  isAiuiVoiceContextReady() {
    const scope = this.currentAgentProfileScope();
    return !scope || (this.aiuiVoiceContextReady === true && this.aiuiVoiceContextScope === scope);
  },
  invalidateAiuiVoiceContext() {
    this.aiuiVoiceContextEpoch = (this.aiuiVoiceContextEpoch || 0) + 1;
    this.aiuiVoiceContextReady = false;
    this.aiuiVoiceContextPromise = null;
    this.aiuiVoiceInitialInputs = [];
  },
  initializeAiuiVoiceContext() {
    const scope = this.currentAgentProfileScope();
    this.synchronizeAgentProfileScope(scope);
    if (!scope || this.isAiuiVoiceContextReady()) return Promise.resolve({ ok: true, scope });
    if (this.aiuiVoiceContextPromise && this.aiuiVoiceContextScope === scope) return this.aiuiVoiceContextPromise;
    const epoch = this.aiuiVoiceContextEpoch = (this.aiuiVoiceContextEpoch || 0) + 1;
    this.aiuiVoiceContextReady = false;
    this.aiuiVoiceContextScope = scope;
    const current = () => !this.destroyed && this.pageVisible && epoch === this.aiuiVoiceContextEpoch
      && scope === this.currentAgentProfileScope();
    const pending = (async () => {
      const profile = await this.refreshDeviceAgentProfile();
      if (!current()) throw new Error("VOICE_CONTEXT_CHANGED");
      if (profile?.ok !== true || profile.applied !== true) throw new Error("VOICE_PROFILE_UNCONFIRMED");
      await this.refreshApiTools();
      if (!current()) throw new Error("VOICE_CONTEXT_CHANGED");
      await this.startDeviceAgentOwner();
      if (!current()) throw new Error("VOICE_CONTEXT_CHANGED");
      if (!this.deviceAgentOwner) throw new Error("VOICE_OWNER_UNCONFIRMED");
      if (!this.rabiApiRuntime || this.chatModelApiRuntime !== this.rabiApiRuntime
        || this.chatModelApiScope !== scope || !(this.chatModelApiToolsCount > 0))
        throw new Error("VOICE_API_UNCONFIRMED");
      this.aiuiVoiceContextReady = true;
      this.flushAiuiVoiceInitialInputs?.();
      return { ok: true, scope };
    })().catch(error => {
      if (current()) this.setData({ agentStatus: "配置尚未确认，已保留语音输入；请重新连接",
        deviceAgentProfileStatus: "初始化未确认，未启动未绑定模型" });
      return { ok: false, scope, code: error?.message || "VOICE_CONTEXT_UNCONFIRMED" };
    }).finally(() => {
      if (this.aiuiVoiceContextPromise === pending) this.aiuiVoiceContextPromise = null;
    });
    this.aiuiVoiceContextPromise = pending;
    return pending;
  },
  synchronizeAgentProfileScope(scope) {
    if (this.deviceAgentActiveScope === scope) return;
    if (this.deviceAgentActiveScope !== undefined) this.invalidateAiuiVoiceContext();
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
      deviceAgentProfileStatus: status + (profile.mcp.some(item => item.enabled) && !status.includes("通用接口工具已应用") ? "；MCP 引用未连接" : "") });
  },
  async refreshDeviceAgentProfile() {
    const config = this.deviceAgentProfileConfig();
    this.synchronizeAgentProfileScope(this.agentProfileScope(config));
    if (!config || this.destroyed) return { ok: !config && !this.destroyed, scope: "", applied: !config };
    const scope = this.agentProfileScope(config);
    const epoch = this.deviceAgentProfileRequestEpoch = (this.deviceAgentProfileRequestEpoch || 0) + 1;
    try {
      const result = await getDeviceAgentProfile(config);
      if (this.destroyed || epoch !== this.deviceAgentProfileRequestEpoch || scope !== this.currentAgentProfileScope()) return { ok: false, scope };
      this.deviceAgentProfileRemoteApplied = result.applied;
      if (!result.profile) {
        if (this.deviceAgentProfile || this.pendingDeviceAgentProfile) {
          this.pendingDeviceAgentProfile = { profile: null, scope };
          if (this.deviceAgentTurnActive || this.data.assistantModelBusy) {
            this.setData({ deviceAgentProfileStatus: "解绑待当前轮结束后应用" });
            return { ok: true, scope, applied: false, unbound: true };
          }
          this.applyPendingDeviceAgentProfile();
        }
        this.setData({ deviceAgentProfileStatus: "未绑定角色；已鉴权连接仍可调用接口" });
        return { ok: true, scope, applied: !this.pendingDeviceAgentProfile, unbound: true };
      }
      const profile = validateAgentProfile(result.profile);
      if (profile.revision !== result.savedRevision) throw new Error("INVALID_PROFILE");
      if (this.deviceAgentProfile && profile.revision < this.deviceAgentProfile.revision) throw new Error("INVALID_PROFILE");
      if (this.deviceAgentProfile && profile.revision === this.deviceAgentProfile.revision) {
        if (JSON.stringify(profile) !== JSON.stringify(this.deviceAgentProfile)) throw new Error("INVALID_PROFILE");
        if (this.chatModel && this.chatModelDeviceProfile === this.deviceAgentProfile) await this.acknowledgeDeviceAgentProfile(this.deviceAgentProfile);
        return { ok: true, scope, applied: true };
      }
      this.pendingDeviceAgentProfile = { profile, scope: this.agentProfileScope(config) };
      if (this.deviceAgentTurnActive || this.data.assistantModelBusy) {
        this.setData({ deviceAgentProfileStatus: "新配置待应用，当前对话不被打断" }); return { ok: true, scope, applied: false };
      }
      this.applyPendingDeviceAgentProfile();
      return { ok: true, scope, applied: !this.pendingDeviceAgentProfile && this.deviceAgentProfile === profile };
    } catch (_) { if (epoch === this.deviceAgentProfileRequestEpoch && scope === this.currentAgentProfileScope()) this.setData({ deviceAgentProfileStatus: "配置读取失败，保留当前设置" }); return { ok: false, scope }; }
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
    if (pending.profile === null) {
      this.deviceAgentProfileScope = "";
      this.setData({ lingzhuAgentId: "", lingzhuAgentName: "灵珠智能体", lingzhuSystemPrompt: "",
        deviceAgentProfileStatus: "未绑定角色；已鉴权连接仍可调用接口" });
      return;
    }
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
    const readToolsReady = enabledServices.every(item => ["rabi-knowledge", "rabi-api"].includes(item.id))
      && !!this.chatModel && this.chatModelDeviceProfile === profile
      && !!this.rabiApiRuntime && this.chatModelApiRuntime === this.rabiApiRuntime
      && this.chatModelApiScope === scope && this.chatModelApiToolsCount > 0;
    const unavailable = !readToolsReady;
    try {
      // Historical idempotency receipts are not the current authoritative application state.
      const latest = await getDeviceAgentProfile(config);
      if (!current()) return;
      if (latest.savedRevision !== profile.revision || JSON.stringify(validateAgentProfile(latest.profile)) !== JSON.stringify(profile)) throw new Error("INVALID_PROFILE");
      const remote = latest.applied;
      this.deviceAgentProfileRemoteApplied = remote;
      if (remote?.appliedRevision === profile.revision && remote.status === "applied") {
        this.showDeviceAgentProfile(profile, unavailable ? "此版本已应用；工具当前不可用（不撤销应用记录）" : "此版本已应用；通用接口工具已加载，连接状态由实际调用核验");
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
      this.showDeviceAgentProfile(profile, unavailable ? "指引已应用；工具尚不可用" : "模型与通用接口工具已应用");
    } catch (_) { if (current()) this.setData({ deviceAgentProfileStatus: "模型已应用，回执未确认；手动刷新核对" }); }
  }
};
