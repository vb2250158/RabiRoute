<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Remote Agent Bridge

这是 RabiRoute 的独立无人值守远端 Agent bridge。远端机器不需要安装完整 RabiRoute；Windows 发布包已经内置 Node.js、固定版本的 `@openai/codex` Runtime 和全部生产依赖。

当前成熟度仍是 `experimental`：协议、认证、任务串行、超时、文件传输和打包烟测已有自动化覆盖，但每台真实远端设备仍需完成 Codex 登录、项目权限和双向任务验收后，才能视为该设备可用。

## Windows 开箱即用包

从 [GitHub Releases](https://github.com/vb2250158/RabiRoute/releases) 下载：

- `RabiRoute-Remote-Agent-<version>-windows-x64-setup.exe`：当前用户安装版，创建开始菜单入口。
- `RabiRoute-Remote-Agent-<version>-windows-x64-portable.zip`：解压后双击 `RabiRoute-Remote-Agent.exe`。
- `SHA256SUMS.txt`：发布资产校验值。

首次启动：

1. 双击 `RabiRoute-Remote-Agent.exe`。
2. 输入远端 Agent 允许工作的项目目录。该目录会成为默认且唯一的可写根。
3. 启动器自动生成高熵设备密码，并检查内置 Codex 的登录态；未登录时会引导执行官方登录。
4. 保持窗口运行。在主控电脑打开 RabiGUI，启用 Remote Agent 消息端，扫描设备并输入窗口显示的密码。

本机私有配置写到：

```text
%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json
```

发布包不包含这份文件。安装升级不会覆盖它，便携包也不会把密码写回解压目录。

常用命令：

```powershell
RabiRoute-Remote-Agent.exe --configure
RabiRoute-Remote-Agent.exe --show-config
RabiRoute-Remote-Agent.exe --print-password
RabiRoute-Remote-Agent.exe --check
```

当前二进制尚未代码签名，Windows SmartScreen 可能显示“未知发布者”。运行前请用 `SHA256SUMS.txt` 核对下载文件。

## 所有权和可观察合同

| 对象 | Owner | 启停与真源 | RabiRoute 能做什么 | 禁止替代 |
| --- | --- | --- | --- | --- |
| 远端 Host | 远端 Windows 用户 | 用户启动/关闭 EXE，终端显示状态 | 打包启动器检查配置与登录 | 主控机代替远端 Runtime |
| Runtime | 远端 bridge 固定版本 Codex | bridge 按需启动自己的 stdio app-server | 发送精确任务、读取真实终态 | 接管主控机 Desktop |
| Transport | bridge 与 Manager | v3 WebSocket 密码挑战 | 发现、认证、任务与事件 | 离线时换到另一台同名设备 |
| Session | 远端 Codex Runtime | `deviceId + canonical cwd + threadName` | 同 key 串行与幂等回传 | 跨设备或跨 cwd 串会话 |
| Tool/approval | 远端 Codex Runtime | `workspaceWrite`，审批失败关闭 | 使用远端 Runtime 实际能力 | 用 prompt 扩大权限 |

唯一真实消息路径：

```text
RabiRoute event -> Remote Agent Manager -> authenticated WebSocket
  -> exact remote device bridge -> pinned Codex app-server
  -> canonical project/session -> terminal event -> originating local persona
```

这是远端无人值守 Runtime，不是本机 Codex/ChatGPT Desktop adapter。它不共享固定端口、不修改 Desktop 环境变量，也不在 Desktop 缺席时充当 fallback。

## 安全默认值

- 没有公开默认密码。Windows 启动器首次配置时生成并持久化独立设备密码；源码启动未设置密码时，每次进程启动生成临时密码。
- v3 协议使用角色分离的 HMAC-SHA256 双向挑战。密码不经 WebSocket 发送。
- HMAC 只认证、不加密 `ws://` 流量；不可信网络必须走受信 VPN，或使用反向代理提供 `wss://`。
- 只有默认项目目录及显式 `REMOTE_AGENT_ALLOWED_CWDS` 根可写；每个任务重新解析真实路径，junction/symlink 不能逃逸。
- Codex 使用 `workspaceWrite`，不提供全盘执行模式。
- 网络默认关闭。只有显式设置 `REMOTE_AGENT_ALLOW_NETWORK=1` 才允许 Agent 网络访问。
- 启动 Codex app-server 前会从子进程环境移除 bridge 设备密码和启动器私有配置路径。
- 单文件默认上限 10 MiB，单任务默认总上限 25 MiB。

## 端口与发现

- 控制服务从 TCP `8797` 开始。
- LAN discovery 从 UDP `8798` 开始。
- 端口被占用时自动尝试后续端口；RabiGUI 使用 discovery 公告的真实控制地址。
- discovery 范围全部被占用时，控制服务仍启动并显示明确告警。

高级环境变量：

```powershell
$env:REMOTE_AGENT_PASSWORD="replace-with-a-long-random-secret"
$env:REMOTE_AGENT_DEVICE_NAME="Builder Device"
$env:REMOTE_AGENT_DEFAULT_CWD="C:\path\to\project"
$env:REMOTE_AGENT_DEFAULT_THREAD="Remote Agent"
$env:REMOTE_AGENT_CONTROL_PORT="8797"
$env:REMOTE_AGENT_DISCOVERY_PORT_START="8798"
$env:REMOTE_AGENT_DISCOVERY_PORT_END="8818"
$env:REMOTE_AGENT_PUBLIC_HOST="192.168.0.57"
$env:REMOTE_AGENT_PUBLIC_CONTROL_URL="wss://agent.example.com/api/remote-agent/control"
$env:REMOTE_AGENT_ALLOWED_CWDS='["C:\\path\\to\\project"]'
$env:REMOTE_AGENT_ALLOW_NETWORK="0"
$env:REMOTE_AGENT_RESUMED_TURN_WAIT_MS="30000"
$env:REMOTE_AGENT_TASK_TIMEOUT_MS="1800000"
```

`REMOTE_AGENT_PUBLIC_CONTROL_URL` 只接受 path 精确为 `/api/remote-agent/control` 的绝对 `ws://`/`wss://` URL；禁止凭据、query 和 fragment。

## 任务和文件

相同 canonical `threadName + cwd` 的任务保持串行。恢复已有 `inProgress` turn 时有界等待；仍繁忙则新建远端线程，不并发 start/steer。任务超时、中断、终态错误和 app-server 退出都会明确失败并释放队列。

Manager 可在 `POST /api/remote-agent/tasks` 中使用 `filePaths`、`files` 或 `attachments` 传入文件。bridge 将其写入：

```text
<临时目录>\rabiroute-remote-agent-files\<deviceId>\inbox\<taskId>\
```

bridge 的本机回调只监听回环：

```text
POST http://127.0.0.1:<actual-control-port>/v1/remote-agent/task-events
```

返回 `artifactPath`、`logPath` 或 `files[].path` 时，路径必须仍位于当前任务 canonical cwd 内。Manager 保存接受的文件后，再把结果投递回发起任务的本机人格；远端 Agent 不直接回复 QQ 或其他外部系统。

## 源码运行与构建

源码运行仍受支持：

```powershell
cd plugin-adapters\remote-agent-rabiroute
npm ci
npm start
```

构建 Windows 安装包、便携 ZIP 和校验清单：

```powershell
.\scripts\build-remote-agent-windows-release.ps1
```

构建需要 Windows x64、Node.js、稳定版 Rust MSVC 工具链和 Inno Setup 6。`remote-agent-v*` tag 会由 GitHub Actions 在干净的 Windows runner 上重复测试、构建、烟测并发布资产。
