<!-- docs-language-switch -->
<div align="center"><a href="./api-error-recovery_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 从接口错误取得正确参数

错误响应保留原 HTTP 状态、`errorCode`、`field` 和 `repair`。先读取错误指定的只读接口，再判断原请求如何处理。查询失败不表示目标不存在；401/403 表示当前连接没有访问权限。正文、凭据和远端实际目录不进入参数错误提示。

当前实现为源码候选；构建、隔离验收和正式安装分别记录。接口帮助来自当前已注册 operation 合同，不另建错误接口目录。对代理透传、未知 JSON 扩展和宽松 schema，仅能覆盖已声明约束，不能推定所有业务参数已校验。

## 工作区与会话不匹配

`AGENT_WORKSPACE_MISMATCH` 表示冻结的执行 `cwd` 与目标会话登记的工作区不同。目标会话仍可能存在、未归档且可读。错误不返回远端实际目录；在原连接权限内查询：

```http
GET /api/lan-agent/instances
GET /api/agent/help?operationId=manager.agent.threads.action
POST /api/agent/threads
Content-Type: application/json

{"action":"read","agentAdapter":"codex","threadId":"complete-session-id","instanceBinding":{"instanceId":"target-instance","agentId":"target-agent"}}
```

实例列表返回 `instances[].instanceId`、`agents[].agentId/provider/workspace/sessionId/managedSessionIds`；实际字段以当前合同与目标能力为准。会话读取省略 `cwd`，返回顶层 `thread.cwd`。该操作只读取会话元数据，不修改冻结请求。

列出同一目标的会话：

```json
{"action":"list","agentAdapter":"codex","query":"","limit":20,"offset":0,"instanceBinding":{"instanceId":"target-instance","agentId":"target-agent"}}
```

沿顶层 `nextOffset` 分页。也可直接使用 `POST /api/lan-agent/instances/:instanceId/agents/:agentId/threads`，正文必须提供 `agentAdapter`，再传 `action=read` 与 `threadId`，或 `action=list` 与查询参数。直接实例接口的结果包在 `result.data`，工作区位于 `result.data.thread.cwd`。其 operation 为 `manager.lan-agent.agents.threads`。

原目标经 Peer Manager 定位时，保留原 `instanceBinding.ownerDeviceId`；通用会话查询沿同一 Peer 路由，不改成本机实例查找。

原投递返回示例（省略稳定 ID 和完整查询说明）：

```json
{"code":-1,"status":"delivery_unconfirmed","errorCode":"AGENT_WORKSPACE_MISMATCH","field":"cwd","delivery":{"status":"unconfirmed","retryable":false},"error":{"stage":"target_delivery","code":"AGENT_WORKSPACE_MISMATCH","field":"cwd","retryable":false},"repair":"POST /api/agent/threads 读取同一完整会话，省略 cwd；GET /api/lan-agent/instances 核对绑定。保留原请求、deliveryId、回执和冻结 cwd。"}
```

HTTP 202 与原 `dispatching` 状态保留。参数原因不能单独证明某次投递没有执行。查询不授权改写冻结 cwd、创建替代会话或重投正文。用 `GET /api/agent/deliveries/:deliveryId` 只读取得原状态、`errorCode/field/repair`；原 caller 查询 `GET /api/agent/deliveries/caller/:callerDeliveryId` 继续使用原来源查询参数，并返回 `data.detailPath`。不要通过再次发送正文取得错误详情。

## 结构参数错误

共享校验返回 `API_REQUEST_SCHEMA_INVALID`，`field` 指向 schema 声明的字段，例如 `body.agentAdapter`；`repair` 给出违反的规则和 `GET /api/agent/help?operationId=<URL编码的原operationId>`。合法类型、枚举、必需字段与约束从 `data.operations[].contract.request` 读取。未知属性名、提交值、认证头和正文不会回显。嵌套或组合 schema 无法安全定位时，字段停留在其已声明父级。

```json
{"code":-1,"errorCode":"API_REQUEST_SCHEMA_INVALID","field":"body.agentAdapter","operationId":"manager.lan-agent.agents.threads","retryable":false,"repair":"Parameter violates schema rule required. Read GET /api/agent/help?operationId=manager.lan-agent.agents.threads; use data.operations[].contract.request ..."}
```

`LAN_AGENT_MANAGEMENT_NOT_SENT`、`LAN_AGENT_MANAGEMENT_TIMEOUT` 是远端传输错误，返回 503；只读请求给出 `reason=remote_query_failed`。它们不证明参数无效或文件/会话不存在。写入超时保留 `uncertain=true`，查询原回执后再决定。401/403 的原鉴权分支优先执行。

## 覆盖矩阵与后续批次

### 未打开的终端输出流

`GET /api/lan-agent/instances/:instanceId/terminals/:terminalId?after=0&waitMs=0` 在当前 Manager 连接没有该输出流时继续返回 HTTP 400，并增加 `errorCode=TERMINAL_STREAM_NOT_FOUND`、`field=path.terminalId`、`reason=terminal_stream_not_open`。这不是参数格式错误或远端进程不存在的证明。

`help` 指向同一实例的 `GET /api/lan-agent/instances/:instanceId/terminals`，返回 `data.shells` 与 `data.sessions`。`repair` 给出原 ID 的 `POST` 打开示例 `{"action":"open","terminalId":"<原terminalId>","shell":"<从data.shells选择>"}`；打开合同从 `GET /api/agent/help?operationId=manager.lan-agent.terminals.execute` 读取。查询不会自动打开终端或重放输入，只有原任务已授权打开时才使用该示例。查询和权限失败分别处理。

“结构已覆盖”仅指通过共享 operation 校验器的已声明 schema；原 owner 的语义校验另列。未声明字段、原始代理和透传响应不转成统一兜底错误，不新增默认禁用、名单、重试或执行状态。

| 接口族 | 已覆盖 | 待覆盖的 owner 语义与真实入口 |
| --- | --- | --- |
| 管理 API / operation 目录 | 已声明 path/query/headers/JSON schema 的字段、原因、当前 help 查询；JSON/媒体/长度错误沿用稳定码及真实合同入口 | 原始 HTTP 代理、passthrough 和宽松 schema 仍由原 owner 说明；`managerPluginRouteRegistry.ts` / `apiOperationContract.ts` |
| Agent / 远端 SDK | Codex 冻结 cwd 冲突从 native owner 经 connector 与 Manager 到原响应；只读回执保留帮助；SDK 保留原 HTTP body | 其他 adapter 的名称消歧、unsupported action、创建意图冲突仍需逐项补只读发现；`agentThreads.ts` / `instanceThreadRouting.ts` |
| 实例 / Agent 管理 | 必需 `agentAdapter` 结构错误；原实例绑定查询；已知远端传输失败与参数、权限失败分离 | 原 provider 语义错误仍可能只给 message；`lanAgentManagementContract.ts` / core 的 `lanAgentRoutes.ts` |
| 文件 / 终端 | 共享结构校验与真实 help；未打开输出流的准确原因与同实例 list/open 指引；已知远端查询/传输错误分离，保留原输入序号、文件/上传 ID 与 unknown 语义 | 远端执行器 shell、path、offset、版本等业务错误仍需逐项补字段和只读参数发现；core 的 `lanAgentInteractiveContract.ts`、connector `terminal-service.mjs` / `computer-service.mjs` |
| 二进制上传 | 原 errorCode/help/repair，新增路径 UUID、单值头、幂等键、媒体类型、编码、SHA256、文件名错误字段；保留配额、完整性、原 ID 与回执 | store 产生的内容长度/完整性错误维持原码，字段细化待补；`agentUploadRoutes.ts` / `agentUploadContract.ts` |
| 计划 / 记忆 / 附件 | 已声明结构共享覆盖；已有 ETag/CAS、缺失计划查询指引保留 | planId/status/binding/附件业务错误逐项补；原 `GET /api/roles/:roleId/plans`、`GET /api/roles/:roleId/plan-statuses`；persona 的 `personaStorageOperations.ts` / `personaPlanOperations.ts` |
| 角色 / 全局配置 | 已声明结构共享覆盖，原权限与生命周期校验保留 | roleId/revision/配置枚举查询提示待补；实际读取合同由当前 help 查 `roleConfigurationOperations.ts` / `gatewayControlOperations.ts` |
| 插件 / 插件配置 | 已声明 schema/CAS 共享覆盖 | 缺失实例、revision 与原生插件目录错误待补；`GET /api/plugins/instances`，`pluginManagementOperations.ts` / `pluginCatalogOwner.ts` |
| 消息发送 / 历史 / 资源 | 结构共享覆盖，既有 send capabilities、history repair、资源列表保留 | 平台业务字段按原能力合同逐项补；`agentSendOperations.ts`、`personaHistoryOperations.ts`、`lanAgentReadOperations.ts` |
| 语音 / 视频 / 家庭设备等扩展 | 已声明操作结构共享覆盖，保留各 owner 的幂等与授权 | 服务/模型/设备合法值、配额及业务失败逐项补；从当前 help 选择实际插件操作，不能据静态文档推定插件已启用 |

本批验证覆盖实际二进制上传 HTTP、远端管理/文件查询的隔离 HTTP 与 SDK、真实 Codex 插件打包、connector/Registry 错误消息及只读回执。它不构成正式节点、真实业务发送或已安装版本的验收。
