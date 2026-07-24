<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 使用手册

这套手册面向在 RibiWebGUI 中配置和运行 RabiRoute 的软件使用者。它从第一次打开界面讲起，不要求你先理解代码、Schema 或 Agent 内部实现。

> 适用版本：RabiRoute 0.1.x。项目仍在积极开发；界面中的“实验支持”表示已有入口，但外部平台或真机链路仍需按你的环境验收。

## 先理解一件事

RabiRoute 是消息分诊和调度层。它接收消息、记录事件、判断路由、补齐上下文，再把任务交给 Codex 或其他处理端。真正回答、写代码和调用工具的是处理端。

在界面里，一条 **Route（航线）** 就是一套可独立启停的消息流配置：

```text
消息端 -> 匹配规则 -> 人格与上下文 -> Agent 处理端 -> 回复或草稿
```

- **消息端**决定消息从哪里来，例如 NapCat / QQ、Heartbeat、Webhook 或 RabiLink。
- **人格与规则**决定哪些消息命中，以及交给 Agent 时附带什么说明。
- **Agent 端**决定消息交给哪个处理端、项目目录和任务。
- **日志诊断**帮助你判断消息停在了哪一段。

## 第一次使用走哪条路

如果你只想确认软件能跑通，先用 Heartbeat 加 Codex。它不依赖 QQ 登录，最适合验证第一条投递。

1. 打开左下角“快速配置”。
2. 消息入口选择“定时触发”。
3. Agent 选择 Codex，并绑定项目目录与 Desktop 任务。
4. 人格可以先留空，保存配置。
5. 到“日志诊断”手动触发一次并确认任务收到消息。

完整步骤见[跑通第一条 Route](first-route.md)。需要接 QQ 时，再阅读[Route 与消息端](routes-and-adapters.md)。

<div class="screenshot-placeholder">
  <strong>截图占位 01｜RibiWebGUI 控制台全貌</strong>
  <span>建议画面：首次打开后的桌面宽屏控制台，保留左侧导航、当前 Route、顶部连接状态、核心状态卡和快速配置按钮。</span>
  <span>标注重点：当前 Route、Manager 连接、运行状态、快速配置、保存配置、日志诊断入口。</span>
</div>

## 按目标找文档

| 你想完成的事 | 从这里开始 |
| --- | --- |
| 第一次配置并验证投递 | [跑通第一条 Route](first-route.md) |
| 看懂导航、状态和保存提示 | [界面与状态](interface-and-status.md) |
| 接 QQ、定时器、Webhook 或 RabiLink | [Route 与消息端](routes-and-adapters.md) |
| 从其他设备调用目标 PC 的 TTS / ASR | [从远端调用 TTS 与 ASR](speech-api.md) |
| 绑定 Codex 或其他处理端 | [Agent、项目与任务](agents-and-sessions.md) |
| 配置人格、命中规则和定时计划 | [人格与消息规则](personas-and-rules.md) |
| 消息没到、状态异常或需要复盘 | [运行、日志与排障](operations-and-troubleshooting.md) |
| 理解回复权限、草稿和本地数据 | [安全、回传与数据](safety-and-data.md) |
| 查常见问题或准备反馈材料 | [常见问题与获得帮助](faq-and-support.md) |

## 使用手册与开发文档的区别

这套手册只解释“怎么使用”和“怎么判断结果”。页面中只在排障确实需要时提到文件名或技术边界。

如果你要扩展适配器、修改路由算法或阅读 API，请从[项目文档索引](../README.md)进入。当前能力边界以[当前能力与成熟度](../current-capabilities.md)为准。

## 阅读约定

- 路径、任务名、规则名、token 和日志内容保持原文，不会随界面语言自动翻译。
- “保存配置”会写入本地配置；某些改动还会同步或重启当前 Route。
- “手动触发”会进入真实投递链，不是无副作用预览。
- 外发结果可能是 `sent`、`draft`、`blocked` 或 `failed`；当前没有通用的外部动作 WebGUI 审批中心。计划页可记录审批建议，但只通知 Agent，不批准外发或自动推进计划。

## 下一步

继续阅读[跑通第一条 Route](first-route.md)。如果你已经有运行中的 Route，可以直接查看[界面与状态](interface-and-status.md)或[运行、日志与排障](operations-and-troubleshooting.md)。
