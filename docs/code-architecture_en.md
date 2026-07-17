<!-- docs-language-switch -->
<div align="center">
English | <a href="./code-architecture.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Code Architecture

> Status: current code map. Module paths, Codex transport, and adapter maturity are aligned with the repository.

## High-level flow

```text
src/index.ts
  -> message adapters
  -> history records
  -> src/forwarding.ts
     -> routing/routeDecision.ts
     -> routing/agentPacket.ts
     -> agentAdapters/* / Codex Runtime

src/manager.ts
  -> manager/controlPlaneRoutes.ts
  -> config repository and migration
  -> runtime registry/status
  -> message endpoint managers/scans
  -> Codex Desktop IPC bridge
  -> RibiWebGUI static/API service
```

## Backend entries

### `src/index.ts`

One gateway subprocess. It loads normalized route configuration, starts gateway-level message adapters, records events, and invokes forwarding. Manager-level endpoints such as role panel and Remote Agent do not start duplicate listeners here.

### `src/config.ts`

Runtime configuration types and environment/default resolution used by the gateway. Shared validation and port ownership belong in `src/shared/gatewayConfigModel.ts` rather than being duplicated in adapters.

## Message path

### `src/adapters/`

Protocol translation for live gateway inputs:

- NapCat/OneBot.
- WeCom smart-bot WebSocket.
- Webhook-like inputs such as FenneNote and XiaoAI.
- RabiLink compatibility/input paths.
- heartbeat/manual and other internal adapters.

An adapter should parse, normalize, record, report health, and call forwarding. It should not build handler prompts or send an immediate external reply from an inbound callback.

### `src/history.ts`

Append-only JSONL helpers and record types for messages, packets, Outbox results, adapter logs, and other runtime evidence.

### `src/forwarding.ts`

The orchestration center for a matched event:

1. Build a `RouteDecision` for the current route profile.
2. Build an `AgentPacket` for each matched rule.
3. Record the packet.
4. Deliver through the selected handler adapter/runtime.
5. Report status and errors.

Keep handler transport and session policy behind the adapter/runtime boundary.

## Routing module

### `src/routing/routeDecision.ts`

Pure routing semantics: route kind, route text, regex, target filters, and matched rules. A decision should not read role memory, send messages, or start a handler.

### `src/routing/agentPacket.ts`

Combines a decision with role context. It creates workspace-relative template values and the generated wrapper containing recent messages, role knowledge, logs, reply API/context, and endpoint-specific delivery instructions.

Packet construction invokes `roleKnowledgeSnapshot`, so matched memory can refresh `viewedAt`. A memory-consolidation run is evaluated only for the explicit `triggerId=memory-consolidation` path.

### `src/routing/types.ts`

Common route-event and decision types shared by forwarding and tests.

## Handler adapters and Codex

### `src/agentAdapters/`

- `agentAdapter.ts`: registry/dispatch boundary.
- `astrbotAdapter.ts`: experimental AstrBot delivery.
- `managerApi.ts`: scan, login, deployment, and adapter-control read models.
- `stateReporter.ts` and ordering helpers: runtime status reporting.

Copilot CLI and Marvis use their dedicated modules outside this folder where appropriate.

### Codex internal boundary

- `src/codexRuntime.ts`: stable task identity, Desktop-owner delivery policy, and high-level create/read/send behavior.
- `src/codexDesktopBridge.ts`: read-only Desktop task discovery plus Desktop IPC start/steer delivery.
- `src/codexAppServerClient.ts`: short-lived metadata driver for creating and naming an empty task; it must not execute real prompts.
- `src/agentThreads.ts`: controlled local thread bridge.

Desktop IPC is the only real-message transport. The target Desktop task owns model, tools, sandbox, approvals, and turn execution. A valid saved task ID is authoritative within its workspace; a stale index title or completed goal must not create a duplicate. Do not introduce shared-port, per-route stdio, CLI, or app-server execution fallbacks.

## Outbox / Action Gate

`src/outbox.ts` receives handler replies and resolves:

- route/source context;
- explicit target;
- pipeline and reply-to-source behavior;
- adapter output policy and payload support;
- endpoint credentials/configuration;
- platform sender implementation.

It supports current NapCat, WeCom, FenneNote, RabiLink, and role-panel return paths and records `sent`, `draft`, `blocked`, or `failed`.

There is no persistent generic Action Queue. Future approval/retry work should be layered on top of this audited result model.

## Manager control plane

### `src/manager.ts`

Starts the loopback Manager, loads route/role configuration, serves WebGUI/API, and coordinates route subprocesses and shared services.

### `src/manager/controlPlaneRoutes.ts`

The current broad HTTP control-plane router. It handles gateway operations, scans, Agent replies/threads, role knowledge, shutdown, and endpoint-specific actions. Continue extracting stable domain helpers instead of growing unrelated inline logic indefinitely.

### `src/manager/configRepository.ts`

Reads/writes route and role configuration, preserving the split between `adapterConfig.json` and `personaConfig.json`.

### `src/manager/configMigration.ts`

Compatibility normalization at the configuration boundary. Runtime and frontend code should consume canonical fields after migration.

### `src/shared/gatewayConfigModel.ts`

Shared configuration types, normalization, validation, defaults, NapCat instance resolution, port claims/conflicts, and cross-route constraints.

### `src/manager/runtimeRegistry.ts`

Owns the Manager's gateway runtime map. Avoid scattering competing `Map<string, GatewayRuntime>` sources of truth.

### `src/manager/statusPayload.ts`

Builds the Manager status read model consumed by WebGUI and diagnostics.

## Message endpoint management

`src/messageEndpoints/` supports control-plane scans and lifecycle actions:

- `napcatManager.ts`: NapCat Shell/WebUI/token/OneBot setup, launch, health, and instance operations.
- `webhookLikeScans.ts`: generic webhook, FenneNote, and XiaoAI-style HTTP callback scans.
- `wecomManager.ts`: WeCom SDK, credential, connection/authentication, and recent-message scan.
- `remoteAgentManager.ts`: discovery, challenge authentication, connections, tasks, events, and returned files.

These modules do not replace live gateway adapter code.

## Role knowledge

`src/roleKnowledge.ts` owns:

- plans and delayed archiving;
- recent and consolidated memory;
- consolidation runs/results;
- role skills;
- metadata recall and required-read selection;
- write limits/validation;
- Agent context snapshots.

`src/manager/roleKnowledgeRoute.ts` parses role-knowledge paths, while `controlPlaneRoutes.ts` currently handles the API. Role knowledge is handler context and must not affect whether `RouteDecision` matches.

## Frontend and desktop

`ribiwebgui/` is the Vue/Vuetify control surface for configuration, scans, status, logs, and documentation. It is a client of Manager APIs, not the configuration source of truth.

WebGUI localization is split by responsibility:

- `src/i18n/index.ts` owns the single locale state, browser preference, `<html lang>`, and locale-change event.
- `src/i18n/catalog.ts` contains manually reviewed English UI copy and dynamic-text rules.
- `src/i18n/domLocalizer.ts` applies registered copy to Vue/Vuetify DOM while skipping `data-no-i18n`, code, editable content, and input bodies.
- `src/components/LocaleSwitcher.vue` exposes the top-bar `中 / EN` control.
- `src/pages/ProjectDocsEnglish.vue` lazily loads and renders `docs/**/*_en.md`, so the repository Markdown remains the English documentation source of truth.

The `rabiroute:webgui:locale` local-storage value is only a browser-side UI preference, never a project save. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values must stay verbatim; dynamic user-data regions are marked with `data-no-i18n`.

`desktop/tray-task-window/` is the optional PySide6/Qt local panel. It reads plans/memory/status and provides role conversation UI; plan and memory views remain read-only. Desktop lifecycle uses the Manager shutdown endpoint.

## Plugin adapters

External/companion adapters live under `plugin-adapters/` or `scripts/` when they are independently deployable. They communicate through documented Manager/Relay protocols and must not import private runtime data into public examples.

## Tests

Tests live beside source modules as `*.test.ts`. Routing tests verify pure decision and packet behavior; Outbox tests verify policy and platform sends; Manager/endpoint tests verify control-plane contracts and security boundaries.

## Common change entry points

| Change | Start here |
| --- | --- |
| New message source | `src/adapters/`, endpoint scan/manager module, shared config model, tests, bilingual docs. |
| New handler | handler adapter/registry, scan/status API, forwarding integration, tests. |
| Route semantics | `routing/routeDecision.ts` and tests. |
| Handler context | `routing/agentPacket.ts`, role knowledge, packet tests, context docs. |
| External reply | `outbox.ts`, adapter policy/config, sender tests, interface docs. |
| Manager API | `manager/controlPlaneRoutes.ts`, extracted domain helper, frontend client, tests. |
| Plan/memory/skills | `roleKnowledge.ts`, role API parser/control plane, validation tests. |
| WebGUI form | Vue page/component plus shared config schema and bilingual user docs. |

## Red lines

- Preserve router/handler separation.
- Keep `RouteDecision` free of role-memory and external side effects.
- Keep formal Codex delivery on Desktop IPC and the target task owner.
- Route external output through Outbox.
- Treat experimental integrations as experimental until real acceptance.
- Keep public examples credential-free and runtime data out of Git.
