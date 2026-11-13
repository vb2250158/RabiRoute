[English](role-configuration-api-contracts_en.md) | 简体中文

# 角色配置与生命周期 API

状态：源码迁移；统一 Manager/plugin 接线、完整构建和安装版验收由架构迁移 owner 汇总。独立 HTTP 测试使用临时角色目录，不操作运行中的角色。

`createRoleConfigurationOperations` 注册八个可执行 HTTP 契约，`createRoleConfigurationOwner` 持有配置、revision、角色锁、原生操作回执与生命周期编排。角色无需绑定消息路线（Route）。已经鉴权且未显式禁用的远端连接与本机调用使用同一 owner，不额外要求角色绑定、功能白名单或管理密钥。

角色页面把最近一次成功加载的角色 ID 和来源电脑保存在主机桌面设置 `lastRoleSelection`；无指定角色的入口优先恢复该引用。来源不可用或角色已归档时保留原引用并显示实际状态。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/roles` | 分页列出活动角色；`scope=archived` 查询归档角色；支持 `query`、`cursor`、`limit` |
| POST | `/api/roles` | 以 `roleId`、`title` 创建角色和默认自动化配置 |
| GET | `/api/roles/:roleId/configuration` | 读取配置、内容 revision、归档状态、工作数量与路线引用 |
| PUT | `/api/roles/:roleId/configuration` | 用 `expectedRevision` 替换角色拥有的配置字段 |
| GET | `/api/roles/:roleId/references` | 查询路线、其他角色配置引用与运行工作数量 |
| POST | `/api/roles/:roleId/archive` | 归档并暂停接收新工作 |
| POST | `/api/roles/:roleId/restore` | 恢复角色 |
| POST | `/api/roles/:roleId/delete` | 彻底删除已归档且无引用、无工作租约的角色 |

角色 ID 沿用原生 Unicode 字母、数字、下划线和连字符规则。列表每页最多返回 25 项、最多检查 200 个目录；有 `nextCursor` 时继续读取。单个损坏目录返回错误项，不伪装为正常角色。每批最多并行读取 4 个目录，结果仍按角色 ID 顺序返回；界面逐页显示结果。

读取不存在角色的 `/configuration` 返回 404、`ROLE_NOT_FOUND`，不创建角色或恢复记录。受管角色根不可用、配置损坏和元数据损坏分别保留原有运行错误；它们不会被转换成角色不存在。

配置保存、归档、恢复和删除要求稳定的 `Idempotency-Key`（1–128 位 ASCII 字母、数字、`:`、`.`、`_`、`-`）及请求体中的 `expectedRevision`。revision 是角色元数据与完整配置内容的 SHA-256；不等于元数据中的递增计数。冲突返回 412。同键不同角色、动作或载荷返回 409。`confirmationId` 必须精确等于待删除角色 ID。

只替换 `ROLE_CONFIGURATION_KEYS` 中的字段，保留扩展字段；被省略的角色配置字段会清除。自动化沿用默认规则补全及显式 Agent 目标校验。保存与创建保留 `assertRoleAcceptsWork`；归档后已有工作可以完成，新工作拒绝进入。

每日定时规则可用 `trigger.schedule: { id: "daily-clock", type: "daily_time", timeOfDays: ["10:00", "14:00", "18:00"] }` 保存多个时间点，仍是一条 `automationRules` 记录，共用规则 ID、动作和启停状态。`timeOfDays` 存在时优先于旧 `timeOfDay`；缺省时继续读取旧单时间点。时间使用宿主本地时区，接受 `HH:mm` 或 `HH:mm:ss`，去重并排序。每日规则显式提交空数组、非字符串或任一非法时间会在写入前返回 400，不回退旧时间或只执行有效部分。旧单点和非每日规则的无关扩展沿原保存行为处理。PUT 时保留原 GET 返回的其他配置字段，并沿用原 revision 与操作键。

原生角色锁与 Gateway 工作准入共用 `.role-state/locks`。回执保存在角色根下 `.role-state/operations`；原始操作键经 SHA-256 后用作文件名。配置/元数据写入前保存 pending 回执，原子 JSON 写入及目录刷新完成后保存 committed 结果。相同键和载荷可按原生流程核对 pending 结果，或读取已提交结果；不得换键重放结果未知的写入。

删除还检查已禁用路线、其他角色自动化、未确认工作租约、角色目录边界和递归链接。删除标记保存在 `.role-state/deleted`，防止同 ID 无声重建。整个删除过程没有跨文件原子事务；中途失败需保留原操作键并核对原回执。

创建保持原来的多文件顺序，没有创建回执或跨文件原子性。目录或文件已落盘后发生错误时返回 `uncertain: true`；先检查原角色目录，不能换 ID 重建或将重复创建当成安全重试。

请求 prepare 在读取正文前捕获原连接、动态角色根与 Manager generation/instance。owner 在异步边界、写入前、目录刷新前后及披露前复核。切代、换根、撤权和只读状态变化拒绝继续；业务写入已经开始时保留 `mutationOutcome: unknown` 与不确定结果，不附带旧业务数据。底层原子文件操作或锁清理需要实际完成后才释放请求。

客户端必须保留所有 `uncertain: true` 或 `mutationOutcome: unknown` 响应的原操作键和载荷，包括 403/409。不能仅凭 4xx 清除恢复记录；重新连接后应继续核对原回执。

WebGUI 角色编辑器保留这些不确定响应的原操作键和原载荷。恢复期间新修改的草稿不会替换原请求；原请求确认后会保留草稿并要求再次保存。确定未开始的 4xx 拒绝可以清除对应恢复记录。

请求拥有者的复核会传入原生原子 JSON 写入：创建父目录后、写完临时文件后及正式 rename 前检查原连接、角色根和 Manager 身份。复核失败会清理临时文件并保留原正式文件；已经发起并完成的 rename 仍按实际提交记录审计，结果未知时按原回执核对。不传复核函数的原生后台调用保持原行为。

本接口通过统一注册器执行解析、请求/响应 Schema 校验、连接复核及异步租约管理。契约摘要描述接口版本，不替代原生 `expectedRevision`。未注册的方法由统一路由层处理；旧 boolean handler 已移除，不能作为旁路继续挂载。

## DS Bot 自动化目标

个人 Bot 投递使用显式目标 `action.target: { kind: "ds_bot", agentAdapter: "dsh", agentTargetId: "local:dsh", dshBaseUrl, botScopeId, botId, botName }`。本机保存所选 DSH 连接的 `dshBaseUrl` origin；远端保存原 `instanceBinding`，目标 ID 沿用该绑定的正式 ID，不能混入本机 URL。`botScopeId` 区分 DSH Home 与团队工作区，`botId` 是稳定 Bot 身份；它不是 Session ID。无需配置主角色会话，既有 `recipient: primary` 规则不会自动改为 DS Bot 投递。连接引用不保存凭据或临时运行实例 ID；缺少引用只提示修复该条规则，不猜测其他连接。

`GET /api/automation/ds-bot-rules?botScopeId=...&botId=...&agentTargetId=...` 跨存储角色读取明确指定该目标的规则，支持 `cursor`、`limit`。本机附加 `dshBaseUrl`，远端附加 URL 编码后的 `instanceBinding` JSON，完整连接条件同时用于列表、总数和分页游标。结果的 `items` 包含展示 ID、`sourceRoleId`、`rawRuleId` 和完整原始 `rule`，并返回目录 `revision`、`refreshedAt`、`maxCacheAgeMs`、`warnings` 与 `nextCursor`。目录 revision 只用于分页；修改前重新读取原 `sourceRoleId` 的配置及 revision，再用原 `rawRuleId` 更新并提交 PUT。不能把目录 revision 用作配置写入的 `expectedRevision`。

目标选择器使用原 Agent Thread 入口的 `ds_bot_catalog` 动作读取真实 Bot 目录。DS Bot 自身用 `GET /api/agent/providers/dsh/ds-bot-destination?botScopeId=...&botId=...&runtimeId=...` 核对本机唯一 DSH 目标；运行实例 ID 只用于这次发现，不保存到规则中。新任务选择存储角色，显示归属则由完整投递目标决定，与 Bot 绑定的人格无关。群聊继续使用既有 DSH 定时任务。

投递与恢复分别沿原 Agent Thread 的 `ds_bot_deliver`、`ds_bot_reconcile` 到达 DSH 的已鉴权 Bot 入口，使用稳定投递 ID 和业务正文。DS Bot 在原 Bot 的当前会话入队；accepted 表示原生队列已持久化，不表示模型已完成。结果未知时按原投递 ID 跨会话分段核对，不自动重新投递，也不覆盖 Bot 自身的人格配置。

参见[代码架构](code-architecture.md)、[源码热补丁](source-hot-patches.md)。安装版验收需另外核对当前 Manager 身份、契约目录、实际 HTTP 行为和发布候选 hash。
