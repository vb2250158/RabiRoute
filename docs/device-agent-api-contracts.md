<!-- docs-language-switch -->
<div align="center"><a href="./device-agent-api-contracts_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 设备 Agent 邮箱接口合同

本文面向 Manager 和设备宿主接入开发者。`src/agentAdapters/deviceAgentOperations.ts` 用同一份可执行合同安装 13 个 HTTP 操作并发布发现目录；`deviceAgentOwner.ts` 拥有原生业务规则和 PC 持久邮箱。原有两个目录/前缀路由声明由上述精确合同替代。

## 所有权和可观察合同

本次迁移只替换 HTTP 注册、校验和发现入口。原设备宿主仍是唯一真实执行者，PC 只管理投递、唤醒和回执。不会因缺少设备创建 PC 模型或备用 Runtime，也不修改 Desktop 启动、4510、用户环境、会话绑定或权限模型。

| 要求 | 唯一真源 | 可验证证据 | 禁止替代 |
| --- | --- | --- | --- |
| 消息进入正确会话 | 设备实际加载的完整 session ID 与 owner epoch | 原设备 claim 指定 delivery，返回相同会话身份 | 同名会话或另一 Runtime |
| 运行结果 | PC 原 delivery 回执及设备签名来源的 response | `ownerAccepted` 与终态 response 分开读取 | 202、唤醒提交或构建成功冒充回答 |
| 模型、工具和权限 | 原设备宿主 | 真机宿主的运行证据；本轮隔离 driver 只验证协议 | PC 自行执行或从提示词推断工具 |
| 新建和续投 | 设备上报的完整会话身份 | 同 owner 续期保留 epoch；替换 owner 后旧 claim 不再执行 | 自动创建替代会话 |
| 设备缺席 | PC 持久邮箱 | queued、wake 失败或 `result-unknown`，不得伪造 owner 接受 | 换投另一设备 |
| Rabi 缺席 | 独立设备宿主生命周期 | 实机独立启动验收仍单独进行 | 把路由器变成模型启动依赖 |

Host/UI、模型 Runtime、会话、turn、工具和审批由设备宿主启动、停止并拥有。PC Manager 只拥有本地持久邮箱和 HTTP/event 等待资源；连接 Relay/P2P 负责已鉴权传输。Manager 重建使旧加载租约失效；重新上报会话会把已 claim 或绑定旧 prepared owner 的 queued 行转成 `result-unknown`，不自动重放。

## 操作清单

操作 ID 前缀为 `manager.device-agents.`。

| 操作 | 方法与路径（前缀 `/api/device-agents`） |
| --- | --- |
| `list` | `GET` 根目录 |
| `session.read` / `session.publish` | `GET` / `PUT /:agentId/session` |
| `pending.read` | `GET /:agentId/pending` |
| `deliveries.enqueue` | `POST /:agentId/deliveries` |
| `wake-requests.list` | `GET /:agentId/wake-requests` |
| `wake-requests.claim` | `POST /:agentId/wake-requests/:nonce/claim` |
| `wake-requests.receipt.record` | `POST /:agentId/wake-requests/:nonce/receipt` |
| `deliveries.claim` | `POST /:agentId/deliveries/claim` |
| `deliveries.receipt.read` | `GET /:agentId/deliveries/:deliveryId` |
| `deliveries.response.record` | `POST /:agentId/deliveries/:deliveryId/response` |
| `prepared-deliveries.enqueue` | `POST /:agentId/prepared-deliveries` |
| `prepared-deliveries.reconcile` | `POST /:agentId/prepared-deliveries/reconcile` |

普通已鉴权且启用的连接可以发现、读取和向正确目标投递，不需要人格/计划/功能白名单。只有原签名来源设备能发布自己的加载会话、claim 和回传 response；这是执行来源和对象归属，不是第二层功能许可。Prepared 投递沿用原账本签名和 reservation 回读，不相信正文自报的来源/目标授权。

## 数据和恢复

原 PC 的 `RabiLinkOwnerStore` 按连接 scope 保存 `device-agent-owner`。每个设备最多 1024 个 delivery，满额拒绝，不驱逐回执；同 delivery ID 仅在原指纹相同的情况下重放。消息源、完整会话 ID、可见名称、owner epoch、prepared generation、源/目标 endpoint 和 hash 沿用原生语义。

会话租约 45000 毫秒，能力去重后保留前 16 个；单能力最多 80、名称最多 160 个 UTF-16 单元。消息最多 131072、渲染后提示词 262144、设备响应 32768 个 UTF-16 单元；context/control 各最多 64 块。资源限制由原 owner 的共享数据定义供校验合同使用。JSON 入口保持原有无应用层字节上限，接受空正文的写操作沿用 `{}` 默认值。

`waitMs` 使用 `Number` 转换和 0–12000 毫秒边界，无效数值按 0 处理，避免回执等待无限循环。等待由原 scope 变更事件驱动。请求取消释放原 timer/listener，注册退役等待实际清理。准备阶段在正文解析前固定原连接、delivery authority 和 owner；等待归属、peer ledger 或回执后重新核对。写入开始后发生身份切换，返回不确定结果并保留原 journal，不转写新 owner。

投递返回 202 只表示仍排队，唤醒提交不等于设备 claim。结果不确定时用原 delivery ID 回读；prepared 投递使用原 generation 和 endpoint reconcile。只有真实设备 claim 才能产生 owner 接受回执；实际回答和外部发送继续分别验收。

单条邮箱记录损坏时，按原 agent ID 隔离并保留原值；同一连接下其他设备的目录、回执和投递仍可用。目录的 `recordIssues` 返回损坏的 agent ID 和错误码；访问或重新投递该 ID 返回 `409 DEVICE_AGENT_RECORD_INVALID`，不会把缺失回执当作未执行。健康设备写入仍保留这些原始记录。未知根结构或存储版本只阻止该连接 scope 的读取与写入，不重置数据，也不影响其他 scope。

## 验证边界

本轮源码验证使用受控设备 driver、独立临时 PC journal、隔离 HTTP Manager 和临时 Relay/P2P 进程。测试包括同会话投递/正式回复、设备缺席、重启、伪造来源、跨 Manager 原账本证明、旧 owner 与撤销、解析前鉴权、等待取消及退役。没有连接真实眼镜/手机或发送真实任务，不能据此提升设备宿主成熟度。安装版和真实双机证据属于[整体目标架构](./api-contract-discovery-target-architecture.md)的独立验收。
