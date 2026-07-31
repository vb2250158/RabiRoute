<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Remote Agent

Remote Agent is a standalone, lightweight Rabi Agent message endpoint. It lets Agents on another Windows computer join the Rabi network so the primary RabiManager can discover them, connect, and assign work.

It is neither a second RabiManager nor a Codex-only runtime. The package contains only:

- Remote Agent device name, stable device ID, and connection password;
- the same Agent configuration UI as RabiManager WebGUI;
- the shared scan, authentication, project, session, and delivery logic for Codex, Copilot CLI, Marvis, and AstrBot;
- the Remote Agent v3 WebSocket/UDP protocol used by the primary RabiManager.

Routes, personas, plan management, speech services, and other message inputs remain owned by the primary RabiManager and are not exposed in the Remote Agent WebGUI.

## Ready to use

1. Install `RabiRoute-Remote-Agent-0.4.0-windows-x64-setup.exe`.
2. Remote Agent starts automatically and opens its WebGUI.
3. The first launch generates a stable device ID and a strong password. No project path is requested in a console.
4. Select a local project and session from the scan-backed dropdowns in the Agent card. If Codex Desktop exposes exactly one usable task, the Host binds it automatically.
5. In the primary RabiManager, scan from the Remote Agent message endpoint, enter the password shown in the Host WebGUI, and connect.

Subsequent launches start the Host or open the already-running WebGUI. They do not show a project setup console.

## Agent ownership

- Real Codex messages still go only to the target task owner in Codex/ChatGPT Desktop. If Desktop is unavailable, delivery fails closed; no fallback runtime is started.
- Copilot CLI, Marvis, and AstrBot use the existing RabiManager adapter implementations and maturity labels.
- Remote Agent Host only receives tasks, invokes selected adapters, and returns terminal results submitted by the Agent through the local reply API.
- The primary RabiManager keeps ownership of task origin, plan binding, remote-device selection, and result reinjection.

## Local data

Configuration is stored by default at:

```text
%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json
```

It contains the device password and local Agent credentials. It is never included in a GitHub release package. Runtime logs are stored in the adjacent `logs/` directory.

Default ports:

- WebGUI and control connection: `8797`
- LAN discovery: `8798-8818`

## Verify a release artifact

```powershell
Get-FileHash .\RabiRoute-Remote-Agent-0.4.0-windows-x64-setup.exe -Algorithm SHA256
```

Compare the result with `SHA256SUMS.txt` from the GitHub Release.
