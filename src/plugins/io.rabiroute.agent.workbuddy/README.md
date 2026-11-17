简体中文 | [English](./README_en.md)

# WorkBuddy（腾讯 AI 办公工作台）

通过公共 `POST /api/agent/threads` 指定 `agentAdapter: "workbuddy"` 与 `agentTargetId: "local:workbuddy"`，可直接列出任务、读取任务详情，并按完整 `threadId` 查询原生聊天记录。查询使用 `action: "read"` 和 `history: { limit: 200 }`，续页原样传回 `history.cursor`。记录按文件顺序返回，保留原始事件，坏行及未写完的尾行在 `coverage` 和 `warnings` 中报告。查询与指定 ID 投递可独立使用，角色绑定用于默认路由。

投递使用 `action: "send"`，携带目标 `threadId`、任务实际 `cwd`、`prompt` 和稳定 `deliveryId`。Windows 在首次扫描或投递时自动发现原 owner 的回环监听地址，并以该进程的临时凭据完成鉴权。探测核对 WorkBuddy 进程、PID 和创建时间，凭据通过私有子进程管道进入内存缓存。系统需允许 Manager 读取目标进程信息，例如目标 WorkBuddy 已提升权限时，Manager 也需具备相应的系统访问权限。此流程保持实验性。旧版可继续使用已配置的本地凭据。新版 CodeBuddy HTTP 请求携带官方要求的 `X-CodeBuddy-Request: 1`。接口依据见[官方 HTTP API](https://cloud.tencent.com/document/product/1831/137064)。

本机截图投递通过同一会话网关的 `payload.attachments` 传入 `{ type: "image", urlType: "local-path", url, name }`。宿主将它呈现为供 Read 工具读取的附件引用，不改任务绑定，也不启动另一个 Runtime。正式投递保存图片哈希并在投递前检查；本地图片路径不跨电脑传输。

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。
