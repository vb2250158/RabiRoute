<!-- docs-language-switch -->
<div align="center">
<a href="./operations-and-troubleshooting_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 运行、日志与排障

排障时不要把“消息没回复”当成一个整体问题。沿着消息链逐段确认，就能判断故障在平台、规则、投递还是回传。

```text
消息端 -> 事件记录 -> 规则命中 -> AgentPacket -> 处理端 -> Outbox / 外部平台
```

## 先看诊断摘要

打开“日志诊断”。“诊断摘要”会把当前能识别的连接和配置断点放在最前面。

摘要显示“链路正常”只表示没有发现已知断点。如果消息仍未到达，继续检查下方连接详情和最近日志。

<div class="screenshot-placeholder">
  <strong>截图占位 12｜诊断摘要与连接详情</strong>
  <span>建议画面：诊断摘要、运行状态、消息端连接和 Codex Desktop 任务卡片。</span>
  <span>标注重点：待检查项、运行状态、消息端、任务绑定、最后成功、最后错误。</span>
</div>

## 用证据判断停在哪一段

| 已有证据 | 说明 | 下一步 |
| --- | --- | --- |
| 没有消息记录 | 事件没有进入 RabiRoute | 查平台登录、连接、端口和输入 policy |
| 有消息记录，没有 `agent-packets.jsonl` | 消息进入但规则没命中 | 查人格绑定、`configName`、route kind 和 regex |
| 有 AgentPacket，Desktop 没消息 | 处理端投递失败 | 查任务 ID、工作目录、Desktop IPC 和最后错误 |
| Desktop 有结果，平台没回复 | 回传没有完成 | 查 replyContext、pipeline、输出 policy 和 Outbox 日志 |
| Outbox 为 `blocked` | policy 或目标不允许外发 | 修正明确目标或授权，不要绕过安全门 |
| Outbox 为 `failed` | 已尝试发送但平台调用失败 | 修复平台状态后明确重试 |

常见运行文件位于 `data/route/<配置名>/`。不要把运行期 JSONL、真实消息和账号信息提交到仓库。

## 手动触发的用途与副作用

“手动触发”可以执行 `manual_trigger` 或 `heartbeat` 规则，用来验证规则到处理端的链路。

它会：

- 写手动触发和路由日志。
- 构造真实 AgentPacket。
- 向处理端开始真实投递。
- 在处理端执行时使用该任务自己的权限。

它不会模拟外部 QQ 消息，也不是无副作用预览。验证群消息 regex 时，仍要使用受控的真实测试消息或检查 RouteDecision 证据。

## 最近日志怎么看

“最近日志”显示当前 Route 的最近 gateway 输出。先找最新时间，再看第一条错误，不要被旧启动周期的历史错误误导。

<div class="screenshot-placeholder">
  <strong>截图占位 13｜最近日志与时间边界</strong>
  <span>建议画面：最近日志区域包含一次触发的开始、投递和结果，时间戳清晰。</span>
  <span>标注重点：本次启动时间、第一条错误、目标 Route、投递协议。</span>
</div>

升级代码后如果仍看到旧行为，重新构建并重启 Manager 与 Route，再核对启动目录和 `dist/` 时间。历史日志可以保留，但不能代表本次运行状态。

## NapCat 打开后显示 Unauthorized 或 Token 登录页

从 Route 页点击“打开 NapCat”时，RabiRoute 会直接打开带当前 WebUI token 的 `/web_login` 地址。这个入口会重新建立 WebUI 会话，避免 NapCat 重启后旧标签页残留的凭据继续触发 `Unauthorized`。

如果仍停在空 Token 登录页，先关闭旧 NapCat 标签页，再从当前 QQ 实例卡片重新点击“打开 NapCat”。确认实例卡片已保存 WebUI 登录密钥；升级过源码但仍打开旧地址时，需要重新构建并重启 Manager。快速启动只检查 OneBot / WebUI 是否可用，不再同步等待 Windows 全量进程枚举；完整进程列表仍可在显式健康检查和详情中读取。

## NapCat 已连接但没有 AgentPacket

先确认 `group-messages.jsonl` 或 `private-messages.jsonl` 是否出现新记录。

- 没有记录：查 QQ 登录、WebSocket Client、端口和接收 policy。
- 有记录：查人格规则的 `configName`、route kind、目标群和 regex。
- 合并转发只有 ID：查 OneBot HTTP 和 `get_forward_msg`。

## NapCat 能收不能发

OneBot HTTP 可访问不代表 QQ 核心一定能发送。检查登录状态、quick login、设备验证、Windows 时间和 NapCat 日志。

Outbox 发送失败会保留 `failed` 和 draft 数据。当前没有通用自动重试队列；修复登录后需要明确重试，避免重复发送。

## Codex 没收到消息

按顺序检查：

1. Desktop 已打开并能进入目标任务。
2. Agent 扫描能看到该任务和工作目录。
3. 保存的任务 ID 仍存在，目录没有移动。
4. 日志诊断显示投递协议为 `desktop-ipc`。
5. `no-client-found` 自动唤醒后是否仍失败。

不要用固定 4510、`CODEX_APP_SERVER_WS_URL` 或独立 stdio Runtime 修复真实投递；这些不是当前主链。

## 8790 被旧 Manager 占用

如果启动器提示 `8790` 已监听，但 `/meta` 没有稳定响应，常见原因是同一项目的旧 Manager 仍占着端口。远程页面反复断线重连、Relay 或 SSE 异常不应该成为本地启动依赖；当前实现会让 Manager 先提供本机/局域网 WebGUI，再异步热连 Relay。

重新运行 `Start-RabiRoute-Tray.bat`。启动器会核对端口 owner 的命令行，只对精确指向本项目 `dist/manager.js` 的旧实例执行有界接管：先请求优雅关闭，超时后才终止已核实的进程树。未知进程不会被停止。如果当前 `dist` 比健康运行实例更新，启动器也会重载当前构建。

恢复后分别验证：本机或局域网 `/meta` 可用；Relay 状态可在稍后恢复为在线；远程 `/api/events` 与 `/api/speech/events` 可重连；媒体 `Range` 请求仍返回 `206`。Relay 暂时离线时，本机和局域网仍应可用，不需要反复重启 Manager。

如果计划页提交审批意见时正好遇到 Manager 重启或短暂断网，页面会明确提示无法连接，并保留本次文字、附件和同一条幂等 `feedbackId`。先确认页面右上角恢复为“Manager 已连接”或 `/meta` 已响应，再直接重试；不要因为看到旧版浏览器错误 `Failed to fetch` 而重新输入或重复创建另一条审批意见。

## 何时重启

适合重启的情况：

- 刚完成新构建。
- 外部端口或连接配置变化。
- Route 子进程退出。
- 日志证明运行的是旧产物。

规则、人格或普通表单改动应先保存。不要把重启当成保存，也不要在没有证据时反复重启外部平台。

## 反馈问题前准备

收集这些信息即可，不要上传整个运行目录：

- RabiRoute 版本和启动方式。
- 操作系统、Node.js 版本。
- Route 使用的消息端与处理端。
- 复现步骤和预期结果。
- 本次启动后的最小相关日志。
- 已脱敏的状态截图。

更多模板见[常见问题与获得帮助](faq-and-support.md)。
