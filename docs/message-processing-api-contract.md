<!-- docs-language-switch -->
<div align="center"><a href="./message-processing-api-contract_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 消息处理控制接口的可执行合同

> 状态：源码迁移与专属隔离测试；整包构建、安装版及真实跨机验收由总体验收分别确认。

`io.rabiroute.manager.message-processing-control` 通过 `createMessageProcessingOperations()` 注册 7 个公开操作。相同定义安装路由、校验请求与响应并进入活动目录；不再调用旧 `handleMessageProcessingApi` HTTP 分发或维护 exact/prefix 清单。原发现 ID `processing:METHOD:/api/message-processing/...` 作为新合同的别名保留，不创建第二条路由。

## 操作与数据拥有者

操作 ID 使用 `manager.message-processing.` 前缀。

| 后缀 | 方法与路径 | 原拥有者 |
| --- | --- | --- |
| `board.read` | GET `/api/message-processing/board` | 原看板聚合服务，保留 routeId / limit 查询 |
| `requirement.record` | POST `/api/message-processing/requirements` | 原 Board 的 register_group / dispatch / dispatch_failed |
| `requirement.read` | GET `/api/message-processing/requirements/:requirementId` | 原需求及其稳定身份，缺失返回 404 |
| `send-context.read` | GET `/api/message-processing/requirements/:requirementId/send-context` | 原上下文恢复与审阅快照，保留 sourceMessageId 查询 |
| `send-context.approve` | POST 同一 send-context 路径 | 原内容、版本、期限绑定的审阅凭据 |
| `outcome.record` | POST `/api/message-processing/requirements/:requirementId/outcome` | 原事实核验、来源与版本围栏、Board 结果提交 |
| `knowledge-callback.record` | POST `/api/message-processing/requirements/:requirementId/knowledge-callback` | 原知识记录核验、Board 回调记录与提醒 |

鉴权远端连接使用相同公开接口。来源 Agent 的显式会话身份、需求归属、原事实核验和内容审阅属于请求正确性及原业务合同；人格、计划和 Skill 不额外授予接口功能许可。上下文审阅操作只生成原业务审阅凭据，不发送消息，也不新增连接授权。

## 状态、并发与恢复

`createMessageProcessingOwner()` 直接调用原 Board、上下文审阅、事实记录核验、计划基线、提醒和事件服务。状态归原 Board，落盘、去重及清理策略不在接口层复制。

登记消息组保留原 requirementId 和来源消息身份。原 Board 返回 `created`、`existing` 或 `replay_suppressed`；抑制历史重放时不重复安排提醒或发布看板变化。不会为了接口迁移生成新需求、新消息或替代幂等键。

结果和知识回调先等待原异步事实核验，再复验原请求来源及需求 `updatedAt`，随后才提交原 Board。核验期间来源失效、Node 撤权或需求改变时，不能把旧核验用于新状态。消息结果仍通过原计划基线、提醒和看板事件继续处理。

只有消息组登记具有原生身份去重语义。其他写操作没有新增通用幂等承诺；超时、断连或响应不确定时，先读取原需求与原审阅快照，不自动创建新 requirementId 或重发消息。审阅返回原 `sendContextReviewToken` 与 `expiresAt`，继续由原审阅服务绑定实际内容、当前上下文及期限；接口目录不使旧凭据永久有效。

## 传输与卸载

JSON 正文保留原 1 MiB 上限、空正文 `{}`、任意 Content-Type、未知字段及原生字段转换。畸形 JSON 保持 400；超出相同上限改由通用注册器返回标准 413 与 `API_REQUEST_TOO_LARGE`，替代旧 400。原生忽略的读取正文由合同声明丢弃。已注册路径的不支持方法统一返回 405 和 `Allow`；无关路径继续交给后续入口。

原 HTTP Tracker 由注册器的操作租约替代。插件卸载停止新请求并等待已接受的原异步核验实际结束。HTTP 断开不提前释放租约；如果服务器在提交前已经观察到断开，来源复验也会检查该请求生命周期，避免把仍未提交的结果写入 Board。已经提交的状态不因为客户端未收到响应而自动回滚。

## 验证范围

专属接口测试使用真实合同注册器、隔离 HTTP 服务和真实 Node 登记，并使用原 `MessageProcessingBoardStore` 的临时持久文件验证新增、去重、明确来源的结果提交及独立重开回读。另覆盖核验期间来源改变、Node 撤权、需求版本改变和服务器确认断连后的租约等待。平台、Agent 投递、计划核验及提醒边界为受控夹具，不操作真实消息或计划。

原 Board 和上下文审阅回归测试同时运行，覆盖原状态、历史去重、事实证据、原发送来源、内容审阅和过期规则。这些证据不等同于正式安装包或真实双机消息验收。

总体验收见 [目标架构](api-contract-discovery-target-architecture.md) 与 [实施记录](api-contract-discovery-implementation-progress.md)。
