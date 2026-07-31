<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Remote Agent

Remote Agent 是一个独立、轻量的 Rabi Agent 消息端。它让另一台 Windows 电脑上的 Agent 加入 Rabi 网络，由主 RabiManager 发现、连接并分配任务。

它不是第二个 RabiManager，也不是 Codex 专用 Runtime。安装包只提供：

- Remote Agent 设备名称、稳定设备 ID 和连接密码；
- 与 RabiManager WebGUI 相同的 Agent 配置界面；
- Codex、Copilot CLI、Marvis、AstrBot 的同一套扫描、认证、项目、会话和投递逻辑；
- 与主 RabiManager 通信的 Remote Agent v3 WebSocket/UDP 协议。

航线、人格、计划管理、语音服务和其他消息端仍由主 RabiManager 拥有，不会出现在 Remote Agent WebGUI。

## 开箱即用

1. 安装 `RabiRoute-Remote-Agent-0.4.0-windows-x64-setup.exe`。
2. 安装完成后 Remote Agent 自动启动并打开 WebGUI。
3. 首次启动会自动生成设备 ID 和高熵密码，不要求在终端输入项目目录。
4. 在 Agent 卡片中从扫描结果下拉选择本机项目和会话；如果 Codex Desktop 只有一个可用任务，Host 会自动绑定它。
5. 在主 RabiManager 的 Remote Agent 消息端中扫描设备，输入 WebGUI 显示的密码并连接。

以后双击桌面快捷方式只会启动 Host 或打开已运行的 WebGUI，不会弹出项目设置控制台。

## Agent owner 边界

- Codex 的真实消息仍只交给 Codex/ChatGPT Desktop 的目标任务 owner；Desktop 不可用时明确失败，不启动备用 Runtime。
- Copilot CLI、Marvis、AstrBot 使用 RabiManager 已有的 adapter 实现和成熟度口径。
- Remote Agent Host 只负责接收任务、调用选定 adapter，并把 Agent 通过本机回传 API 提交的终态结果送回主 RabiManager。
- 主 RabiManager 继续拥有任务来源、计划绑定、远端设备选择和结果回注。

## 本机数据

配置默认保存在：

```text
%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json
```

其中包含设备密码和本机 Agent 凭据。文件不会进入 GitHub 发布包。运行日志位于同目录的 `logs/`。

默认端口：

- WebGUI / 控制连接：`8797`
- 局域网发现：`8798-8818`

## 发布包校验

```powershell
Get-FileHash .\RabiRoute-Remote-Agent-0.4.0-windows-x64-setup.exe -Algorithm SHA256
```

与 Release 中的 `SHA256SUMS.txt` 对比。
