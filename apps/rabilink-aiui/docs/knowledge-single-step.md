# 知识工具单步执行（实验模块）

[English](knowledge-single-step_en.md) | 简体中文

`utils/knowledge-tool-runtime.js` 不修改页面，也不负责网络认证。调用方注入 `list`、`call` 和原子 `storage.load/save`；传输使用现有设备凭据访问固定 `/api/rabilink/device/knowledge`，解包 `{code:0,data}` 后才交给模块。目录必须包含 `tools` 和服务端 `allowedRoles`。用户显式选择的角色必须同时在调用方可信授权与目录授权中，不能从 profile ID 推断。

模块只广告六个只读知识工具，`memory_get` 仅允许 `consolidated`；不广告写工具。工具参数仍须由 PC 权威 schema 复核。完成事件需要 `isComplete:true` 和稳定 `callId`；先持久记录意图再发起请求，同 ID 异参数拒绝，不自动重试。调用方必须按设备归属及有限会话作用域隔离 ledger，最多 128 条，满后失败关闭。

同时最多一个调用。超时不是撤销：后台请求未结束前仍占用并发位。`cancelPresentation()` 只屏蔽结果呈现，不声称 PC 动作撤回。`dispose()` 后不能再调用。

返回结果必须为官方 MCP `CallToolResult`；仅 `structuredContent.ok=true` 且非 uncertain/isError 才显示查询成功。播报只提供固定短摘要与条数，不直接朗读任意工具文本；原始结果只能以不可信纯文本显示。结果独立于模型回答，不把它拼成 prompt 假装工具续轮。官方 0.18 文档未证明工具结果回传 API。

本机纯 JS 测试验证角色拒绝、写入拒绝、去重、存储失败、并发、取消与超时。主页面已通过独立页面方法实际接线，见[页面合同](knowledge-tool-page.md)；尚未真机验收，这些测试也不证明已部署的 PC 桥正在运行。
