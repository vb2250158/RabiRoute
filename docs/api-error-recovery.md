<!-- docs-language-switch -->
<div align="center"><a href="./api-error-recovery_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 从接口错误取得正确参数

错误响应保留原 HTTP 状态、`errorCode`、`field` 和 `repair`。先读取错误指定的只读接口，再判断原请求如何处理。查询失败不表示目标不存在；401/403 表示当前连接没有访问权限。正文、凭据和远端实际目录不进入参数错误提示。

本页说明源码版本 0.10.2 提供的指引，部署版本可从 GET /meta 核对。接口帮助来自当前已注册 operation 合同；构建、隔离验收和正式安装分别记录。对代理透传、未知 JSON 扩展和宽松 schema，仅能覆盖已声明约束，不能推定所有业务错误已覆盖。

## 逐接口续查范围

### 上传字段指引

0.10.2 细化上传错误的字段指引。仅本地 store 明确校验输入时附字段：文件名为 `headers.x-rabiroute-file-name`，声明长度的格式为 `headers.content-length`，摘要格式为 `headers.x-rabiroute-content-sha256`，非字节内容为 `body`。合法文件名取原文件 basename 后 encodeURIComponent；解码后须符合原 store 的255字节、Windows名称/字符和空白限制。长度按原始未压缩字节计，摘要由相同原字节计算；当前合同读 `GET /api/agent/help?operationId=agent.upload.write`。

收到字节与已声明长度或摘要不相符时，保留原422/integrity并标 `body`；已有回执时 replay 超长仍409/conflict。此证据只能证明不匹配，不能断定应改正文、长度或 SHA。先 `GET /api/agent/uploads/<原uploadId>` 核对原 `fileName/size/sha256/expiresAt`，保留原 ID、请求和冻结内容，不自动重传、换 ID 或修改摘要。404 回执不授权重传或证明其它操作未发生；存储配额、权限撤销、unknown 和既有回执语义不变。

内部磁盘、record/reservation/lease 或读取期间的完整性失败维持原码和 HTTP，不附猜测的参数字段；任意远端/普通 Error 携带的 field、message 或 repair 不进入这套提示。仅接受原本地错误类与固定 code/field 配对，无新增错误注册表、来源门或拒绝条件。其它接口与普通内部/I/O 分类继续原 pending。

### 知识检索参数与索引可用性

0.10.1 的知识检索指引与索引更新由原拥有者提供。知识 search 的明确参数错误使用 `KNOWLEDGE_PARAMETER_INVALID` 和 `query.query/mode/kind/limit`；格式不正确的 cursor 为 `KNOWLEDGE_CURSOR_INVALID`、400，索引版本过期为 `KNOWLEDGE_CURSOR_EXPIRED`、409。错误给出同角色 `GET /api/roles/:roleId/knowledge/cache/status` 与 search summary 查询，以及当前 operation help。409 恢复保留原 role/query/mode/kind/archived/limit，只先省略旧 cursor 读取第一页，随后原样使用返回的 nextCursor；不改条件或自动 POST reload。

reload 的 `kind/id` 需成对提供，`all` 若提供必须布尔，`all=true` 不与 point kind/id 混用。省略 kind/id 是原普通刷新，不等于强制 full；原 Number(limit) 后整数 1..100、仅缺省时 10、重复参数首值、空 cursor 忽略和原宽松 JSON/未知字段语义均保留。未知 point ID 仍按原流程刷新，不新增 404 或存在性资格门。reload 是真实派生刷新动作，不是获取合法值的只读接口。

GET search/status 不修改正式计划和记忆，但原 ensure 可以冷建派生索引、注册 watch 或排队刷新，不能称为零 I/O。summary 发现不调用可能 touch viewedAt 的记忆详情。索引或已发布 catalog 未就绪仍 503，与参数 400 分开；普通传输、关闭服务和内部异常不因这批提示变成参数码。

同时修正既有局部数据可用性问题：worker 完成的一批中有坏 JSON 时仍应用健康 changes，坏原文件不改，已有坏行的最后可用 summary 和 inventory 保留；有局部错误的普通或 full 刷新均保留一次干净 membership-prune 的意图，但显式 full 只在 join 原 flight 后失效成功 fingerprint 一次，已有重排继续传成功推进的 inventory，只重读失败或变化行。后续干净读取按 inventory 加同 flight committed refs 清除旧身份（包括同文件 A→B），复用 cached text/terms/summary，并推进 version 令旧 cursor 过期，不为后续重排重复解析健康整集。整体读取拒绝仍保持冷索引未就绪或热索引旧数据，原预算和调度不变。HTTP search 的 `data.coverage` 明确 `scope=indexed-inventory`、`state=partial` 与 errors；total 只描述当前可检索 summary，不证明整个角色数据完整或未匹配对象不存在。重复计划身份按冲突身份局部计入 errors：同一身份的两份或更多文件均不选作本批新摘要，健康邻居继续可用；冷索引不任取一份，热索引保留冲突前最后可用摘要。冲突文件与成功 fingerprint 原样保留，后续未变重排不重复解析；冲突解除时重读唯一剩余文件，全部消失时按原干净清理移除。此处理仅属于派生搜索索引，不改正式计划身份、点读写入校验或原文件，不过滤已确认 committed 变更，也不把局部 errors 表示成完整数据。

本次按同一 Manager 身份、同一 catalogDigest 连续读取三页 `GET /api/agent/help?limit=200`，取得 563 项实际注册操作。563 项均已登记所属 owner、输入合同和主要语义错误边界，0 重复、0 未映射。目录的 `coverage.complete=true` 仅覆盖 `registered-routes`，其 `globalCoverage=not-proven`；这不证明所有深层错误分支均已修复或动态验收。目录、逐操作检查和各 owner 待补项保留在原任务证据中，不作为另一套运行注册表。

091 续查在新的同一身份/目录快照中取得 567 项操作：没有删除，新增下表四项；原 `manager.plugins.instances.update` 的合同改为保存后异步协调，保存成功与实际生命周期完成仍分开。0.10.0 的指引保留该异步行为、插件安装/存档与点读性能。旧 563 项证据仍属于原 082 输入。

| 091 新增操作 | 当前输入及真实只读发现 | 待补语义 |
| --- | --- | --- |
| `manager.plugins.packages.list`，`GET /api/plugins/packages` | 无业务查询参数；`data.packages[]` 含 pluginId/version/manifest/source/instanceIds | 包列表读取失败与参数错误分开；不执行包 |
| `manager.plugins.packages.import`，`POST /api/plugins/packages` | `body.sourceDirectory` 为 Manager 主机上的本地包目录；参数形状读该 operation help，已有包版本查 `GET /api/plugins/packages` | 无入口可以凭空发现调用者尚未导入的源目录；不编造路径，不新增绝对路径限制；显式不可变版本与身份冲突已补码/字段；I/O 与未分类验证仍待补 |
| `manager.plugins.instances.install`，`POST /api/plugins/instances` | 必需 expectedRevision/pluginId/version，instanceId 可选；包版本来自 `GET /api/plugins/packages`，expectedRevision 来自 `GET /api/plugins/instances` 的 `data.revision` | 包导入可能先于设置 CAS，stale revision 不证明无副作用；保留原 unknown。安装现已补显式设置与身份冲突指引，包缺失和内部故障仍分开处理 |
| `manager.plugins.instances.remove`，`DELETE /api/plugins/instances/:id` | 原实例 ID 放 path.id，当前 revision 放 body.expectedRevision；从 `GET /api/plugins/instances` 取得 | 原身份/数据保留、异步停止分别回读；已完全退役实例可能不在列表，不据空列表重建旧身份或重放 |

上述新增操作只做合同、源码和隔离夹具审查，正式环境未执行 import/install/remove。`GET /api/plugins/packages` 不提供设置 CAS revision；`instanceIds` 也不能当作全部已卸载历史的目录。原安装 owner 省略 instanceId 时的身份恢复规则保留。

包管理对已有明确状态的错误补充固定码：`PLUGIN_PACKAGE_VERSION_CONFLICT`、`PLUGIN_PACKAGE_IDENTITY_CHANGED`，以及安装/卸载的 `PLUGIN_SETTINGS_REVISION_CONFLICT`、`PLUGIN_INSTANCE_NOT_FOUND`、`PLUGIN_INSTANCE_SETTINGS_INVALID`、`PLUGIN_INSTANCE_ID_CONFLICT`。字段分别指向原 sourceDirectory/version、expectedRevision、实例 ID 或已有保存设置；help 使用当前操作 ID。原 400/404/409 和原 unknown 保留，不因 stale CAS 宣称包导入未发生，也不自动替换版本、目录或实例 ID。普通 package-not-found、manifest/tree/语法及 I/O 故障尚未逐类闭合，仍列 pending，不把它们一律标成参数错误。

### 本轮增加的提示

| 触发条件 | 返回字段与合法值取得方法 | 保留的语义 |
| --- | --- | --- |
| Agent 名称有多个候选 | `AGENT_SESSION_NAME_AMBIGUOUS`、`field=title`；按原 `agentAdapter/instanceBinding` 使用 `POST /api/agent/threads` 的 `action=list/read`，沿 `nextOffset`，核对完整 ID | 原 409/candidates 或发送入口原失败状态；查询不自动选择、创建或投递 |
| adapter 或 action 不支持 | `AGENT_THREAD_ADAPTER_UNSUPPORTED` / `AGENT_THREAD_ACTION_UNSUPPORTED`；读取 `GET /api/agent-adapters/catalog` 的 managedTasks 能力及当前 `manager.agent.threads.action` help | 未发布或不可用的 provider 不是“不支持”的同义词；不启用另一 Runtime |
| 创建 caller ID 与冻结意图冲突 | `AGENT_CREATION_INTENT_CONFLICT`、`field=deliveryId`；按原来源与 caller ID 查询现有 `GET /api/agent/deliveries/caller/:callerDeliveryId` | 顶层 `creation` 与正文投递 `data` 是两项证据；不换 key/cwd/目标或重建会话 |
| 终端 after/waitMs 无效 | `TERMINAL_OUTPUT_CURSOR_INVALID` / `TERMINAL_WAIT_INVALID`，字段 `query.after/query.waitMs`；同实例、同 terminal ID 读取 `?after=0&waitMs=0` 的 `data.nextOutputSequence`，上限读错误及当前合同 | 原 400、truncated/gap 语义；不打开终端或重放输入 |
| 插件实例缺失、revision 过期、保存设置损坏 | `PLUGIN_INSTANCE_NOT_FOUND` / `PLUGIN_SETTINGS_REVISION_CONFLICT` / `PLUGIN_INSTANCE_SETTINGS_INVALID`；`GET /api/plugins/instances` 返回 `data.revision`、`instances[].instanceId` 和对应 error | 404/409 分开；保存设置损坏不表示所有实例或请求参数无效 |
| 插件 host/revision/文件不匹配 | `PLUGIN_CATALOG_HOST_INVALID` / `PLUGIN_WEB_MODULE_NOT_FOUND`；`GET /api/plugins/modules` 返回同一模块的 id/rev/entryPath，再按 `GET /api/plugins/modules/:id/:rev/:relativePath` 构造编码路径 | host 参数 400；模块原 404；不猜文件或删除产物 |
| 角色 ID、名称、revision、确认 ID 错误 | 沿原 `ROLE_*` 码补 field/repair；`GET /api/roles` 查活跃角色，`?scope=archived` 单独查归档，分别沿 nextCursor；`GET /api/roles/:roleId/configuration` 查 revision/roleId | 原 400/404/412/409；操作键、当前配置及原生命周期不改 |
| 计划/记忆查询枚举或原生校验、版本错误 | 原 `invalid_request/revision_conflict` 补 field/当前 help；计划列表、`plan-statuses`、原计划/整理 run 提供合法值或 ETag | `activationStatuses` 与动态 marker keys 分开；不可变 key 错误指 `body.key`，不建议更换 path 身份 |
| 计划 workflow 未就绪 | `PLAN_WORKFLOW_NOT_READY`、503；读取同角色 `GET /api/roles/:roleId/plan-statuses` | 服务就绪问题不再伪装参数 400，不创建替代 workflow |
| 明确的本地语音参数错误 | `SPEECH_PARAMETER_INVALID`、实际参数 field；模型/persona/speaker/session/device 从当前错误给出的 `GET /api/speech/...` 目录取得 | 仅已确认的本地校验附提示；上游 503、权限及取消保留 |
| 消息处理 registration 缺 requirementId/不支持 action | `MESSAGE_PROCESSING_PARAMETER_INVALID`、`body.requirementId/action`；`GET /api/message-processing/board` 和原 requirement 单项 | 原来源、requirement 和 dispatch 状态保留，不自动重发 |
| 视频模型下载网络或上游大小/SHA 失败 | `VIDEO_MODEL_DOWNLOAD_FAILED` / `VIDEO_MODEL_DOWNLOAD_INTEGRITY_FAILED`，内部上游错误为 502；`GET /api/video/models` 查原模型下载任务状态 | 与调用方上传摘要错误分开；已受理异步任务的原 HTTP 与 job.failed 保留，GET 状态不改成 502，不自动重试下载 |

创建查询沿原鉴权来源作用域，不列出其他来源的创建记录。`creation.available=true,state=absent` 只表示该来源的创建元数据无记录；`available=false` 表示证据不可读或该入口未提供此能力。`creation` 只暴露 state、intentHash 和已有 threadId，不暴露正文、title、cwd 或凭据。旧 `DELIVERY_NOT_RESERVED/canSubmitSameIntent` 继续只描述正文投递，不能据此推定没有冻结创建意图。失败查询、401/403、损坏证据和未知回执分别处理。

近期记忆单项的 `GET .../memory/recent/:memoryId` 在正常模式会更新 `viewedAt`。无副作用发现使用列表；只有取得原修改所需 ETag 时才按既有读取合同使用单项接口，并明确其 touch 行为。整理结果的 ETag 从 `GET .../memory/consolidation-runs/:runId` 取得。

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
| Agent / 远端 SDK | 原 cwd 提示；本轮补名称消歧、不支持 action/adapter、来源限定的创建元数据独立读取；SDK 原 HTTP body 保留 | 远端执行器具体失败码仍可能在 wire 丢失；其他 adapter 的特有参数、服务不可用与对象缺失待逐项细化；`agentThreads.ts` / `instanceThreadRouting.ts` |
| 实例 / Agent 管理 | 必需 `agentAdapter` 结构错误；原实例绑定查询；已知远端传输失败与参数、权限失败分离 | 原 provider 语义错误仍可能只给 message；`lanAgentManagementContract.ts` / core 的 `lanAgentRoutes.ts` |
| 文件 / 终端 | 共享结构校验、缺流和本轮输出 cursor/waitMs 指引；已知远端查询/传输错误分离；原序号、ID、gap 和 unknown 语义保留 | 远端执行器 shell、输入序号、文件 offset/version、upload 完整性等仍待逐码传播和恢复提示；这些不是已修完的同一 cursor；core 与 connector 原 owner 负责 |
| 二进制上传 | 原 errorCode/help/repair，新增路径 UUID、单值头、幂等键、媒体类型、编码、SHA256、文件名错误字段；保留配额、完整性、原 ID 与回执 | store 产生的内容长度/完整性错误维持原码，字段细化待补；`agentUploadRoutes.ts` / `agentUploadContract.ts` |
| 计划 / 记忆 / 附件 | 本轮补原生 invalid_request/412 和查询枚举指引、精确 run ETag、不可变 body.key、真正 workflow 未就绪 503；原 ETag/CAS 和回执保留 | historyId/打开 binding、附件、companion、identity/knowledge/recording 等特有深层错误仍有 message-only 或分类缺口；不能把全 persona 170 项称全部修完 |
| 角色 / 全局配置 | 本轮补角色已知 ROLE_* 字段、活跃/归档列表、配置 revision/确认查询 | 全局 Route 目录/生命周期头、配置路径/枚举的 owner 语义仍待补；不调用配置读取可能返回的凭据 |
| 插件 / 插件配置 | 本轮补实例缺失、revision 冲突、损坏设置、host 及模块路径恢复 | 插件初始化/退休/资源解析的内部错误与配置错误仍分开保留；不增加能力或默认启用限制 |
| 消息发送 / 历史 / 资源 | 结构共享覆盖，既有 send capabilities、history repair、资源列表保留 | 平台业务字段按原能力合同逐项补；`agentSendOperations.ts`、`personaHistoryOperations.ts`、`lanAgentReadOperations.ts` |
| 语音 / 视频 / 家庭设备等扩展 | 本轮明确语音本地校验、视频上游网络/完整性、两类 message-processing registration 参数；其他 typed code/status/outcome 保留 | QQ 本轮按授权边界仅审计不改；Xiaomi/pet/Bili/performance/其他模型配置与服务参数仍按原 owner 待补，不将所有 400 当参数或所有 503 当缺值 |

本批验证覆盖实际二进制上传 HTTP、远端管理/文件查询的隔离 HTTP 与 SDK、真实 Codex 插件打包、connector/Registry 错误消息及只读回执。它不构成正式节点、真实业务发送或已安装版本的验收。
