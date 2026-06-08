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
