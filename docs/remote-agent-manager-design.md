<!-- docs-language-switch -->
<div align="center">
<a href="./remote-agent-manager-design_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 轻量 Remote Agent Host 设计与验收合同

> 状态：v0.4 实现。Remote Agent 是独立 Agent 消息端，不是裁剪界面的完整 RabiManager。

## 用户可观察合同

| 要求 | 唯一实现 |
| --- | --- |
| 双击即可使用 | 无控制台窗口；首次启动自动生成设备 ID 和密码并打开 WebGUI |
| 不要求手输项目 | 项目和会话来自共享 Agent 扫描；一个可用 Codex 任务时自动绑定，多个候选使用下拉 |
| 与 RabiManager Agent 端一致 | Host 模式直接渲染同一个 `RouteConfigPage` Agent 区域，调用同一个 `src/agentAdapters` 扫描和投递模块 |
| 只出现必要设置 | 页面只包含 Remote Agent 设备/密码卡和 Agent 端卡；没有航线、人格、计划、语音或其他消息端设置 |
| 不依赖本机 RabiManager | 独立入口 `dist/remoteAgentHost.js` 拥有 HTTP/WebGUI、发现、认证和任务转发，不导入或启动 Manager 控制面 |
| 支持所有现有 Agent | Codex、Copilot CLI、Marvis、AstrBot 复用现有能力模型、成熟度、项目和会话 UI |
| 可被主 Manager 调用 | 兼容 Remote Agent v3 UDP 发现、HMAC 密码握手、WebSocket 任务和终态事件 |

## 所有权

| 对象 | Owner | 权威状态 |
| --- | --- | --- |
| 远端设备名、ID、密码 | Remote Agent Host config store | `%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json` |
| Agent 安装、登录、项目、会话能力 | `src/agentAdapters` 和各 Agent owner | 共享 scan/status API |
| Agent 选择和会话绑定 | Remote Agent profile | 同一配置文件的 `profile` |
| 任务来源、计划绑定、设备选择、结果回注 | 主 RabiManager | `RemoteAgentHub` |
| Codex 真实执行 | Codex/ChatGPT Desktop 目标任务 owner | Desktop IPC；失败时不启动备用 Runtime |
| Remote Agent WebGUI | 表现层 | 只维护瞬态展开、加载和错误状态 |

Remote Agent 配置存储只接受 Agent 字段白名单。即使前端提交航线、人格或消息端字段，也不会保存。

## 单一消息路径

```text
主 RabiManager / RemoteAgentHub
  -> v3 密码认证 WebSocket
  -> Remote Agent Host
  -> 已保存的 Agent adapter 列表
  -> 真实 Agent owner
  -> 本机 /api/agent/replies
  -> taskEvent(completed|failed)
  -> 主 RabiManager 原始任务/计划上下文
```

Host 不在 Agent 之间自动回退。选择多个 Agent 时，沿用 RabiManager 当前的并行投递语义；任一配置错误会明确失败。

## 进程与包边界

发布包只启动：

- 原生无窗口启动器；
- 内置 Node.js；
- `dist/remoteAgentHost.js`；
- 共享 Agent adapter 所需的生产依赖；
- RibiWebGUI 静态资源。

它不启动 `dist/manager.js`，也不携带运行期 `data/`、密码、token、日志或本机项目路径。旧 v0.3 Codex-only bridge 已移入 `archive/remote-agent-codex-bridge-v0.3.0/`，不再是发布入口。

## 最低验收

- 首屏只看到设备/密码和 Agent 配置，页面中不存在其他 Manager 导航或设置。
- 密码保存、最短长度拒绝、重新生成和复制可用。
- Agent 添加/移除、扫描、项目下拉、会话下拉和保存走共享 UI/API。
- Codex 页面仍显示 Desktop 必需宿主和 fail-closed 说明。
- v3 握手、任务接收、投递状态和终态回传有自动化测试。
- 安装版与便携版均无控制台、无首次项目问答、双击后打开 WebGUI。
- 发布包通过路径/secret 扫描并提供 SHA-256。
