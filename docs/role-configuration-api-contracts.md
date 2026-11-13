[English](role-configuration-api-contracts_en.md) | 简体中文

# 角色配置与生命周期 API

本文描述当前源码合同。具体安装版本支持情况以当前 Manager 的接口目录及运行验收为准。

`createRoleConfigurationOperations` 注册角色配置、正文、自动化与生命周期的可执行 HTTP 契约，`createRoleConfigurationOwner` 持有配置、revision、角色锁、原生操作回执与生命周期编排。角色无需绑定消息路线（Route）。已经鉴权且未显式禁用的远端连接与本机调用使用同一 owner，不额外要求角色绑定、功能白名单或管理密钥。

角色页面把最近一次成功加载的角色 ID 和来源电脑保存在主机桌面设置 `lastRoleSelection`；无指定角色的入口优先恢复该引用。来源不可用或角色已归档时保留原引用并显示实际状态。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/roles` | 分页列出活动角色；`scope=archived` 查询归档角色；支持 `query`、`cursor`、`limit` |
| POST | `/api/roles` | 以 `roleId`、`title`、可选 `document` 与完整 `config` 创建角色；补齐默认自动化，创建使用当前定时配置版本 |
| GET | `/api/roles/:roleId/configuration` | 读取配置、配置 revision、归档状态、工作数量与路线引用 |
| PUT | `/api/roles/:roleId/configuration` | 用 `expectedRevision` 替换角色拥有的配置字段 |
| PATCH | `/api/roles/:roleId/configuration` | 用配置 revision 局部更新完整 `personaConfig.json` 的顶层字段；省略保留，`null` 删除 |
| GET | `/api/roles/:roleId/document` | 读取 `document`、完整 `personaConfig`、整包 `revision` 与 `configurationRevision` |
| PUT | `/api/roles/:roleId/document` | 用整包 `expectedRevision` 保存 `document` |
| GET | `/api/roles/:roleId/references` | 查询路线、其他角色配置引用与运行工作数量 |
| POST | `/api/roles/:roleId/archive` | 归档并暂停接收新工作 |
| POST | `/api/roles/:roleId/restore` | 恢复角色 |
| POST | `/api/roles/:roleId/delete` | 彻底删除已归档且无引用、无工作租约的角色 |

角色 ID 沿用原生 Unicode 字母、数字、下划线和连字符规则。列表每页最多返回 25 项、最多检查 200 个目录；有 `nextCursor` 时继续读取。单个损坏目录返回错误项，不伪装为正常角色。每批最多并行读取 4 个目录，结果仍按角色 ID 顺序返回；界面逐页显示结果。

读取不存在角色的 `/configuration` 返回 404、`ROLE_NOT_FOUND`，不创建角色或恢复记录。受管角色根不可用、配置损坏和元数据损坏分别保留原有运行错误；它们不会被转换成角色不存在。

配置保存、归档、恢复和删除要求稳定的 `Idempotency-Key`（1–128 位 ASCII 字母、数字、`:`、`.`、`_`、`-`）及请求体中的 `expectedRevision`。revision 是角色元数据与完整配置内容的 SHA-256；不等于元数据中的递增计数。冲突返回 412。同键不同角色、动作或载荷返回 409。`confirmationId` 必须精确等于待删除角色 ID。

原 PUT 只替换 `ROLE_CONFIGURATION_KEYS` 中的字段，保留扩展字段；被省略的角色配置字段会清除。PATCH 的请求为 `{ expectedRevision, config: { ...顶层修改 } }`，支持 `contextInjection` 等完整角色配置；嵌套对象作为一个字段替换。GET `/configuration` 保持原 `config` 投影，另外返回完整 `personaConfig`。PATCH 自动化数组时只校验及规范化新增或变化的规则；未变的历史异常项原样保留，不阻断其他配置或正常规则的修改。新追加的异常项明确返回 400。保存与创建保留 `assertRoleAcceptsWork`；归档后已有工作可以完成，新工作拒绝进入。

正文读取返回的 `revision` 覆盖元数据、完整配置和 `persona.md`，用于 PUT `/document`；其中 `configurationRevision` 与 GET `/configuration` 的原 revision 相同，用于配置 PUT/PATCH 和自动化命令。正文修改不会改变配置 revision；配置修改会使旧正文 revision 失效。正文只操作规范 `persona.md`，不接受任意路径。正文与配置复用 `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES`、`RABIROUTE_PERSONA_CONFIG_MAX_BYTES`；默认 0 表示没有应用层额度，实际运行时容量仍适用。配置额度按正式文件的实际 UTF-8 字节判断；HTTP JSON 和操作回执不附加另一组固定额度。显式额度超限返回 413，非法设置返回 503 `READ_SETTING_INVALID` 并指出字段与修改入口。

同一操作键先获取操作锁，再获取角色锁；并发占用返回 409 `ROLE_BUSY`。原生角色锁与 Gateway 工作准入共用 `.role-state/locks`。回执保存在角色根下 `.role-state/operations`；原始操作键经 SHA-256 后用作文件名。配置、正文或元数据写入前保存 pending 回执，原子 JSON 写入及目录刷新完成后保存 committed 结果。相同键和载荷可按原生流程核对 pending 结果，或读取已提交结果；不得换键重放结果未知的写入。

删除还检查已禁用路线、其他角色自动化、未确认工作租约、角色目录边界和递归链接。删除标记保存在 `.role-state/deleted`，防止同 ID 无声重建。整个删除过程没有跨文件原子事务；中途失败需保留原操作键并核对原回执。

创建推荐携带稳定 `Idempotency-Key`。owner 将完整正文和配置写入 `.role-state/creating` 中的原操作暂存目录，两份文件完成后原子 rename 发布角色目录；普通目录列表不会展示未完成的创建。创建回执使用同一 `.role-state/operations`。相同键和载荷可完成原暂存创建、核对已发布内容或返回原 committed 结果；同键不同载荷返回 409，结果未知时不能换键重建。发布后角色已被其他入口改动时保留 uncertain，避免旧创建覆盖新内容。旧的不带键创建仍可用；响应丢失后应先检查原角色。目录发布与目录刷新不是跨文件事务，故障保留原回执并返回 `uncertain: true`。

请求 prepare 在读取正文前捕获原连接、动态角色根与 Manager generation/instance。owner 在异步边界、写入前、目录刷新前后及披露前复核。切代、换根、撤权和只读状态变化拒绝继续；业务写入已经开始时保留 `mutationOutcome: unknown` 与不确定结果，不附带旧业务数据。底层原子文件操作或锁清理需要实际完成后才释放请求。

客户端必须保留所有 `uncertain: true` 或 `mutationOutcome: unknown` 响应的原操作键和载荷，包括 403/409。不能仅凭 4xx 清除恢复记录；重新连接后应继续核对原回执。

请求拥有者的复核会传入原生原子 JSON 写入：创建父目录后、写完临时文件后及正式 rename 前检查原连接、角色根和 Manager 身份。复核失败会清理临时文件并保留原正式文件；已经发起并完成的 rename 仍按实际提交记录审计，结果未知时按原回执核对。不传复核函数的原生后台调用保持原行为。

本接口通过统一注册器执行解析、请求/响应 Schema 校验、连接复核及异步租约管理。契约摘要描述接口版本，不替代原生 `expectedRevision`。未注册的方法由统一路由层处理；旧 boolean handler 已移除，不能作为旁路继续挂载。

参见[代码架构](code-architecture.md)、[源码热补丁](source-hot-patches.md)。安装版验收需另外核对当前 Manager 身份、契约目录、实际 HTTP 行为和发布候选 hash。

定时规则可通过 `timeOfDays` 在一条规则中指定多个每日时间；提供该字段时优先于旧的 `timeOfDay`。保存其他设置不会自动迁移定时配置版本。

自动化规则的查询、创建、局部修改和删除复用本角色 owner，见[自动化规则 API](role-automation-api-contracts.md)。Agent 通过公开 HTTP 请求完成管理，无需直接改角色业务文件。
