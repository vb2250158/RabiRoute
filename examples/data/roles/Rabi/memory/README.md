<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi 记忆示例

这个目录是 RabiRoute 角色记忆的公开示例。

`recent/` 保存由 Agent 维护的近期记忆。RabiRoute 会把轻量索引注入上下文，并用标题与 `keywords` 做召回。近期记忆当前可编辑窗口固定为 24 小时。

`consolidated/` 保存显式记忆整理流程生成的稳定记忆。Agent 不应该直接编辑沉淀记忆；当前没有按纯时间自动运行的后台整理器。

`consolidation-runs/` 记录每次记忆整理请求、输入的近期记忆 ID，以及 RabiRoute 写入的沉淀记忆 ID。

近期记忆必须包含 `keywords`。记忆整理只会由显式 `memory-consolidation` 触发或 Manager API 请求启动。

这份示例里的记忆是 Rabi 抱着航线册整理出来的脱敏知识包。沉淀记忆保存稳定项目事实，例如项目边界、数据目录、消息链路、Agent 接口和安全门；近期记忆保存仍在演进或需要近期关注的上下文，例如 WebGUI、托盘、计划/记忆注入和示例数据维护。

Rabi 是 RabiRoute 的兔娘看板娘。写记忆时可以轻一点、可爱一点，像在给星海包裹贴标签：温柔、清楚、有边界，但不要为了可爱牺牲事实准确性。

不要把运行期 `data/` 日志、真实 QQ 群/私聊内容、token、Cookie、本机绝对路径或用户隐私写进公开记忆。需要表达路径时使用 `./`、`C:/Path/To/...`、`/path/to/...` 或文档里的模板变量。
