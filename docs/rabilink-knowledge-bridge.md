# RabiLink PC 知识桥（实验接线）

[English](rabilink-knowledge-bridge_en.md) | 简体中文

`src/manager/rabiLinkKnowledgeBridge.ts` 是默认关闭的策略层；`apps/rabi-mcp/lib/knowledge-http-client.mjs` 使用官方 SDK 连接已有知识 MCP HTTP 服务。它们不实现 Manager 业务、不创建推理运行时、不执行 shell。

根 runtime 已通过 `rabiLinkKnowledgeRuntime.ts` 接入官方 SDK 1.30.1，专用队列在普通本机代理前分流。远端 rabi-agent 依赖未变；独立应用 adapter 仍供独立宿主使用。当前已验证真实 HTTP 与假队列，不代表已安装或真机验收。完整配置、密钥脱敏、设备授权和能力广告见[运行合同](rabilink-knowledge-runtime.md)。不能从设备请求接受模块路径、目标 URL 或 Token。

本机配置包括 enabled、url、token、allowedRoles、allowedTools、allowWrites。URL 必须精确为 `http://127.0.0.1:<port>/mcp`，无查询、用户信息或其他路径。默认禁写；近期记忆详情会更新阅读时间，也需要写权限与稳定业务幂等键。工具参数校验复用唯一 `packages/rabi-knowledge-contract` schema，knowledge-tools 同样导入该模块，不重写工具或 Manager 路径。

调用者必须自行认证并注入 appId、deviceBindingId、ownerAccountId、targetDeviceId。模块只验证这些字段存在，不证明身份或绑定关系。Relay 必须显式指定所属应用选择的 PC；通用 WebGUI 队列不得伪造保留路径或设备元数据。有效工具权限仍受设备授权、PC 本机白名单、MCP 服务端白名单共同限制。

传输失败不自动重试。写操作返回 `uncertain`，队列 owner 必须持久化原业务键与正文并权威核对；不能用新键重放。只读错误也不泄露底层异常或凭据。已有测试覆盖拒绝不调用、稳定键、单次失败与官方 SDK 真实 HTTP 初始化/目录/调用。
