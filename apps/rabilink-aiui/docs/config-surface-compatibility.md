# 配置表面兼容合同

[English](config-surface-compatibility_en.md) | 简体中文

HEAD 中配置审计要求 WebGUI 含 `remoteAgentDefaultDeviceId`，但当时两份被审计 Vue 已无该字段，属于既有合同失配，不是本次 AIUI 工具新增导致。

三个 `remoteAgentDefaultDeviceId`／`remoteAgentDefaultCwd`／`remoteAgentDefaultThreadName` 并未退役：共享 GatewayDefinition 保留它们；Manager `controlPlaneRoutes.ts` 在远端任务请求缺少 deviceId/cwd/threadName 时使用路由默认值，`routing/agentPacket.ts` 仍生成相应 API 指引，AIUI 高级配置仍可保存旧值。因此不能声称已自动迁移、无用或与新界面完全等价。

当前 WebGUI 使用 `remoteAgentTargets`、实例与 Agent 绑定和 `InstanceAgentSettings`。审计只将三个旧默认值明确归类为兼容 schema/runtime/AIUI 高级配置，不再要求当前 WebGUI 显示已移除的旧控件；同时强制检查现有实例绑定。未知共享字段仍失败，删除当前 UI 绑定仍失败。配置不选择 AIUI 模型 owner；默认 local，远端观察须显式选择。

本机兼容合同测试 3/3、配置表面审计通过（119 共享字段、45 直接字段、9 action groups）。这些数字仅为结构审计，不代表全部功能或真机。完整 check 随后暴露另一处 HEAD 合同失配：旧 Android 独立 `RokidDeviceStatusSyncService` 已不存在，真实能力由现有 `RabiConversationService` 持有 `RabiGlassStatusPublisher`，不是单纯快照缺件。

状态桥审计已迁移到现有实现：真实电量／充电回调、running/statusSyncEnabled/uploadEnabled 三重许可、冻结凭据身份、网络恢复 drain、关闭生命周期、非导出 owner 与不新增 CXR/UI 控制均受检查。4/4 正负测试及状态桥审计通过；删除 gate、owner 回调／drain／close 或加入 UI 控制均失败。保留 Relay、SDK、AIUI 过期状态和原 status-only CXR 边界校验。未增加独立服务或修改 Android 生产代码。不能据此宣称整个 check 或真机通过；未修改业务配置、旧值或运行时迁移逻辑。
