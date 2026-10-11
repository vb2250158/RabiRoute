<!-- docs-language-switch -->
<div align="center"><a href="./device-agent-adapter_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 设备 Agent（实验）

`deviceAgent` 用于把消息路线绑定到真实设备 Agent。路由设置从 `/api/device-agents` 读取设备目录，保存设备的稳定 `agentId` 和所属 PC 的 `RabiGuid`（`binding.instanceId`）。这与 LAN Registry 的本机实例 ID 是两种身份，不能互换。设备未绑定或目录不可用时，刷新页面会显示配置提示。

设备拥有模型轮次、语音与工具执行；PC 保存消息投递、唤醒请求和设备回执。Rokid AIUI 使用乐奇配置的模型、ASR 与 TTS。PC 排队成功或手机提交唤醒指令均不代表设备 owner 已接收消息，必须等待该 owner 的回执。未知结果保留原 `deliveryId`，先回读，不重新投递。

当前仅声明普通消息路线投递与已登记设备会话的 AgentThreads 查询、读取及投递。独立消息处理子会话、计划秘书、记忆整理、生命周期 Hook 和通用回执恢复能力未声明。配置页只从目录选取设备，不提供无绑定的本机设备入口，也不允许修改设备宿主模型或伪造会话 ID。

接入等级保持 `experimental`。源码测试覆盖注册、权限能力限制、绑定保存、工厂分派和设备 owner 协议。真机唤醒、真实回复、同会话续投与 ASR/TTS 并行仍须实测；测试通过不能作为已部署或真机验收证据。
