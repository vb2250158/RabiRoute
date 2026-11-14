简体中文 | [English](./README_en.md)

# DSH（DeepSeek Harness）

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。

省略 `dshBaseUrl` 时复用现有本机 DSH 发现（显式 `DSH_WEB_URL` 与原启动日志地址），不再回退到固定端口。没有已发现地址时明确未配置，拒绝 RPC；本包不为发现而启动、重启或更改 DSH。显式填写的 URL 保留。
## DSH 原生会话与插件功能

本包在 `/api/agent/providers/dsh` 下发布 DSH 原生会话目录、会话元信息与 `sessions/:sessionId/history`。历史直接调用当前 DSH `session/events`，保留 `records` 内的原事件、消息、工具 ID、`seq`、`cursor` 和 `hasMore`；查询可传 `beforeSeq/throughSeq/maxMessages`。读取子 Agent 历史时传原 `parentSessionId` 与 `mode`，仍由 DSH 校验真实父子地址。历史来源与 Rabi 投递往来记录分别发现。

`plugins` 和 `bundles` 查询 DSH 的运行插件与已安装包，`plugin-market` 列市场源，`POST plugin-market/search` 传原 `url/query`。`POST plugins/install` 传 `spec/options`，`POST plugins/:name/update` 传 `version/options`，`DELETE plugins/:name` 移除原包；有作用域的包名按单段 URL 编码。所有操作经既有 DSH 连接认证和 RPC 调用原 `pluginManager` / `pluginMarket`，原生安装结果、依赖、配置和激活仍由 DSH 持有。`options.requestId` 保留原生进度与取消身份，不能据此推断原生安装支持幂等重放；结果未知时核对原包与原请求，不自动重装。
