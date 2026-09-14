[English](README_en.md) | 简体中文

# Rabi DSH Context

通过 DSH 生命周期事件把会话入口、用户消息、工具前后和轮次结束交给 Rabi Manager。人格、开关与执行决策由 Manager 管理；插件不保存第二份规则。

在 Agent 端点击“更新 Hook 到 Agent”，安装到本机 DSH `web` profile，再重新加载插件或重启 DSH。Manager 地址每次经 Host 发现并核对 `/meta`；源码或测试可通过 `RABI_MANAGER_URL` 提供完整地址。Manager 不可用时记录错误，DSH 仍可独立使用。

开发归属见[统一 Agent 接入规范](../../docs/agent-adapter-standard-requirements.md#功能归属rabi-优先宿主只补必要能力)。本 Hook 只补 Rabi 无法直接捕获或应用的 DSH 生命周期事件和本地动作，不自行选取记忆、定义人格、推进计划或调度跨 Agent 任务；这些公共业务由 Rabi 决定，供 DSH、Codex 等端复用。Rabi 返回的决定仍受 DSH 自身权限约束。安装说明和源码不证明当前实例已加载；应分别核对事件到达 Manager、返回上下文被应用及工具拒绝被执行。

这是独立事件插件，可与 DSH 消息工具插件并存。旧消息工具插件自行施加的通信限制不受此插件控制。
