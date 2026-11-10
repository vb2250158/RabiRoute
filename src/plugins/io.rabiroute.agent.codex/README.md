简体中文 | [English](./README_en.md)

# Codex（ChatGPT 中的编码 Agent）

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。

## 0.1.3：投递回执读取

回执查询会继续扫描大工具输出、图片记录和完整用户消息，不再因固定的整行大小上限中断。查询仍核对原任务身份和已接受的用户消息；未完整写入的 JSONL 尾行、取消和读取错误仍按原回执合同报告，不会据此重新发送消息。

## 原生会话与聊天历史

本插件发布 `agent.providers.codex.sessions.list`、`.read` 和 `.history.read`，对应 `/api/agent/providers/codex/sessions`、`/:sessionId` 和 `/:sessionId/history`。会话目录保留 `limit/offset/query` 与 `nextOffset`。历史读取原会话登记的 JSONL 或 Zstandard rollout，原消息和工具事件保留在 `entries[].record`，物理记录序号在 `sequence`。这份来源与 Rabi 投递账本分别检索。

历史默认每页 50 条原始记录和 262144 原事件字节，可通过 `limit/maxBytes` 调整。使用返回的 `nextCursor` 续页；`resumeCursor` 可从同一原文件的已读位置继续查看新增事件。普通 JSONL 从已返回的字节位置继续，压缩归档按文件版本复用内存解压结果。坏行仅占原序号并返回 warning，未写完尾行保留续读位置；单条有效事件超过预算时指出所需字节，不截断原文。`coverage` 说明本页扫描、返回、尾行与完整性，不能把一页当作全部历史。
