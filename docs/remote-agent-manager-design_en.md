<!-- docs-language-switch -->
<div align="center">
English | <a href="./remote-agent-manager-design.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Lightweight Remote Agent Host Design and Acceptance Contract

> Status: implemented for v0.4. Remote Agent is an independent Agent message endpoint, not a full RabiManager with a reduced UI.

## User-observable contract

| Requirement | Single implementation |
| --- | --- |
| Double-click startup | No console window; first launch generates a device ID/password and opens WebGUI |
| No manual project prompt | Projects and sessions come from shared Agent scanning; one usable Codex task is auto-bound and multiple candidates use selectors |
| Same Agent surface as RabiManager | Host mode renders the same `RouteConfigPage` Agent section and calls the same `src/agentAdapters` scan/delivery modules |
| Only necessary settings | The page contains the Remote Agent device/password card and Agent card—no routes, personas, plans, speech, or other message inputs |
| Independent of local RabiManager | `dist/remoteAgentHost.js` owns HTTP/WebGUI, discovery, authentication, and task forwarding without importing or starting the Manager control plane |
| All current Agents | Codex, Copilot CLI, Marvis, and AstrBot reuse the existing capability model, maturity labels, project fields, and session fields |
| Callable by the primary Manager | Compatible Remote Agent v3 UDP discovery, HMAC password handshake, WebSocket tasks, and terminal events |

## Ownership

| Object | Owner | Authoritative state |
| --- | --- | --- |
| Remote device name, ID, and password | Remote Agent Host config store | `%LOCALAPPDATA%\RabiRoute\RemoteAgent\config.json` |
| Agent install, auth, project, and session capabilities | `src/agentAdapters` and each Agent owner | Shared scan/status API |
| Agent selection and session binding | Remote Agent profile | `profile` in the same config file |
| Task origin, plan binding, device selection, and result reinjection | Primary RabiManager | `RemoteAgentHub` |
| Real Codex execution | Target task owner in Codex/ChatGPT Desktop | Desktop IPC; no fallback runtime |
| Remote Agent WebGUI | Presentation layer | Transient expansion, loading, and error state only |

The Host config store accepts an Agent-field allowlist only. Route, persona, or other message-endpoint fields are discarded even if a client submits them.

## Single message path

```text
Primary RabiManager / RemoteAgentHub
  -> v3 password-authenticated WebSocket
  -> Remote Agent Host
  -> saved Agent adapters
  -> real Agent owner
  -> local /api/agent/replies
  -> taskEvent(completed|failed)
  -> primary RabiManager task/plan context
```

The Host never falls back between Agents. Selecting multiple Agents retains RabiManager's current parallel-delivery semantics; configuration errors fail explicitly.

## Process and package boundary

The release package starts only:

- a native windowless launcher;
- bundled Node.js;
- `dist/remoteAgentHost.js`;
- production dependencies required by shared Agent adapters;
- RibiWebGUI static assets.

It does not start `dist/manager.js` and does not package runtime `data/`, passwords, tokens, logs, or local project paths. The old v0.3 Codex-only bridge is archived under `archive/remote-agent-codex-bridge-v0.3.0/` and is no longer a release entrypoint.

## Minimum acceptance

- The initial page shows only device/password and Agent configuration, with no other Manager navigation or settings.
- Password save, minimum-length rejection, regeneration, and copy work.
- Agent add/remove, scan, project selection, session selection, and save use the shared UI/API.
- The Codex card still states that Desktop is required and delivery fails closed.
- v3 authentication, task receipt, delivery status, and terminal-result forwarding have automated coverage.
- Installer and portable builds show no console and no first-run project questionnaire; double-click opens WebGUI.
- Release payload passes path/secret scanning and includes SHA-256 checksums.
