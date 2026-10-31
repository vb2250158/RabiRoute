[English](reliable-agent-delivery_en.md) | 简体中文

# 可靠 Agent 投递与记录

状态：源码已接入，隔离故障测试与安装运行验收分别记录；本文不表示已部署到已连接电脑。

业务 Hook 或插件决定何时发送、消息内容、目标与是否要求回复。Rabi 对明确提交的投递负责：先在原客户端持久受理，再后台传输、恢复与保存接收证据。`responsePolicy=none` 不降低这次投递的可靠性。

## 查看投递记录

在 WebGUI 侧栏打开“投递记录”（`/deliveries`）。默认查看当前主机，也可选择已连接的原电脑。列表支持状态、编号搜索与分页；详情显示目标、尝试次数、错误及已有接收回执。

“待发送”表示已保存，“待确认”表示可能已发送但接收证据不完整，“已送达”表示目标 owner 已接受正文。它们都不表示业务执行完成。旧记录没有保存的时间或次数显示“未记录”，不反推补造。

电脑断线时主机不能实时查看那台电脑的本地队列，页面会说明无法读取，不能据此判断队列为空。客户端重新上线后，再读取其原队列。界面只读，不会因打开详情而重发消息。

## 原客户端拥有发送责任

稳定启动器仍是唯一主程序，短命 CLI 经现有鉴权控制通道把发送意图交给原 worker。worker 在配置目录旁的 `delivery-<config-hash>.sqlite` 事务提交后才确认本地受理，使用 SQLite FULL 同步；CLI 退出不删除记录。

原 worker 启动后加载未完成记录，断线重连和退避到期自动继续。电脑重启后，既有受管自启动必须恢复原客户端；电脑关闭或客户端未运行期间不能执行发送。队列放在版本目录之外，升级不能删除或重置它。更新候选提交前不接管队列，原 owner 交接期间暂停发送。

每次尝试复用当前配置与现有 `EndpointSession`，按稳定 Manager 身份发现新地址并核对运行身份。受理时保存原 Manager GUID；之后重新配对到另一个 Manager 不会转移旧队列。端口、URL 和 generation 不由上层 Agent 维护；不扫描端口，不自动改绑目标或降低 HTTPS。

## 调用

原 `--api POST /api/agent/threads` 的 `action=send`（包括 `inReplyToRequestId` 正式回复）自动进入可靠发送路径。原请求正文合同不变，调用时仍提供真实 Agent 类型与完整源会话 ID。未提供 deliveryId 时 CLI 生成并返回一个；跨调用方自身崩溃的业务去重应由调用方保存稳定键。

`--operation`、标准输入或文件 JSON，以及公开 SDK 的 `request` / `invokeOperation` 在解析到同一发送合同后使用同一入口。已验证的发送操作目录按原 Manager GUID 持久缓存，重启 CLI 后即使主机离线也能解析原操作；从未验证过的操作编号在目录不可用时明确拒绝受理，不猜测映射。旧 HTTP 风格调用仍返回 `statusCode` / `body`，本地受理为202和排队状态。

也可使用 `--delivery-submit --body-stdin --agent-type TYPE --id FULL_SESSION_ID`，标准输入为 `{ "intentId": "stable-operation-id", "request": { ...原 send 请求... } }`。intentId 可省略；显式给定时必须与 request.deliveryId 一致。提交回执中的 `acceptance=local-durable` 只证明本地受理。

通过同一已安装启动器调用 `--delivery-query ID` 或 `--delivery-list [--cursor CURSOR] [--limit N] [--state STATE] [--query TEXT]` 查看本地记录。模块使用 `createReliableDeliveryClient({configPath,agentType,sessionId})` 的 `submit/get/list`，实现位于 `apps/rabi-agent/lib/delivery-control.mjs`。

本地提交 ACK 未知时返回原 intentId 及 `accepted=null`；继续查这个编号，不另生成一条消息。磁盘满或事务失败没有持久受理保证。当前拒绝未经冻结的本地 `imagePaths`，不会悄悄遗漏附件；通用附件冻结仍需按附件合同扩展。

其它 HTTP 操作、平台消息发送及流式请求保留各自合同；本机制没有为任意 POST/PATCH 增加自动重试。

## 配置

在原客户端配置的 `deliveryPolicy` 中配置：

```json
{
  "deliveryPolicy": {
    "maxPending": 10000,
    "maxBytes": 67108864,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000,
    "pollMs": 1000,
    "maxConcurrency": 4,
    "maxPerTarget": 1,
    "ordering": "target",
    "requestTimeoutMs": 8000
  }
}
```

这些参数调节本地容量、指数退避及队列调度。默认最多并行处理四个不同目标，每个目标按受理顺序处理；慢目标不会占住所有目标。`ordering=none` 可配合 `maxPerTarget` 放宽同一目标的并发，`maxConcurrency` 上限为64。容量不足在受理前拒绝，不驱逐已受理消息；取消和已送达记录不占待发送容量，pending 默认没有自动过期。调度读取队列，不扫描宿主任务或端口。真实禁用、正文冲突、身份改变等保留可见原因，不能通过重配对绕过。

## 同一编号与接收证据

相同 intentId 和内容返回原记录，改变正文或目标报冲突。Manager 根据可信源身份派生正式 deliveryId，保存不可变正文、目标及执行快照。发送前验证失败保留 `prepared`；后台恢复按原快照继续。

已经进入 `dispatching` 的记录只核对原证据。仅传输 owner 提供明确“本次没有发送正文帧”的证明，才可回到 prepared。证明必须先持久化，绑定原目标、正文及执行选项 hash、Manager 本次尝试和远端传输尝试；旧证明不能恢复新的尝试。即使远端证明回传丢失，重连后也查询原持久证明。超时、断线、查不到回执都不能自行改判未发送。`committed` 返回原接收回执，取消不撤回已经收到的正文。

LAN taskResult 在客户端先持久保存，以 eventId 重传；Manager 将原节点、任务和完整结果 hash 持久保存后才发 resultAck。丢 ACK、重连及 Manager 重启不重复应用同一结果。任务完成显示不再清除尚未送达的结果责任。所有未完成任务保留；已完成详情可压缩，最小结果与幂等证明保留。

真实 Desktop 目前可通过精确 deliveryId + promptHash 的 owner 记录恢复正向接收证据，但尚无已证的持久原生幂等接受合同。Desktop 已接受而适配器尚未保存回执的全部崩溃窗口不能宣称已闭合；无证据时继续显示待确认，禁止盲目重复执行。不能把这项限制隐藏成“已送达”。

## 只读接口

| 接口 | 结果 |
|---|---|
| `GET /api/agent/deliveries?limit&cursor&state&query` | 当前 Manager 正式记录的脱敏投影 |
| `GET /api/agent/deliveries/:deliveryId` | 原正式记录与接收证据 |
| 上述列表/详情增加 `nodeId` | 从指定原客户端读取其持久队列；离线返回不可观测错误 |
| `GET /api/agent/deliveries/caller/:callerDeliveryId` | 当前可信来源的原意图是否已被 Manager 预留及其回执 |

仅精确 `DELIVERY_NOT_RESERVED` 且 `canSubmitSameIntent=true` 证明当前源键没有预留，允许原键提交。查询沿用与发送相同的来源会话校验，不能以过时的连接默认会话替代显式源会话。损坏记录保留原文和占用编号；其余完整记录仍可处理。整个账本不可读或无法确定原编号时返回证据不可用、停止覆盖原文件，不授权重放，也不显示正常空列表。已登录连接沿用现有公开接口合同，不新增逐功能许可。

## 升级、回滚与验收

优先采用[原生源码热补丁](source-hot-patches.md)，按正在运行的 owner、导入、状态与生命周期逐项判定兼容性。形状检查通过不代表新增接口已注册；需要新增状态或迁移入口时，先验证对应迁移合同。不能通过清空审查标记、改运行私有字段或替换基线来强行发布。没有可用迁移入口时保留原服务，交由唯一发布 owner 安排受控切换。

队列 schema 不支持时拒绝接管并保留文件。回滚到尚不认识 resultReceipts 的旧 Manager 会丢失新扩展字段，不能在未完成原记录核对和完整恢复快照保留时让旧版本覆盖新账本。

源码与隔离验收覆盖持久写入失败、CLI 退出、原 owner 重启、离线目标、动态地址变化、原键冲突、掉 ACK、prepared 继续、dispatching 不盲目重放、结果跨 Manager 重启去重与 GUI 读取。安装版、原电脑和真实 Desktop 的运行证据单独核对；构建通过或页面夹具不替代双机验收。

Codex、WorkBuddy 和 Antigravity Hook 会显示 completionDeliveries 的失败/待确认及服务实际返回的编号。没有返回的编号和恢复状态显示“未返回”；提示展示本身不重发正文。业务通知条件仍属于业务 Hook。
