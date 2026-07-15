# RabiRoute

![RabiRoute 拉比路由](assets/rabiroute-hero.png)

RabiRoute 是一个轻量 **Agent-neutral Context Router / Action Gate**。

它不拥有 Agent，也不替 Agent 思考。它拥有的是跨 Agent 可迁移的上下文、路由决策和外部动作安全门：把来自聊天平台、定时器、Webhook、本地语音或脚本的事件规范化、分诊、补上下文、套模板，再投递给合适的 Agent、脚本、工作流或人工队列。

一句话：

```text
RabiRoute 不拥有 Agent，但拥有上下文和门。
```

它更像分诊台、调度台或转运中心：

```text
QQ / Webhook / Scheduler / Voice / CLI
        ↓
    RabiRoute
        ↓
事件记录 → 可迁移上下文 → 路由决策 → 动作安全门
        ↓
Codex / Hermes / Copilot / Workflow / Script / Human Queue
```

更具体地说：

```text
处理端解决：“具体怎么做”。
RabiRoute 解决：“这件事该送到哪里、带什么材料、能不能外发、结果怎么回”。
```

RabiRoute 不是完整个人 Agent OS，不是聊天机器人框架替代品，也不是某个 AI 工具的外壳。Codex 只是当前第一条已验证处理端；Hermes、Copilot、脚本、工作流和人工队列都可以成为处理端。项目边界是跨 Agent 上下文迁移、消息级分诊、策略调度和外部动作控制。

GitHub: https://github.com/vb2250158/RabiRoute

## 边界

RabiRoute 只守住那些不能交给单一 Agent 私有化的东西：

- 可迁移上下文：身份映射、角色路由、关键偏好、任务状态、消息事件索引和失败案例。
- 路由控制逻辑门：判断消息是否触发、触发哪条 route、交给哪个处理端、使用哪个模板。
- 外部动作安全门：QQ/NapCat 发送、TTS 播放、文档写回、设备控制和外部 API 默认先进入 draft / approval / audit。
- 可观测记录：原始事件、规范化事件、投递记录、后续 route decision 和 action log。

RabiRoute 不做这些事：

- 不替代 Codex、Hermes、Copilot 或其他 Agent runtime。
- 不把长期记忆、工具调用、规划和执行全部塞进自己体内。
- 不把某个处理端的私有记忆当作项目事实源。
- 不让处理端绕过 RabiRoute 直接群发、写外部系统或控制设备，除非显式授权。

推荐关系：

```text
RabiRoute 保存可迁移事实和路由决策。
Agent runtime 保存自己的深层运行状态和私有记忆。
RabiRoute 给不同 Agent 注入同一份 portable context packet。
Agent 产出结果或 action request。
RabiRoute 决定自动执行、生成草稿、等待确认或拒绝。
```

## 当前能力

- NapCat / OneBot WebSocket 接入 QQ 群聊和私聊。
- QQ 合并转发消息会通过 NapCat `get_forward_msg` 展开，内部聊天按时间、发送者和文本/媒体证据写入消息日志并进入 Agent 上下文。
- 独立 RibiWebGUI 管理多个 Gateway：`http://127.0.0.1:8790/`。
- NapCat 只是一个消息端适配器；NapCat 插件是可选入口，用于从 NapCat 插件页跳转到 RibiWebGUI。
- 同一 Gateway 可启用多个消息适配端：NapCat / OneBot、定时触发、Webhook、语音转写入口。
- 群消息路由：直接 @、直接回复、间接回复、普通群消息关键词规则。
- 私聊和定时触发 `heartbeat` 路由。
- JSONL 消息记录、心跳记录、投递记录。
- 可编辑 Prompt 模板、路由规则和路由人格包。
- Pipeline preset：为 QQ、语音、Webhook 任务声明输入输出意图。
- Agent 端适配器：当前支持 `codex`、命令式 `copilotCli` 和 Marvis handoff；`codex` 连接 Manager 拥有的唯一共享 app-server，Codex/ChatGPT Desktop 与 CLI 连接同一 Runtime。
- Codex 默认通过 `model/list` 跟随 runtime 当前默认模型，`agentModel` 只有显式填写时才固定覆盖；默认使用 `workspaceWrite` 沙箱，审批无法得到明确结论时按拒绝处理。

这里的名词不能混用：OpenAI 是 provider，Codex 是 agent，共享 `codex app-server` 是 Runtime，Desktop/CLI/Rabi 是客户端，具体 GPT 版本是 model。桌面产品改名或合并不改变 RabiRoute 的 `codex` adapter id。

```text
                         唯一会话/任务真源
                  codex app-server :4510
                 /          |           \
       RabiRoute gateway  Desktop     Codex CLI
          精确 threadId    实时刷新     --remote
```

桌面端首次切换运行 `npm run configure:codex-desktop`，重启桌面端后生效；CLI 使用 `npm run codex:shared -- <args>`。RibiWebGUI 下拉显示“会话名 + 最后会话时间”，内部保存完整线程 ID；直接输入不存在的名称会在共享 Runtime 中创建新会话。

## 文档索引

所有项目级文档集中在 [docs/](docs/README.md)。

- 新用户先看：[快速上手](docs/getting-started.md)
- 配置 gateway、RibiWebGUI、Agent 端和可选 NapCat 入口：[配置与接入](docs/configuration.md)
- 配 `adapterConfig.json`、消息端和路由入口：[路由配置](docs/routing-configuration.md)
- 配 pipeline preset、输入输出适配器和 OumuQ TTS 意图：[Pipeline presets](docs/pipeline-presets.md)
- 写人格角色包和成长型人格：[路由人格](docs/routing-and-personas.md)
- 理解计划、记忆和 Agent 上下文注入：[计划和记忆机制](docs/plan-and-memory-model.md)
- 给处理端 Agent 对接内置计划、记忆和回复接口：[Agent 需要关注的 Rabi 接口](docs/rabi-agent-interfaces.md)
- 接 FenneNote 转录、角色对话和 OumuQ TTS：[语音交互工作站](docs/voice-interaction-workstation.md)
- 外发失败、Codex app-server、普通群消息不转发：[排障](docs/troubleshooting.md)
- 想理解边界和演进路线：[架构说明](docs/architecture.md)
- 找后端、manager、WebGUI 和托盘窗口改动入口：[代码架构](docs/code-architecture.md)
- 看版本变更和迁移说明：[版本更新日志](版本更新日志.md)

## 最小启动

Windows PowerShell：

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

macOS / Linux：

```bash
cd /path/to/RabiRoute
npm install
npm run build
npm run start:manager
```

打开：

```text
http://127.0.0.1:8790/
```

## 当前数据格式

运行期数据按“路由入口”和“人格规则”分开保存：

```text
data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
```

`adapterConfig.json` 负责消息适配器、端口、Agent 适配器、工作目录、pipeline preset 和指向哪个人格；`personaConfig.json` 负责该人格的消息模板规则，以及投递时附带的最近消息数量 `recentMessageLimit`（默认 10，设为 0 可关闭）。不要再把消息入口和人格模板规则混进同一个配置文件。

旧本地数据迁移时，按下面关系处理：

```text
data/route/<configName>/routeConfig.json        -> data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/roleMessageConfig.json      -> data/roles/<RoleId>/personaConfig.json
```

旧的 `data/gateways.json` 和 `data/roles/<RoleId>/routes.json` 不再作为新版主配置入口。迁移真实运行期数据前，先备份整个 `data/`，迁移后运行：

```powershell
npm run check:config
```

## 桌面任务托盘 MVP

RabiRoute 本体仍以 Node / CLI / npm scripts 作为跨平台基础启动方式。桌面任务面板使用 PySide6/Qt，面板代码本身按 Windows/macOS/Linux 可复用来组织；当前 Windows 额外提供启动器，用作打开 WebGUI、查看 Rabi 任务目录空状态或任务摘要的便利入口。它只读读取 `data/roles/<RoleId>/tasks` 和角色目录里的现有状态/记忆材料，不写任务数据，也不替代 RibiWebGUI。

Windows 桌面启动和完整打包的唯一真源是 [Windows 桌面启动与完整打包](docs/windows-launcher-and-packaging.md)。这里不重复维护打包边界，避免 README、脚本和真实启动器出现历史分叉。

悬浮窗当前包含这些可切换视图：当前计划/当前任务、未归档计划、近期记忆、沉淀记忆、任务、状态/路由状态。MCP/server/端口接口先不做，后续如需要再挂跨平台命令适配层。

运行前如需安装依赖：

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

启动托盘源码入口：

```powershell
py desktop\tray-task-window\main.py
```

Windows “1+1” 同生命周期入口使用：

```powershell
Start-RabiRoute-Tray.bat
```

它会启动/复用 manager，并启动 Qt 托盘/浮窗；只有当本次 launcher 启动了 manager 时，托盘右键退出才会带着 manager/gateway 一起 graceful shutdown。

如需 Windows exe，可用 `scripts\build-tray-exe.ps1` 在本地打包 `RabiRoute-Tray.exe` 做本机测试：

```powershell
.\scripts\build-tray-exe.ps1
```

注意：`RabiRoute-Tray.exe` 只是 Windows 完整桌面运行包里的托盘入口，不是单文件完整包。完整运行态还需要后端 `dist/`、前端 `ribiwebgui/dist/`、可写运行期 `data/`、Node runtime 和 npm 依赖。源码仓库只提交打包规范和脚本，不提交生成的 exe。公开发布包暂不启用，避免把本机路径或私有信息带进二进制资产。

Mac / Linux 可以继续用上面的 Node 启动方式运行 manager/WebGUI；这部分已经是跨平台基线。未来如果需要桌面入口，应只新增 macOS/Linux 平台 launcher，复用同一套 Qt 面板、manager HTTP API、shutdown API、`ManagerClient`、`TaskRepository`、`RoleContextRepository`、路径解析和生命周期 ownership 规则；Windows exe 打包只是便利发布层，不应分叉服务端或 WebUI。

## Windows 中文消息注意

如果要测试 OneBot HTTP 主动发中文或多行消息，优先使用项目内 Node 脚本，不要用 PowerShell `Invoke-WebRequest` 直接拼中文 JSON。脚本会使用 `fetch`、`Content-Type: application/json; charset=utf-8` 和 `JSON.stringify`，避免中文乱码或换行异常。

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "中文测试\n第二行"
npm run check:config
```

配置文件也要避免混入字面量 `\n`。如果 `data/route` 或 `data/roles` 下的 JSON 末尾出现可见的 `\n`，可能导致 JSON 解析或 reload 异常。详见 [排障：中文消息乱码或多行发送异常](docs/troubleshooting.md#中文消息乱码或多行发送异常)。

## 目录结构

```text
src/                                RabiRoute manager、gateway、adapter、forwarding 源码
ribiwebgui/                          独立 RibiWebGUI 控制台
plugin-adapters/                     插件侧适配入口，后续新增插件都放这里
plugin-adapters/napcat-rabiroute/    可选 NapCat 插件入口
examples/data/                       可复制到根目录 data/ 的完整示例包，含默认 Rabi 与 RabiLink 主动智能模板
skills/create-rabiroute-persona/     项目内 skill：指导创建 RabiRoute 人格
skills/rabi-github-pull/              项目内 skill：指导 RabiRoute 拉取后配置升级
skills/rabi-github-submit/            项目内 skill：指导 RabiRoute GitHub 提交前检查
skills/rabiroute-voice-workstation/   项目内 skill：指导语音转录、路由、角色对话和 TTS 工作站
docs/                                分主题说明文档
assets/                              README 和 RibiWebGUI 视觉资源
```

运行期文件默认不提交：

```text
.env
data/
dist/
logs/
node_modules/
recordings/
transcripts/
voice-cache/
```
