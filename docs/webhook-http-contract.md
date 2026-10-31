[English](webhook-http-contract_en.md) | 简体中文

# 独立 Webhook HTTP 入口

状态：五项公开操作已使用正式独立监听合同绑定，受控 HTTP、目录、通用调用和退役回归已验证。安装版、完整 Gateway 跨进程部署及真实消息投递分别验收。

通用 Webhook 和 RabiLink 各有一个精确 GET 就绪查询及一个精确 POST 消息接入；RabiLink 另有 GET 回复查询。它们由原消息端拥有，使用既有独立监听，不会自动在 Manager 地址下新增同名路径。

|消息端|路径默认值|监听地址配置|
|---|---|---|
|Webhook|`/webhook`|`127.0.0.1`；`WEBHOOK_PORT`|
|RabiLink|`/rabilink`、`/rabilink/replies`|`RABILINK_WEBHOOK_HOST` 默认 `0.0.0.0`；`RABILINK_WEBHOOK_PORT`|

端口沿用既有回退配置；上表不是运行地址。配置为端口零时应从实际监听地址发现绑定端口。GET 就绪响应的既有 `port` 字段仍表示配置值。

这些是 Rabi 定义的公开 HTTP 操作。原监听未设置额外的 token 或签名校验；迁移不增加逐功能许可，也不改变已鉴权远端连接对 Manager 公共接口的访问。飞书事件回调与 NapCat 反向 WebSocket 继续使用其原平台协议，不能向平台传递 Manager 或远端节点凭据。

`webhookHttpOwner.ts` 负责原 HTTP 读入及响应语义，并直接调用既有 `acceptWebhookPayload`、RabiLink 回复查询和接收响应拥有者。消息记录、可信来源标记、Route 判断与转发规则仍由原业务函数执行。

`webhookNativeOperations.ts` 为两个 profile 逐项生成精确公开合同；原监听成功绑定后，向 `gatewayListenerRuntime` 注册实际端口、原鉴权和可执行 owner，并委托同一 binding 分发。生产发布沿 Gateway 原身份与监督通道进行，测试显式注入相同正式注册服务。公共目录总数为五；每个监听另有一个内部纯拒绝合同，只保留未知路径或方法的原生空 404，不派发业务、不增加能力，也不把未登记业务藏入 wildcard。原 bool hook 与 GET/POST 业务分支已移除。

兼容行为包括：任意 Content-Type、空正文按 `{}` 解析、坏 UTF-8 字节按原方式替换、1 MiB 限额且超限断连接、解析及业务拒绝返回既有 500 文本、GET 忽略未知查询与正文。路径只去除首尾空白并补前置斜杠，保留尾斜杠；因此尾斜杠配置下的回复路径也保留双斜杠。正式 native HTTP 绑定保留这些行为，没有换用通用 JSON 解码器。HEAD、OPTIONS、PATCH 等非原生方法保留空 404。

通用调用器从当前发现快照选择实际绑定，沿已建立的 Manager 连接调用原监听，原生请求不携带节点 Bearer、Cookie 或 Agent 身份。失效监听 lease 在业务执行前返回 409；旧调用未提供 lease 时保持原鉴权。细节见[独立监听合同](external-listener-contracts.md)。

监听退役拒绝新工作，关闭原 HTTP server 和连接，并等待已接收回调的实际 Promise 结束后释放原 Relay lease。重复调用退役返回同一个清理任务；断线不等于业务已完成。

专属回归使用临时数据、端口零及受控消息接收驱动；原消息记录验证明确关闭转发且清空夹具 Route。未调用真实 QQ、飞书、Agent 或外部服务。整体架构见[接口合同与自动发现](api-contract-discovery-target-architecture.md)。

FenneNote 已退役，其原监听与两个操作不再作为当前配置入口；历史记录仍保留原来源标识。
