<!-- docs-language-switch -->
<div align="center">
English | 简体中文
</div>
<!-- /docs-language-switch -->

# 参与 RabiRoute

RabiRoute 是一个连接层。每个消息入口、每个 Agent 处理端都是独立插件，所以**接一个平台本身就是一次完整的贡献** —— 不需要先读懂整个路由。

这也是最快的参与方式：挑一个你自己在用的平台，把它做成插件，路由、计划、记忆和投递账本都复用现成的。

## 能贡献什么

| 类型 | 需要什么 | 从哪开始 |
| --- | --- | --- |
| 加一个消息入口 | 熟悉某一个平台的 SDK | `src/plugins/io.rabiroute.endpoint.*` |
| 加一个 Agent 处理端 | 那个 Agent 的 IPC、CLI 或 HTTP 接口 | `docs/agent-adapter-standard-requirements.md` |
| 修 bug | 能复现、会看日志 | 先开 issue |
| 改 WebGUI | Vue 3 和 TypeScript | `ribiwebgui/` |
| 写文档或翻译 | 表达清楚 | `docs/` |

## 先跑起来

Node.js 22.13 以上。

只想用的话，按[开始使用](docs/getting-started.md)装打包版。从源码构建在 Windows 上还需要 .NET 9 SDK。

```bash
npm install
npm run build
npm run start:manager
```

Manager 启动后会打印它绑定的地址，WebGUI 就在那个地址上。

## 测试

跑覆盖你改动范围的测试就够，不必每次跑全量。

```bash
npm test              # 后端与共享契约
npm run webgui:build  # WebGUI 构建
npm run check:config  # 配置文本检查
```

`npm test` 固定 `--test-concurrency=2`，因为多个测试套件共用同一套 Manager 运行环境。提高并发会跑出和你的改动无关的失败。

## 代码约定

- TypeScript 严格模式。新的公开契约里不要用 `any`。
- 新平台是 `src/plugins/<plugin-id>/` 下的独立包。不要把名字加进中央工厂、再把实际逻辑转调已有插件 —— 插件边界正是让一个坏适配器拖不垮其他的原因。
- 只声明你真正验收过的能力。声明了却没验收，用户点开就是一个必然失败的面板。
- 中英文文档同步。改了行为却没有对应译文，算没做完。

## 提 PR

- 一个 PR 只做一件事。
- 说明你看到了什么现象、为什么发生、改了什么。现象比 diff 本身更重要。
- 写清怎么验证的：哪条命令、哪个测试、哪个页面。
- WebGUI 改动附截图。

## 接一个新平台

动手前先读[标准 Agent 端接入需求](docs/agent-adapter-standard-requirements.md)。它定义了插件合同、能力声明规则，以及一个平台要被称作「已验证」之前必须过哪些验收。

平台分两类，不能混为一谈：

- **消息入口**：从聊天平台接收，把规范化事件交给路由器。
- **Agent 处理端**：把路由后的消息投进 Agent 任务，再把结果带回来。

一个平台包最少包含 `rabi.plugin.json`、`agent-adapter.json`，以及该平台自己的 Manager、Gateway 和 Web 入口。可复用的操作步骤见 `skills/create-rabiroute-agent-adapter/`。

## 不要做的事

- 不要把凭据、token、会话 cookie 或私有工作区路径提交进仓库。
- 不要把实验路径描述成已验证，也不要声明没实际跑过的能力。
- 不要为已经不存在的调用方保留兼容分支。直接删掉，并在版本更新日志里记一笔。

## 提问

直接开 issue。如果问题只涉及某一个平台，说明是哪个平台、你已经试过什么 —— 这能把一句模糊的报障变成能复现的问题。
