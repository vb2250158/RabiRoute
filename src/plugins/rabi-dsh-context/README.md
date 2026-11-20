[English](README_en.md) | 简体中文

# Rabi DSH Context

通过 DSH 生命周期事件把会话入口、用户消息、工具前后和轮次结束交给 Rabi Manager。角色、开关与执行决策由 Manager 管理；插件不保存第二份规则。

在 Agent 端点击“更新 Hook 到 Agent”，安装到本机 DSH `web` profile，再重新加载插件或重启 DSH。Manager 地址每次经 Host 发现并核对 `/meta`；源码或测试可通过 `RABI_MANAGER_URL` 提供完整地址。Manager 不可用时记录错误，DSH 仍可独立使用。

开发归属见[统一 Agent 接入规范](../../docs/agent-adapter-standard-requirements.md#功能归属rabi-优先宿主只补必要能力)。本 Hook 只补 Rabi 无法直接捕获或应用的 DSH 生命周期事件和本地动作，不自行选取记忆、定义角色、推进计划或调度跨 Agent 任务；这些公共业务由 Rabi 决定，供 DSH、Codex 等端复用。Rabi 返回的决定仍受 DSH 自身权限约束。安装说明和源码不证明当前实例已加载；应分别核对事件到达 Manager、返回上下文被应用及工具拒绝被执行。

这是独立事件插件，可与 DSH 消息工具插件并存。旧消息工具插件自行施加的通信限制不受此插件控制。

插件列表中的名称和描述随 DSH 的中文、英文语言设置切换。

注入消息使用生产者来源 `source.kind=rabi-dsh-context`，兼容 DSH V4 会话格式；再次提交用户提示时排除同一来源的上下文，避免回传自身内容。

插件从 DSH 的 `agent/created` 读取 `startup`、`resume`、`clear` 或 `compact` 来源，在该 Agent 首次进入模型步骤时发送一次 `SessionStart`；被拒绝的步骤不会消耗该事件。普通 fork 与 subagent 沿用 DSH 发布的来源，不按父会话字段重新分类。Agent 销毁后清理本地状态，恢复同一身份会开始新的生命周期。

两个钩子插件均支持协作时，由 dsh-rabiroute-agent 统一派发各生命周期事件。已登记的 Rabi Agent 实例与显式指定的桥接端点保留各自的传输路径。Manager 返回的工具拒绝和 Stop 续轮决定在原会话生效。

与原生 Agent 插件共用时，可在 DSH PluginManager 中为 `rabi-dsh-context` 保存插件配置 `{"hostExecutable":"C:/path/to/RabiRouteHost.exe"}`，填入原生 Agent 当前连接所对应的 RabiRoute Host 的绝对路径。保存后热重载该插件即可。每次请求都从指定 Host 的 `--command status --json` 获取地址，再用 `/meta` 核对同一个 Manager 实例及应用代际。配置的路径优先于已登记实例和环境变量。该 Host 不可用或身份不符时会报告连接失败，留空则沿用原有发现方式。

「任务过程文本」读取当前轮次公开的助手正文。DSH 确认开始下一步后，插件通过原会话的接入发送该条消息的 ID 和正文。半途加载插件时从下一轮开始接收。
