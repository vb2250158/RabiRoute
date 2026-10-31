<!-- docs-language-switch -->
<div align="center"><a href="./agent-thread-api-contracts_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# Agent 会话控制接口合同

本文面向 Manager、插件和 Agent 接入开发者。`agentThreadControlOperations.ts` 用同一份可执行定义安装路由并发布发现目录；`agentThreadControlRoutes.ts` 的 functional owner 保留原业务编排。真正发现、读取、创建元数据、重命名和执行消息的仍是原 adapter/driver；本次不新增执行 Runtime。

## 实际入口与操作

| 当前 operation ID | HTTP 入口 | 行为 |
| --- | --- | --- |
| `manager.agent.threads.list` | `GET /api/agent/threads` | 原默认 adapter 的 `list`，接受 `query`、`limit`、`offset` |
| `manager.agent.threads.action` | `POST /api/agent/threads` | JSON `action` 选择原生支持的操作 |

两个原目录 ID `agent:GET:/api/agent/threads`、`agent:POST:/api/agent/threads` 作为别名解析到当前定义，不再安装第二套 handler。返回体保留原顶层 `code`、`action`、`threads/thread`、`communication`、`delivery` 和错误字段，不额外套 `{data: ...}`。

| POST action | 真正负责的入口 | 结果含义 |
| --- | --- | --- |
| `list` / `read` | 原 adapter 的会话发现/精确读取 | 返回完整 ID、可见名称和原生会话内容；不创建 |
| `open` | 原宿主打开会话功能 | 沿用宿主是否支持的事实，不证明执行消息 |
| `resolve` / `create` | 原会话 resolver 和持久创建 reservation | 沿用已有名称/ID/workspace、归档与幂等规则 |
| `rename` | 原 owner 的元数据命名功能 | 改显示名称，不用名称代替完整任务身份 |
| `send` | 原 owner、端点投递和请求账本 | `delivered`、`delivery_unconfirmed` 和 tracking 失败分别处理 |
| `reconcile_delivery` | 原投递 reservation 与回执恢复 | 核对原 delivery，不重新发送 |

不同 adapter 的支持范围由其实际协议决定。此 owner 当前没有 `delete` 或 `cancel` action，不为补目录编造业务能力。Codex 真实消息继续只进入 Desktop 任务 owner；元数据 bootstrap 不执行真实 prompt，Desktop 缺席时不启动备用 Runtime。模型、工具、审批和宿主生命周期保持原归属，见 [Desktop 接入合同](./codex-desktop-agent-acceptance.md)。

## 准备、来源与执行

准备阶段在正文解析前保存原可信 connector 和设备来源，之后重新核对鉴权 lease、来源节点/connector/provider 和设备身份。来源上下文、人格、Route、Skill 和已保存会话不构成逐功能授权。已鉴权空节点也可以列表和管理会话；发送仍需可证明的原来源身份。

普通远端 Agent 可以显式指定尚未保存的 `sourceThreadId`，按当前 canonical `messageSource.sessionName` 展示名称；节点和 connector 身份始终来自已鉴权入口。正文里的 `remoteSource`、`trustedDeviceSource` 和 `callerExecutionOptions` 无法创建可信来源或覆盖内部快照。应用连接不能替代真实 Desktop Agent 或设备来源。

调用方明确选择的 `cwd/model/reasoningEffort/sandbox/dshDeliveryMode` 在应用 Route 默认值前形成冻结快照。之后仍调用同一原生 `handleAgentThreadRequest` 和请求选项，不另外实现 resolver、模型选择、工具或投递规则。

## 参数、回执和生命周期

GET 保留 `URLSearchParams.get` 的第一值语义。原生列表默认 100 条、最大 200 条，有限数值向下取整并夹住范围，非法 limit 使用默认值，非法/负 offset 归 0；后续页由 `nextOffset` 指示，不把前 100/200 条当成全部会话。不同 adapter 的完整 ID 和 workspace 规则由原 driver 验证。

POST 合同描述公开 DTO 结构，原 driver/ledger 保留 action、路径根、来源、prompt/image、模型、创建 reservation 和幂等的语义校验。原生接受的 null/default/coercion 和扩展字段保持原解释；空 JSON 正文默认 `{}`，不新增应用层字节上限。未知 action 失败，未知功能不切换到另一个宿主。

Handoff 仍更新同一 `AgentRequestStore` 和 message-processing board，再发布原事件与刷新提醒。已接受回答但回填失败时保留 `delivered_tracking_failed` 和原警告，不能因此重发。原 owner 完成后再次核对来源；有副作用的原调用已返回、来源却失效时标记不确定，保留原 delivery ID 供回读。

卸载先停止接受新请求，再等待已接受正文和原 driver 工作真正结束。HTTP 断开或取消不等于 native owner 已停止；等待实际清理后才能退休注册。取消会阻止后续新工作和 tracking，不把仍在执行的原 driver 当成已经结束。

## 验证边界

隔离测试覆盖无保存会话的已鉴权空节点成功调用、205 条会话分页、全名称/ID、来源伪造、显式未保存来源、原设备撤销、执行快照、切换来源/代次、断开后的真实 drain，以及中英文文档中的原账本 reconcile。测试使用受控 driver 和临时存储，不向真实 Desktop、设备或其他用户发送任务，也不改变宿主成熟度。完整构建、安装版和真实双机验收仍属于[整体目标架构](./api-contract-discovery-target-architecture.md)。
