---
name: rabiroute-message-delivery
description: 通过 RabiRoute 正式工具发现 Agent 会话、核对绑定、投递消息和排查投递失败。用于用户说“rabi 没法投递消息到 workbuddy”“消息发不过去”“投递没反应”“发给另一个 Agent”“会话找不到”，以及 Rabi 向 WorkBuddy、CodeBuddy、DSH、Codex 或其他 Agent 发送、回复消息，或向 QQ、飞书、语音等消息端发送内容。只检查时不发送测试消息；新增宿主适配器不属于本技能。
---

# Rabi 消息投递与排障

## 先选正式入口

通用接口由 Manager 持有：Agent 会话操作使用 `/api/agent/threads`，消息端发送使用 `/api/agent/send`，健康与业务状态使用当前 Manager  GET。先读取 [接口合同](../../docs/rabi-agent-interfaces.md)。宿主提供正式工具时优先使用，工具名和参数映射由宿主适配技能说明；不要求所有 Agent 都安装 DSH 插件。

普通子 Agent 工具不能代替的跨宿主会话投递。缺少工具时使用该宿主已支持的正式 Manager 传输；没有合法入口则报告具体缺失，不猜测工具名、不绕过权限、不换宿主或另建任务。

## 排障顺序

1. 先区分用户要“检查为什么失败”还是“发送这段消息”。排障授权不等于发送测试消息、修改绑定、创建会话或重启宿主的授权。
2. 本机调用通过当前 Host 动态发现 Manager，并使用入口的 `GET /meta` 核对；已接入远端使用 Hook 提供的稳定客户端与相对操作，由客户端完成地址发现、身份核对和重连，不要求 Agent 维护端口、运行本机 Host 解析器或重新配对。不得抄用技能、旧对话或日志里的历史端口；不得用近期记忆读取充当健康探针。
3. 先读当前工具说明与 Manager 接口合同；调用 `/api/agent/help` 后检查 `contractLevel` 与 `coverage.missing`，发送还要读取 `/api/agent/send/capabilities`。`baseline` 不是精确 schema，缺失字段必须读取专用 contractResource；再通过 `/api/agent/threads` 的只读操作查询目标宿主、会话、绑定和可投递状态。工具参数以当前合同为准，不编造操作名或 JSON 字段。
4. 使用完整目标会话 ID 定位；标题、工作目录和时间只能辅助核对。明确区分“直接投递给指定 Agent 会话”和“外部消息按 Route 绑定转发”，不能仅凭 Route 未绑定就断定所有投递方式都失败。
5. 根据正式返回区分：Manager 不可达、适配器不支持、目标不存在、绑定缺失、会话不可投递、鉴权失败、投递被拒、结果未知。只读查询成功不能证明消息已经送达。
6. 正式返回仍不能解释问题时，才定位对应实现、配置或日志。先确认实际运行版本和源码位置，只检查与错误相关的路径；本地文件不代替 Manager 权威状态，不直接修改业务 JSON。
7. WorkBuddy 的 Hook 正常不代表消息通道正常；会话存在也不代表可投递。以 Manager 当前返回的存活、心跳、端点与会话类型等状态为证据，不凭旧截图推断。

帮助响应中的 `catalogDigest` 与 `channelsDigest` 只用于比较完整目录或渠道描述是否变化；筛选响应的 `catalogDigest` 仍属于完整目录。摘要相同不代表权限、Agent 启停、对象状态或 Manager 身份不变，也不能把 baseline 升格为 verified。切代或合同错误后仍重新发现并核验 `/meta`，不凭摘要省略回执读回。

## 目标返回 404 时继续发现

精确 ID 返回资源不存在时，先在原宿主和 Agent 端按保存的名称查询；无明确匹配时列出最近更新、当前活动的会话，并按当前接口分页。读取候选完整 ID、工作区、业务目标和最近上下文，与原计划及 taskBinding 核对后，继续已授权的原任务。名称相同或更新时间最新本身不足以确认身份；ID 不同须记录与原任务的关系，仍有歧义再问用户。

通用 route not found 先核对 help 与接口，超时、权限拒绝和索引未就绪不能当成目标不存在。只读发现不创建任务、不修改绑定或发送消息。已有投递结果不明时保留原 deliveryId、来源和目标，只核对原回执或实际接收证据，不向候选会话重发。

返回提示应列出当前可用的名称搜索、近期列表或归档查询等下一步。若发现原对象确实存在却仍无法读取，继续调查并修复原接口或存储问题，不能用候选列表掩盖该故障。

## 正式投递与回复

已安装客户端的显式 Agent send 进入原 owner 持久队列，本地受理不是送达。断线、命令退出和客户端重启后由程序恢复原 ID；Agent 查看原编号，不另建重复投递。CLI 的 `--delivery-query` / `--delivery-list` 与 WebGUI“投递记录”用于核对。同一 ID 下由原 owner 按既有幂等合同恢复属于原投递继续执行；其它 HTTP 写入按各接口的执行阶段、回执和恢复合同处理，不凭超时创建新 ID 或重复副作用。细节见[可靠投递](../../docs/reliable-agent-delivery.md)。

- 发送前确认目标及正文属于用户请求；目标有歧义时等待用户明确，不猜选、不新建替代会话。
- Agent 间投递填写完整来源会话 ID、来源 Agent 类型及 `responsePolicy`；要求回复时填写 `responseInstruction`。来源不能取目标 ID 或由标题猜测。
- 插件向 Manager 只传 `messageSource`，来源会话必须与 `sourceThreadId` 一致；遵守当前接口对来源字段的定义。
- 正式回复填写 `inReplyToRequestId`、`result` 和 `nextAction`，关联原请求；最终聊天文字不算正式回复已投递。
- 存储写入前读取现行接口合同，使用稳定 `Idempotency-Key` 和适用的强 ETag `If-Match`；校验 HTTP 状态、回显键、ETag、资源身份及 `uncertain`。
- 超时、503、写后切代或结果不确定：保留原键和正文，由原 owner 查询原 ID、执行阶段和接收证据；按该接口已有幂等/恢复合同继续原投递。明确未开始时修正原因后继续，已接收则跟踪完成，未知时继续恢复查询并报告具体缺口；其它独立工作照常推进。412：重新读取并确认原意，再用新键与新 ETag。
- 分开报告“Manager 已接受”“目标已收到”“目标已完成回复”。消息端发送必须取得 Manager 与渠道回执；没有对应证据不宣称该阶段成功。

## 触发示例与范围

- “就是 rabi 没法投递消息到 workbuddy 的问题” → 本技能；先健康核对与只读会话检查，不先搜源码、不先发测试消息。
- “让 Rabi 把这段话发给 DSH 的指定会话” → 本技能；核对目标和来源后走正式投递工具。
- “向 QQ 群发送这段话” → 本技能选择消息端入口，并按 QQ 专项技能核对收件目标。
- “给 Rabi 新增一种 Agent 宿主” → Agent 适配器接入技能，不把未实现能力当普通绑定问题。
- “当前 Codex 使用某个角色” → `use-rabi-codex-context`，不属于跨会话消息投递。

## 验收边界

技能被发现、可加载、描述覆盖请求，只能证明入口已就位；不能证明模型每次都会命中，也不能证明真实投递已修复。真实投递验收需要明确的目标、获授权的正文及正式回执。技能检查不启动该验收。

## 发送前聊天索引核对

所有聊天类型消息端使用 `/api/agent/send` 的 `conversationContext`。上下文已给出 `lastReadMessageIndex` 时原样传递；缺省时 Manager 只复用同一 `sender.agentType + sender.sessionId + 会话` 的已核对缓存，首次返回最近 50 条并要求再次调用。收到 `conversation_context_confirmation_required` 表示尚未发送：阅读新增消息，重新判断正文是否合适；超过增量上限时按返回的会话、`afterSequence/beforeSequence` 范围和关键词补查省略内容。确认后保留原 deliveryId，提交返回的 `confirmationToken` 与 `latestMessageIndex`（作为 `lastReadMessageIndex`）；正文改变时重新审核，不能自动确认未读内容。再次有新消息时重复核对；不得换 deliveryId 绕过。不同 Agent 的已读位置和凭证互不共享，旧回执按原请求交原 owner 核对和恢复，不换 ID 重复发送；此核对由 Agent 完成，不转成用户的二次授权。
