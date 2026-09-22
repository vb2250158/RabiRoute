[English](plan-resources_en.md) | 简体中文

# 计划附件与步骤文件记录

计划附件仍使用 `PATCH /api/roles/:roleId/plans/:planId` 的 `attachments` 字段。追加时先读取最新计划和强 ETag，保留旧附件 ID，再加入新内容。单次最多上传 8 个新文件，每文件 10 MiB，新内容合计 25 MiB；仅保留的旧附件不占本次上传额度。请求使用 `If-Match` 与稳定 `Idempotency-Key`，提交后通过同一计划详情回读附件 ID 和 SHA-256。省略整个 `attachments` 字段保持不变；明确传空数组仍表示清除附件。

步骤通过 `steps[].resourceRecords` 保存改动记录，独立于有长度限制的步骤说明。每条记录包含唯一 `id`、来源 `sessionId`、ISO 时间 `time` 及 `resources`。资源包含 `path`、`change`（`added`、`modified`、`deleted`）、`summary`、可选 `sha256` 和 `attribution`（`tool-observed` 或 `agent-reported`）。已有同 ID 记录不可改写；更新步骤而省略记录时保留原记录。Rabi Web 在步骤内显示“文件变动”。这些记录说明改动来源，不代替代码评审或验收。

宿主应只收集已接受的用户附件。单计划可自动归档；多计划必须让执行 Agent 显式指定计划，重新验证完整会话绑定，并为文件改动指定步骤。不得通过会话标题猜绑定，不得将全部工作区差异自动归入当前步骤。

DSH 的 `rabiroute_plan_resources` 提供 `list`、`select` 和 `record_changes`；该工具从执行上下文取得会话身份，不接受外部会话 ID。附件和步骤变更采用可恢复待发送记录。未知写入结果保留原请求，不换键自动重放；原用户消息不改写，模型提示通过正式会话上下文记录。
