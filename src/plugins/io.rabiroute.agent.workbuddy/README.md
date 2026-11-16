简体中文 | [English](./README_en.md)

# WorkBuddy（腾讯 AI 办公工作台）

本机截图投递通过同一会话网关的 `payload.attachments` 传入 `{ type: "image", urlType: "local-path", url, name }`。宿主将它呈现为供 Read 工具读取的附件引用，不改任务绑定，也不启动另一个 Runtime。正式投递保存图片哈希并在投递前检查；本地图片路径不跨电脑传输。

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。
