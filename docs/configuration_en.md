<!-- docs-language-switch -->
<div align="center">
English | <a href="./configuration.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Configuration and Integrations

> Status: current reference. Fields and maturity are based on the active configuration model, Manager APIs, and scan results. See [Current Capabilities](current-capabilities_en.md) for acceptance status.

## Codex terminology

RabiRoute keeps provider, agent/runtime, transport, host, and model separate:

| Concept | Current meaning |
| --- | --- |
| Provider | OpenAI account, service, and model capabilities. |
| Agent/runtime | Desktop-managed Codex tasks, turns, tools, and execution. Stable adapter ID: `codex`. |
| Transport | Codex Desktop IPC. |
| Host/owner | Codex/ChatGPT Desktop, which owns the visible task and actual turn. |
| Model | The model selected by the target Desktop task. |

Do not rename the adapter to `chatgpt`. Desktop IPC is the formal transport. App-server is limited to short-lived empty-task metadata bootstrap and must not execute routed prompts.

## Runtime files

```text
data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
```

`adapterConfig.json` owns endpoints, ports, handler selection, cwd, pipeline, and role binding. `personaConfig.json` owns notification rules. A role can be reused by several routes.

On a clean start, the Manager copies the public `examples/data` package when available. Only the main example is enabled. Missing examples are not a runtime failure; the Manager can create a minimal NapCat-to-Codex setup.

## Representative route

```json
{
  "enabled": true,
  "messageAdapters": ["napcat", "heartbeat"],
  "messageAdapterPolicies": {
    "napcat": {
      "inputEnabled": true,
      "outputEnabled": true,
      "supportedOutputs": ["text", "image", "voice", "file"],
      "allowedFileRoots": ["C:/Path/To/Your/Project/ReleasePkg"]
    }
  },
  "gatewayPort": 8789,
  "napcatHttpUrl": "http://127.0.0.1:3000",
  "codexThreadName": "QQ message listener",
  "codexCwd": "C:/Path/To/Your/Project",
  "agentModel": "",
  "agentAdapters": ["codex"],
  "heartbeatSkipWhenAgentBusy": true,
  "dataDir": "./data/route/main",
  "rolesDir": "./data/roles",
  "configName": "main",
  "agentRoleId": "Rabi",
  "agentRoleFile": "persona.md"
}
```

## Core fields

- `messageAdapters`: enabled input types. Current IDs include `napcat`, `remoteAgent`, `heartbeat`, `rolePanel`, `webhook`, `fennenote`, `xiaoai`, `rabilink`, and `wecom`. `remoteAgent` and `rolePanel` are Manager-level endpoints rather than gateway listeners.
- `messageAdapterPolicies`: `inputEnabled`, `outputEnabled`, `supportedOutputs`, and adapter-specific restrictions. Legacy allow-group/user and output-mode fields are no longer active fine-grained filters.
- `supportedOutputs`: outbound payload kinds. NapCat supports `text`, `image`, `voice`, and `file` in the current policy model.
- `allowedFileRoots`: real-path allowlist for local file output. A local QQ group-file upload is blocked when this is empty or the resolved file leaves the allowlist.
- `gatewayPort`: NapCat WebSocket Client target port.
- `napcatHttpUrl`: OneBot HTTP endpoint.
- `webhookPort` / `webhookPath`: generic webhook endpoint; the port falls back to `gatewayPort`, and the default path is `/webhook`.
- `agentAdapters`: handler IDs. Codex is verified; Copilot CLI and AstrBot are experimental; Marvis is a manual handoff.
- `codexThreadId` / `codexThreadName` / `codexCwd`: stable task binding by opaque ID plus workspace, with a visible saved name. Desktop renames, stale index titles, and completed goals do not create duplicates. Typing a new name explicitly clears the old ID before name lookup. One or more exact same-name/workspace matches bind the unique latest `updatedAt`; only zero matches may create, and a tied or unusable maximum requires selection.
- `copilotThreadName` / `copilotCwd`: independent Copilot CLI session configuration.
- `agentModel`: leave empty to use the Runtime's `model/list` default. Only set it when an explicit model lock is required.
- `heartbeatSkipWhenAgentBusy`: skip a heartbeat while the fixed Codex thread is still active. Other message kinds are unaffected.
- `dataDir`, `rolesDir`, `configName`, `agentRoleId`, `agentRoleFile`: storage and role binding.

Windows paths may use either slash style in WebUI. Only hand-written JSON requires escaped backslashes.

## Message adapters

| Adapter | Maturity | Notes |
| --- | --- | --- |
| `napcat` | verified | Inbound OneBot WebSocket and outbound OneBot HTTP. |
| `heartbeat` | verified | Internal scheduled events. |
| `rolePanel` | verified | Manager/Qt local role conversation endpoint; not a network listener. |
| `remoteAgent` | experimental | Manager discovers and connects remote bridges for tasks/events/files. |
| `webhook` | experimental | Generic POST source for systems without a dedicated adapter. |
| `fennenote` | experimental | Voice-transcript input and optional output bridge. |
| `xiaoai` | experimental/design-dependent | Dedicated integration route; verify the actual bridge environment. |
| `rabilink` | experimental | Relay/worker/device observation and downlink path. |
| `wecom` | experimental | WeCom smart-bot WebSocket and Outbox group sends. |

Named platforms should use their dedicated adapter rather than being folded into the generic webhook.

NapCat credentials and Tencent security verification never belong in RabiRoute configuration. The explicit **Open NapCat** action can start a bound instance, use an existing quick-login account, and repair OneBot endpoints; human verification remains in NapCat WebUI.

## Handler adapters

- `codex`: reads Desktop task state, binds by full task ID and workspace, and asks the Desktop owner to start or steer the real turn through Desktop IPC.
- `copilotCli`: calls a local Copilot CLI with a dedicated session name/cwd and records output. It does not inject into an existing VS Code Copilot panel thread.
- `astrbot`: supports Dashboard login checks, project/session scans, plugin deployment, and ChatUI delivery; continuous real-session acceptance remains pending.
- `marvis`: writes prompt files, copies text, and opens/focuses the desktop application. It cannot reliably inject into a background session.

## Desktop-owner requirement

Codex/ChatGPT Desktop must be running for real delivery. RabiRoute may open `codex://threads/<id>` to load a task and retry briefly, but it does not start a fallback execution Runtime. Model, tools, sandbox, and approvals remain owned by the target task.

## RabiLink global configuration

The PC identity and Relay connection live in `data/Config.json`, including `rabiGuid` and `rabiLinkRelay` (`enabled`, `url`, `token`, `deviceId`, and timing options). The Manager registers the PC and proxies remote RibiWebGUI independently of one route process. A route still needs the `rabilink` message adapter to consume device observations.

Legacy per-route Relay fields remain readable for compatibility; new configuration belongs in the global file. Public examples never include a Relay URL/token.

Record-first sources such as FenneNote can be selected through `routeVariables.rabilinkRecordFirstSources`. Configure one owning route only; do not let another direct-delivery route consume the same webhook and create duplicate Agent turns.

## WeCom

`wecomBotId`, `wecomBotSecret`, and optional `wecomWsUrl` configure the smart-bot WebSocket. Prefer `WECOM_BOT_ID`, `WECOM_BOT_SECRET`, and `WECOM_WS_URL` for real credentials. See [WeCom Integration](wecom-integration_en.md).

## Multiple routes and shared roles

Each folder under `data/route` is independently startable and may have its own endpoints and handler workspace. Several routes may bind the same `agentRoleId`; role rules use `configName` to distinguish them.

When adding a new platform, create a module under `src/adapters/` and normalize it into the common event/forwarding path. Do not put unrelated protocol logic into the NapCat adapter.

## RibiWebGUI and plugins

RibiWebGUI edits runtime configuration through Manager APIs. Plugin and external integration pages should show actual scan maturity and requirements rather than treating the presence of configuration fields as proof of a verified end-to-end integration.
