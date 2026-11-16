[English](agent-call-history_en.md) | 简体中文

# Agent 调用记录

用户入口为日志诊断的“调用记录”标签卡，“运行日志”标签显示当前路由最近 30 行输出。操作步骤见 [运行、日志与排障](user-guide/operations-and-troubleshooting.md#查看-agent-调用记录)。

## 采集与关联

Manager HTTP 入口在原请求读写链上记录阶段，复用请求 ID，按注册操作找到 operationId。Rabi CLI 与 MCP 使用共享客户端记录传输阶段和最终工具返回，发送 x-rabiroute-call-id、x-rabiroute-call-source、x-rabiroute-tool-name 关联头。Agent 类型和会话沿用已有元数据。来源字段为调用方报告的信息。

每条调用用 callId 关联，阶段主键为 callId、spanId、boundary。boundary 为 server、client 或 tool。客户端重复回执保持首次持久内容，内容冲突累计计数。服务端阶段支持从运行中更新至结束。业务返回值、执行次数、取消信号及原执行归属保持原合同。

## API

| operationId | HTTP | 用途 |
| --- | --- | --- |
| manager.calls.list | GET /api/diagnostics/calls | 索引分页与记录配置 |
| manager.calls.read | GET /api/diagnostics/calls/:callId | 阶段目录，指定 spanId 和 boundary 后读取单个正文 |
| manager.calls.client.observe | POST /api/diagnostics/calls/client | 客户端持久回执 |
| manager.calls.config.save | PUT /api/diagnostics/calls/config | 采集开关、正文开关与大小 |
| manager.calls.events | GET /api/diagnostics/calls/events | 合并后的变化通知和心跳 |

列表筛选包含 source、status、sessionId、query、from、to。query 匹配接口、工具、路径和调用 ID。limit 默认 50，最大 200。游标绑定筛选条件和首次查询水位。列表仅查索引，阶段正文按需读取。

配置为 enabled、captureBodies、maxBodyBytes，默认 true、true、4194304，大小范围 1024 到 16777216 字节。历史记录保留，当前版本没有自动归档或删除。按日期的 gzip 目录只承担物理分卷。

## 故障与完整性

正文写盘前统一脱敏。无法可靠脱敏的截断 JSON 省略，二进制保存元数据。列表通过 captureState、truncated 和业务 code 表示捕获范围与业务结果。存储队列有界，丢弃和冲突计数持久化。客户端未确认记录按已核验的 Manager 目标分区保存在 outbox，同一目标恢复后补传。坏项隔离，服务端确认存储后才移除。

客户端补传每轮最多 16 条，整体默认预算 1500ms。补传不重放原业务。服务端调用记录接口、自身事件流和元信息预检不进入采集。历史机制从启用后的请求开始，普通 Shell 和其他 MCP 的覆盖依赖宿主接入。

## 验证入口

运行 src/manager/agentCallHistory.test.ts、apps/rabi-agent/test/call-observation.test.mjs、apps/rabi-agent/test/manager-cli.test.mjs 和 apps/rabi-mcp/test/knowledge-mcp-server.test.mjs。隔离构建验收位于 scripts/api-contract-built-manager.test.mjs 的调用记录用例，使用独立进程、端口和状态目录。
