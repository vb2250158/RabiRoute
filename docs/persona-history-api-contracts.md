[English](persona-history-api-contracts_en.md) | 简体中文

# 人格聊天与语音记录的可执行合同

本组将原聊天记录、AIUI 交换记录、语音转写、消息片段查询和情景快照接入统一可执行分发。原 JSONL、字节游标、声纹分类、索引读取进程和情景存储继续作为真源；不生成真实 Agent prompt。

| 操作 ID 后缀 | 方法 | 人格下路径 | 路径前缀 |
| --- | --- | --- | --- |
| `chat.read` | GET | `/:roleId/chat-history` | `/api/roles` 与 `/roles` |
| `chat.aiui.append` | POST | `/:roleId/chat-history/aiui` | `/api/roles` 与 `/roles` |
| `voice.read` | GET | `/:roleId/voice-transcripts` | `/api/roles` 与 `/roles` |
| `situations.list` | GET | `/:roleId/conversation-situations` | `/api/roles` 与 `/roles` |
| `situations.detail` | GET | `/:roleId/conversation-situations/:situationId` | `/api/roles` 与 `/roles` |
| `messages.search` | GET | `/:roleId/message-endpoint-history` | `/api/roles` |

共 11 个具体路由。完整 ID 使用 `manager.personas.history.` 前缀；`/roles` 对应 ID 增加 `.alias` 后缀。原 `knowledge`、`knowledge-alias` 与 `persona` 派生发现 ID 作为合同别名保留。所有已鉴权远端默认可以调用公开接口，不增加功能许可。

## 原记录语义

聊天记录按原字节偏移分页，每页 1–100 条，保留原游标与 Unicode 正文。`summary=true` 返回摘要；`direction=newer` 配合游标找回较新记录，`id` 用于按需读取单条详情。响应通过 `invalidRecords` 报告坏记录，通过续游标表示尚有待扫描内容，空页不等于记录结束。Desktop 元数据只按原完整会话 ID 补充当前名称和链接；元数据不可用时仍返回已保存记录。AIUI 记录不查询 Desktop、不投递消息；原 session/turn 身份保证重放去重，原文冲突会拒绝。

AIUI POST 保留 128 KiB 正文上限、四个原字段、session/turn 的 128 字符规则和每段文本 16000 字符限制。native append 增加可选写前复核回调，在原写队列等待及打开文件后、实际追加前复核原连接、目录和 Manager 身份；不改变原 hash、receipt、冲突检查或其他聊天写入。

语音转写继续交给有界读取 worker，保留 user/other/unknown/conflict 分类、日期过滤、归档和摘要模式。单项情景读取仍在调用者选择的近期窗口中查找，不能把它改为无视 `limit` 的全量直接查找。

消息查询保留最多 200 条、200000 字符、Unix 秒时间和非负 sequence 边界，以及全部原筛选项。结果明确标为最近匹配片段，完整性未知，不支持 cursor/offset；索引版本也不能代替全量来源证明。默认 HTTP 预算 2500 ms，可通过 WebGUI 的 `history.request` 设置调整；显式 `budgetMs` 接受 1–2147483647 的整数并优先于默认值。原请求截止时间不因逐跳传输而重置，独立排队和执行预算仍生效。派生索引的部分覆盖和单条 8 MiB 工作预算见[消息记录搜索](message-history-search.md)，它不限制原消息写入。成功和查询失败保留原 requestId；响应追踪沿用原 telemetry。

超时或断开时取消原查询，不等待永不返回的读取服务才答复。原 worker pool 继续拥有取消、进程退出确认和隔离 slot；HTTP 预算结束不代表已确认子进程退出。等待后和披露前复核原连接、当前目录与 Manager 身份，撤销、换根或切代不能泄露旧结果。

## 验证与边界

隔离验证覆盖全部 11 个路由及已鉴权空节点正向调用、原聊天分页与元数据降级、AIUI 重放和冲突、原生队列写前目录复核、语音撤权四种变化、真实索引 worker 的筛选/归档/预算/排队/取消/退出，以及独立健康请求。测试没有读取真实人格记录或运行真实 Agent；不代表安装版或物理设备验收。

其余人格接口继续保留原 prefix 分发，直到各自 owner 迁移并验证完成。
