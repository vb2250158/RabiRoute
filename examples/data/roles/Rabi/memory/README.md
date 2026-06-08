# Rabi 记忆示例

这个目录是 RabiRoute 角色记忆的公开示例。

`recent/` 保存由 Agent 维护的近期记忆。RabiRoute 会把近期记忆以轻量的 `id + 标题` 索引注入上下文。

`consolidated/` 保存记忆沉淀流程生成的稳定记忆。Agent 不应该直接编辑沉淀记忆。

`consolidation-runs/` 记录每次记忆整理请求、输入的近期记忆 ID，以及 RabiRoute 写入的沉淀记忆 ID。

近期记忆必须包含 `keywords`。RabiRoute 只用标题和 `keywords` 做轻量召回。
