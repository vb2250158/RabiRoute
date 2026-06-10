# Rabi 计划示例

这个目录是 RabiRoute 角色计划的公开示例。

计划由 Agent 通过 RabiRoute 接口维护。它们不是聊天日志，也不是执行器队列。

建议状态值：

```text
未开始
进行中
已完成
已归档
```

已完成计划会在配置的保留窗口后由 RabiRoute 自动归档。

公开示例把未归档计划放在 `items/active/` 下。RabiRoute 归档后会把条目移动到 `archive/`。

这份示例里的计划是脱敏的项目关注项，用来演示 Rabi 如何记住 RabiRoute 这个开源项目还在推进什么。它们只引用公开文档、公开目录和占位路径，不包含真实聊天、真实 QQ 号、token、Cookie、本机用户名或运行期 `data/` 内容。

`index.json` 是给 UI 或 Agent 快速预览的轻量索引；其中 `unarchivedPlanIds` 表示未归档计划，包括 `未开始`、`进行中` 和 `已完成`。单个计划详情仍以 `items/active/*.json` 为准。
