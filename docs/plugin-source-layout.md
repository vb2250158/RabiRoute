# 插件源码、版本与公开配置

[English](plugin-source-layout_en.md)

每个插件只有一个源码目录：`src/plugins/<稳定插件 ID>/`。当前包含 43 个 Rabi 原生插件和 9 个其他宿主的扩展。插件实现、配置定义、界面、翻译、测试、文档和资源归该目录；共享配置、路由、身份和账本沿原拥有者复用，不复制到插件里。

```text
src/plugins/<id>/
  rabi.plugin.json       # Rabi 原生插件的运行入口和能力合同
  package.json           # 构建依赖和插件自己的版本
  src/                   # 本插件业务实现，测试与实现相邻
  web/                   # 界面入口、组件、翻译
  assets/                # 公开数据定义和资源
  storage-migrations.json # 有私有存档升级时声明
  README.md / README_en.md
```

Codex、CodeBuddy、DSH、NapCat 与本地服务保留各自正式 manifest 格式。`plugins/source-catalog.json` 只索引源码及版本文件，不复制版本值。`plugins/contracts/` 保存 SDK 和公开宿主 API；`plugins/profiles/` 保存公开装配定义及精确旧版本迁移声明。发行产物才采用 `dist/plugins/packages/<id>/<version>/`，源码不保留每版副本。已发布版本可从 Git 历史及正式发布归档恢复。

## 版本与构建

宿主在架构、扩展点或启动合同变化时升级。插件功能、配置和资源变化递增自己的版本；新原生插件从 `0.1.1` 开始，后续按各自版本递增。已有公开扩展继续各自版本序列，不覆盖旧版同号内容。能力合同的主版本与包版本分别维护。

```sh
# 仅递增指定插件，同时更新自己的正式 manifest、npm 元数据和精确装配引用
npm run plugin:version -- io.rabiroute.agent.codex 0.1.2

# 仅构建指定包到独立候选，不覆盖完整应用产物
npm run plugin:build -- --package io.rabiroute.agent.codex --output-directory ../codex-plugin-candidate

# 导出可审查的源码仓库候选；不创建或发布 GitHub 仓库
npm run plugin:export -- io.rabiroute.agent.codex ../codex-plugin-source
```

SDK 提供仓库外后端构建入口 `rabi-plugin-build`；共享宿主依赖显式引用 `@rabiroute/host-api/<moduleId>`。构建使用公开签名与类型，不读取另一份宿主业务实现，也不复制业务状态。工作区先执行 `npm run build` 生成配套 SDK/API 类型与插件产物，再分别对 `plugins/contracts/plugin-sdk`、`plugins/contracts/host-api` 执行 `npm pack`，供导出后的开发环境安装。

后端构建在同一次 TypeScript 检查中生成代码与公开 API 声明，随后发布所需类型闭包。开发插件时可只构建指定插件；宿主架构或共享接口变化后再运行完整应用构建。

Web 入口由插件的 `package.json.rabi.webSource` 声明，工作区 Vite 构建与当前 Web 发布共同生成实际入口。仓库外后端构建通过不代表独立 Web 发布或进程型 worker 已验收；这些入口仍按各自资源、进程及宿主合同验证。插件中的公共依赖保持显式，不通过复制宿主账本补齐。

## 哪些内容可以公开

- 提交源码、测试、文档、图标、配置 schema、公开默认值及使用占位值的示例。
- `route-config.json` 定义字段和默认值；实际账号、token、连接及角色配置由运行配置拥有者保存。
- 实际 `.env`、认证文件、会话、私有存档、运行日志、模型缓存和构建产物保存在私有位置。每个插件自己的 `.gitignore` 同时适用于将来独立仓库。
- 导出与打包共用 SDK 的公开源文件筛选入口；不会因为插件根目录出现本地配置，就把它当作公开默认值发布。提交前仍审阅差异和真实示例值。

存档稳定命名空间、迁移恢复、只读验收、远端真实旧来源和 Xiaomi 外部资源绑定见[插件存档](plugin-storage.md)。角色、Route 和原投递账本沿现有 owner 保存；旧消息和原请求 ID 不重新生成。

## 全部插件源码

下表由源码目录及正式 manifest 的引用生成。实时版本以链接的版本文件和运行界面为准。

<!-- plugin-source-index -->
| Plugin | Source folder | Version authority |
| --- | --- | --- |
| `io.rabiroute.agent.antigravity` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.antigravity) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.antigravity/rabi.plugin.json) |
| `io.rabiroute.agent.astrbot` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.astrbot) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.astrbot/rabi.plugin.json) |
| `io.rabiroute.agent.codex` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.codex) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.codex/rabi.plugin.json) |
| `io.rabiroute.agent.copilot-cli` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.copilot-cli) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.copilot-cli/rabi.plugin.json) |
| `io.rabiroute.agent.device-agent` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.device-agent) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.device-agent/rabi.plugin.json) |
| `io.rabiroute.agent.dsh` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.dsh) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.dsh/rabi.plugin.json) |
| `io.rabiroute.agent.grok-bot` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.grok-bot) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.grok-bot/rabi.plugin.json) |
| `io.rabiroute.agent.marvis` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.marvis) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.marvis/rabi.plugin.json) |
| `io.rabiroute.agent.workbuddy` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.agent.workbuddy) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.agent.workbuddy/rabi.plugin.json) |
| `io.rabiroute.endpoint.feishu` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.feishu) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.feishu/rabi.plugin.json) |
| `io.rabiroute.endpoint.heartbeat` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.heartbeat) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.heartbeat/rabi.plugin.json) |
| `io.rabiroute.endpoint.napcat` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.napcat) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.napcat/rabi.plugin.json) |
| `io.rabiroute.endpoint.rabilink` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.rabilink) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.rabilink/rabi.plugin.json) |
| `io.rabiroute.endpoint.speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.speech) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.speech/rabi.plugin.json) |
| `io.rabiroute.endpoint.webhook` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.webhook) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.webhook/rabi.plugin.json) |
| `io.rabiroute.endpoint.wecom` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.wecom) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.wecom/rabi.plugin.json) |
| `io.rabiroute.endpoint.weixin` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.endpoint.weixin) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.endpoint.weixin/rabi.plugin.json) |
| `io.rabiroute.manager.agent-adapter-catalog` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-adapter-catalog) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-adapter-catalog/rabi.plugin.json) |
| `io.rabiroute.manager.agent-communication` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-communication) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-communication/rabi.plugin.json) |
| `io.rabiroute.manager.agent-state-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-state-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-state-control/rabi.plugin.json) |
| `io.rabiroute.manager.agent-thread-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.agent-thread-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.agent-thread-control/rabi.plugin.json) |
| `io.rabiroute.manager.bilibili-history` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.bilibili-history) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.bilibili-history/rabi.plugin.json) |
| `io.rabiroute.manager.core` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.core) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.core/rabi.plugin.json) |
| `io.rabiroute.manager.desktop` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.desktop) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.desktop/rabi.plugin.json) |
| `io.rabiroute.manager.desktop-pet` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.desktop-pet) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.desktop-pet/rabi.plugin.json) |
| `io.rabiroute.manager.diagnostics` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.diagnostics) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.diagnostics/rabi.plugin.json) |
| `io.rabiroute.manager.gateway-runtime` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.gateway-runtime) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.gateway-runtime/rabi.plugin.json) |
| `io.rabiroute.manager.html-shares` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.html-shares) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.html-shares/rabi.plugin.json) |
| `io.rabiroute.manager.memory-consolidation` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.memory-consolidation) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.memory-consolidation/rabi.plugin.json) |
| `io.rabiroute.manager.message-adapter-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-adapter-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-adapter-control/rabi.plugin.json) |
| `io.rabiroute.manager.message-processing-automation` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-processing-automation) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-processing-automation/rabi.plugin.json) |
| `io.rabiroute.manager.message-processing-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.message-processing-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.message-processing-control/rabi.plugin.json) |
| `io.rabiroute.manager.performance` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.performance) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.performance/rabi.plugin.json) |
| `io.rabiroute.manager.persona` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.persona) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.persona/rabi.plugin.json) |
| `io.rabiroute.manager.plan-feedback-delivery` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.plan-feedback-delivery) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.plan-feedback-delivery/rabi.plugin.json) |
| `io.rabiroute.manager.rabilink-relay` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.rabilink-relay) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.rabilink-relay/rabi.plugin.json) |
| `io.rabiroute.manager.remote-agent` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.remote-agent) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.remote-agent/rabi.plugin.json) |
| `io.rabiroute.manager.route-control` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.route-control) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.route-control/rabi.plugin.json) |
| `io.rabiroute.manager.speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.speech) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.speech/rabi.plugin.json) |
| `io.rabiroute.manager.video` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.video) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.video/rabi.plugin.json) |
| `io.rabiroute.manager.wearable-companion` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.wearable-companion) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.wearable-companion/rabi.plugin.json) |
| `io.rabiroute.manager.xiaomi-home` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.xiaomi-home) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.xiaomi-home/rabi.plugin.json) |
| `io.rabiroute.manager.yeyu-gamer` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/io.rabiroute.manager.yeyu-gamer) | [rabi.plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/io.rabiroute.manager.yeyu-gamer/rabi.plugin.json) |
| `napcat-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/napcat-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/napcat-rabiroute/package.json) |
| `napcat-stickers` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/napcat-stickers) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/napcat-stickers/package.json) |
| `rabi-antigravity-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-antigravity-context) | [plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-antigravity-context/plugin.json) |
| `rabi-codex-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-codex-context) | [.codex-plugin/plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-codex-context/.codex-plugin/plugin.json) |
| `rabi-dsh-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-dsh-context) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-dsh-context/package.json) |
| `rabi-speech` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-speech) | [rabi-plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-speech/rabi-plugin.json) |
| `rabi-workbuddy-context` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/rabi-workbuddy-context) | [.codebuddy-plugin/plugin.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/rabi-workbuddy-context/.codebuddy-plugin/plugin.json) |
| `remote-agent-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/remote-agent-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/remote-agent-rabiroute/package.json) |
| `xiaoai-rabiroute` | [source](https://github.com/vb2250158/RabiRoute/tree/main/src/plugins/xiaoai-rabiroute) | [package.json](https://github.com/vb2250158/RabiRoute/blob/main/src/plugins/xiaoai-rabiroute/package.json) |
<!-- /plugin-source-index -->
