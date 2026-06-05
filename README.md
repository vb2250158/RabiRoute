# RabiRoute

![RabiRoute 拉比路由](assets/rabiroute-hero.png)

RabiRoute 是一个轻量 **Message Gateway / Policy Router**。它站在聊天平台、定时器、Webhook 和处理端之间，负责把一条消息规范化、分诊、补上下文、套模板，再投递给合适的 Agent、脚本、工作流或人工队列。

它更像分诊台、调度台或转运中心：

```text
QQ / Webhook / Scheduler / CLI
        ↓
    RabiRoute
        ↓
消息记录 → 路由规则 → 上下文模板 → 处理端选择
        ↓
Agent / Workflow / Script / Human Queue / External API
```

一句话：

```text
处理端解决 “具体怎么做”。
RabiRoute 解决 “这件事该送到哪里、带什么材料、按什么规则流转”。
```

RabiRoute 不是完整个人 Agent OS，不是聊天机器人框架替代品，也不是某个 AI 工具的外壳。Codex Desktop 只是当前第一条已验证处理端；项目边界是消息级分诊和策略调度。

GitHub: https://github.com/vb2250158/RabiRoute

## 当前能力

- NapCat / OneBot WebSocket 接入 QQ 群聊和私聊。
- 独立 RibiWebGUI 管理多个 Gateway：`http://127.0.0.1:8790/`。
- NapCat 只是一个消息端适配器；NapCat 插件是可选入口，用于从 NapCat 插件页跳转到 RibiWebGUI。
- 同一 Gateway 可启用多个消息适配端：NapCat / OneBot、定时触发、禁用消息端。
- 群消息路由：直接 @、直接回复、间接回复、普通群消息关键词规则。
- 私聊和定时触发 `heartbeat` 路由。
- JSONL 消息记录、心跳记录、投递记录。
- 可编辑 Prompt 模板、路由规则和路由人格包。
- Agent 端适配器：当前支持 Codex Desktop IPC 和旧调试通道 `codexApp`。

## 文档索引

所有项目级文档集中在 [docs/](docs/README.md)。

- 新用户先看：[快速上手](docs/getting-started.md)
- 配置 gateway、RibiWebGUI、Agent 端和可选 NapCat 入口：[配置与接入](docs/configuration.md)
- 配 `routeConfig.json`、消息端和路由入口：[路由配置](docs/routing-configuration.md)
- 写人格角色包和成长型人格：[路由人格](docs/routing-and-personas.md)
- 接 FenneNote 转录、角色对话和 OumuQ TTS：[语音交互工作站](docs/voice-interaction-workstation.md)
- 外发失败、Codex IPC、普通群消息不转发：[排障](docs/troubleshooting.md)
- 想理解边界和演进路线：[架构说明](docs/architecture.md)
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

## Windows 中文消息注意

如果要测试 OneBot HTTP 主动发中文或多行消息，优先使用项目内 Node 脚本，不要用 PowerShell `Invoke-WebRequest` 直接拼中文 JSON。脚本会使用 `fetch`、`Content-Type: application/json; charset=utf-8` 和 `JSON.stringify`，避免中文乱码或换行异常。

```powershell
npm run send:onebot -- --group 123456 --message "中文测试\n第二行"
npm run check:config
```

配置文件也要避免混入字面量 `\n`。如果 `data/route` 或 `data/roles` 下的 JSON 末尾出现可见的 `\n`，可能导致 JSON 解析或 reload 异常。详见 [排障：中文消息乱码或多行发送异常](docs/troubleshooting.md#中文消息乱码或多行发送异常)。

## 目录结构

```text
src/                                RabiRoute manager、gateway、adapter、forwarding 源码
ribiwebgui/                          独立 RibiWebGUI 控制台
plugin-adapters/                     插件侧适配入口，后续新增插件都放这里
plugin-adapters/napcat-rabiroute/    可选 NapCat 插件入口
examples/data/                       可复制到根目录 data/ 的完整示例包，含唯一 Rabi 示例人格
skills/create-rabiroute-persona/     项目内 skill：指导创建 RabiRoute 人格
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
