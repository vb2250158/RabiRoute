<!-- docs-language-switch -->
<div align="center"><a href="./dsh-session-modes_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# DSH 会话模式

在 Route 的 Agent 适配器中展开 DSH 参数，可从当前 DSH 提供的模式目录选择“会话模式”。留空会保留 DSH 当前模式；指定模式会在保存、恢复会话和投递前核对 DSH 实际模式。

“Rabi助手模式”的模式 ID 是 `rabi-assistant`，由 `dsh-rabiroute-agent` 0.13.19 起注册。该模式按 Rabi 绑定的人格对话，仅开放 `rabiroute_agent_threads`、`rabiroute_agent_send` 和 `rabiroute_manager_api`。工具运行时同时限制可见性和执行，文件、终端、浏览器及其他插件工具不开放。

Route 保存字段为 `dshAgentPreset`。DSH 已开始对话的会话不能切换模式；切换被拒绝时，保存或投递会失败，用户需要明确选择新会话。Rabi 不会在这种情况下自动新建会话或继续以原模式投递。
