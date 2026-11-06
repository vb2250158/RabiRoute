简体中文 | [English](./README_en.md)

# Codex（ChatGPT 中的编码 Agent）

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。

## 0.1.3：投递回执读取

回执查询会继续扫描大工具输出、图片记录和完整用户消息，不再因固定的整行大小上限中断。查询仍核对原任务身份和已接受的用户消息；未完整写入的 JSONL 尾行、取消和读取错误仍按原回执合同报告，不会据此重新发送消息。
