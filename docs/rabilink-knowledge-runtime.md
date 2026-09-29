# PC 知识 HTTP 请求桥（实验实现）

[English](rabilink-knowledge-runtime_en.md) | 简体中文

PC runtime 将专用设备知识请求送入现有知识 MCP 的 Streamable HTTP，不代理模型推理、不复制 Manager 业务实现。尚未安装或完成真机验收。

本机全局配置 `rabiLinkRelay.knowledgeBridge` 默认关闭。显式配置 `enabled`、`url`、`token`、`allowedRoles`、`allowedTools`、`allowWrites` 和 `grants`。URL 仅允许 `http://127.0.0.1:<port>/mcp`；token 必须为至少 32 字符的私有随机凭据，不放 URL。每个 grant 包含 `appId`、`deviceBindingId`、`ownerAccountId`，必须与 Relay 验证的设备归属一致。设备目标还必须与当前 PC 标识匹配。知识桥只接受已规范化的 PC deviceId（首尾为字母或数字、内部仅字母数字下划线连字符、无重复连字符）；不符合时不广告能力，旧 worker ID 不匹配时失败关闭，请规范 PC 名称并重新选择目标，不猜测 GUID。配置仍使用现有本机文件存储，不宣称静态加密。公开配置仅返回 `tokenConfigured`，不会返回知识密钥；更新时省略 token 保留旧值。

## 运维配置步骤

现有 WebGUI 的 RabiLink 设置提供折叠的“本机知识 MCP 安全设置”：读取配置后编辑，密钥留空保留，保存后回读非敏感字段，不一致时停止重发；保存成功与真实握手就绪分别显示。仅使用既有受控管理入口，不扩宽眼镜通用转发权限。现行配置接口没有版本 CAS，因此不宣称并发修改安全。

需要使用管理 API 时，先通过本机 Host 动态发现 Manager 地址并以 `/meta` 核对代际，再在受控本机管理通道读取 `GET /api/rabi/identity`。使用同一通道 `PATCH /api/rabi/identity` 提交 `{rabiLinkRelay:{knowledgeBridge:{enabled:true,url,token,allowedRoles,allowedTools,allowWrites,grants}}}`，值来自本机实际 MCP 服务与已确认设备归属，不能复制占位值直接上线。不要把 GET 的 `tokenConfigured` 回写；后续局部更新省略 token 保留原值，空串和掩码会被拒绝。

设置保存会同步 runtime，但必须再看到 Relay 在线 PC 的 `knowledgebridge` 能力及实际工具目录才能认为连接可用。手机 profile 的 MCP 引用不能代替这里的服务连接或双侧授权。关闭使用 `{rabiLinkRelay:{knowledgeBridge:{enabled:false}}}`。不应为远程配置密钥而扩宽通用手机 WebGUI API 白名单。

专用队列路径为 `/__rabilink/knowledge`。顶层 `knowledge` 携带已认证的归属和 Relay grant，正文仅包含 list/call 请求。普通转发无法用正文伪造该标记；Relay 必须拒绝通用入口使用保留路径。PC 再取本机与 Relay 的角色、工具和写入授权交集。列表提供裁剪后的 roleId enum、allowedRoles 和 allowWrites，实际调用再次校验共享 schema。

涉及写入或近期详情 touch 的请求必须标记 `nonReplayable` 并保留稳定业务幂等键；传输失败返回 `uncertain`，不自动重发。队列自身的去重和不重放由 Relay 保证，不能把 PC 的一次 HTTP 尝试误认为完整恰好一次语义。

只有实际 SDK 初始化和工具列表预检成功后才广告 `knowledgebridge` 能力；调用传输失败撤销广告。服务恢复后通过现有配置同步或连接重启重新预检，不新增高频轮询。

根应用使用固定版本官方 MCP SDK，纯 schema 位于 `packages/rabi-knowledge-contract`。独立 `apps/rabi-mcp` 客户端保留供独立应用测试/宿主使用；两端只共享 schema，不重复计划和记忆业务。
