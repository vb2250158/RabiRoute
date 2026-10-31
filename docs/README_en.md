<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a> | <a href="./README_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Documentation

Start with the user guide for everyday operation, use the API reference for integrations, and find architecture, builds, and migration records in the maintainer section. Experimental and historical material keeps its own status.

## Start here

- [RibiWebGUI user guide](user-guide/README_en.md): find setup, operation, and troubleshooting instructions by task.
- [Getting started](getting-started_en.md): install the application, start it, and open the console.
- [Complete the first Route](user-guide/first-route_en.md): perform a real delivery and confirm that the target task receives it.
- [Interface and status](user-guide/interface-and-status_en.md): understand connections, runtime status, and unsaved changes.
- [Operations, logs, and troubleshooting](user-guide/operations-and-troubleshooting_en.md): locate the break when a message does not arrive.
- [Safety, replies, and data](user-guide/safety-and-data_en.md): understand reply permissions and diagnostic-data privacy.
- [Current capabilities and maturity](current-capabilities_en.md): check verified, experimental, and pending scope.

## Find a task

| What you want to do | Start here |
| --- | --- |
| Connect QQ, Weixin, WeCom, or Feishu | [Communication and message inputs](user-guide/routes-and-adapters_en.md) |
| Inspect home devices, state, and actions | [Smart devices](user-guide/home-devices_en.md) |
| Start an Agent voice call from a phone | [Mobile calls](mobile-voice-call_en.md) |
| Save and export phone location tracks | [Phone location recording](mobile-location-recording_en.md) |
| Review computer and phone events by date | [Role all-day recording](persona-all-day-recording_en.md) (new implementation; check capture sources and coverage gaps) |
| Enable watch, play, or work companionship | [Desktop-pet companion mode](companion-mode_en.md) (experimental) |
| Use terminals, files, and screens on other PCs | [Controller and remote computer clients](remote-computer-client_en.md) |
| Change light, dark, and desktop themes | [Interface theme](user-guide/interface-theme_en.md) |

## Local installation, configuration, and recovery

- [PC onboarding prompt](rabilink-pc-pairing_en.md) — Copy the complete prompt so the target Agent uses a one-time code to install, configure and verify a connection; available after server deployment, with access and persistence verified separately in each cloud environment.

- [DSH session modes](dsh-session-modes_en.md) — Choose a session mode and handle conversations that cannot switch modes.
- [DSH Web session bridge authentication](dsh-browser-auth_en.md) — **Round-trip delivery accepted**. Connect through the current owner's launch authentication without disabling security or replaying writes.
- [Configuration](configuration_en.md) — **Current guide**. Configure message inputs, handlers, local directories, and optional plugin permissions.
- [Resident performance recording and inspection](performance-monitoring_en.md) — **Current guide** for optional continuous Manager, Gateway, and WebGUI metrics, trends, slow operations, and independent JSONL files.
- [Troubleshooting](troubleshooting_en.md) — NapCat, encoding, Codex Desktop task ownership, models, and approval boundaries.
- [Windows launcher and packaging](windows-launcher-and-packaging_en.md) — Windows installation, startup, and packaging.
- [Linux Host](linux-host_en.md) — **New implementation**. Build and open WebGUI on Linux, discover the current address, stop safely, and understand RabiLink setup and pending acceptance.
- [PC identities and instance ID reset](user-guide/instance-identity_en.md) — Repair a copied identity so separate PCs appear independently as role sources.
- [Unattended NapCat](napcat-unattended_en.md) — QQ login state, quick login, Manager recovery, and supervision boundaries.

## Developer: routing, roles, and Agent interfaces

- [API reference and discovery](api-reference_en.md): browse running operations in the documentation page, search contracts, inspect parameters and responses, copy request templates, and download OpenAPI.
- [Connections and API access](connection-access_en.md): reuse connection authentication and understand explicit disabled features and API conditions.
- [Workspace plan query](workspace-plan-query_en.md): paginated search scoped to host sessions and workspace.

- [Home device and speaker Agent API](home-device-agent-api_en.md) — Query every imported entity, discover and invoke its buttons/settings/device actions, bind speech and query durable receipts.
- [Vacuum cloud map connection](vacuum-cloud-map_en.md) — QR login, raw files and version-2 decoding; live localization and navigation require separate acceptance.

- [Delivery templates and ownership](message-delivery-templates_en.md): renderer ownership, scenario differences and historical receipt retirement for developers.
- [Plan and memory summary search](knowledge-search_en.md)
- [Automation Agent delivery](automation-agent-delivery_en.md) — Recipient references, session selection, migration and retries.
- [Routing configuration](routing-configuration_en.md) — **Current guide** for `personaConfig.json`, route kinds, regex, pipelines, and template variables.
- [Routing and roles](routing-and-personas_en.md) — **Current guide** for route/role boundaries and role decision templates.
- [Use a remote role from a local Route](remote-persona-reference_en.md) — **Experimental in 0.3.19**. Select a source PC and role in the same RabiLink application, use an automatic handshake for read-only access, and retain local message inputs and the handling Agent. Real two-PC delivery remains pending acceptance.
- [Agent context injection](agent-context-injection_en.md) — **Current guide** for the persona-scoped bidirectional ledger, per-endpoint/conversation recent-message budgets, archival boundaries, persona-directory and cross-persona credentials, paths, and reply context inside `AgentPacket`.
- [Desktop-pet motion API](desktop-pet-agent-motion_en.md) — Move the pet and read arrival, interruption and uncertain receipts.
- [Desktop pet bubbles and speech](desktop-pet-bubbles_en.md) — Show spoken role text and customize the paw skin, font, colors and lifetime.
- [Rabi Agent interfaces](rabi-agent-interfaces_en.md) — **Current contract** for handler replies, role discovery, idempotent one-way cross-persona delivery, receipts, thread bridge, plans, memory, Remote Agent, and role skills.
- [Plans and memory](plan-and-memory-model_en.md) — **Current guide** for Role Knowledge sources, recall, explicit consolidation, and side effects.
- [Unified dynamic record lifecycle](dynamic-record-lifecycle_en.md) — **Current guide** for archival, memory consolidation, physical sharding, retention, and the 24/72-hour dynamic windows.
- [Pipeline presets](pipeline-presets_en.md) — Agent-session defaults, explicit external targets, and Outbox statuses; FenneNote output is archival compatibility only.
- [Agent Adapter Integration Lessons](agent-adapter-integration-lessons_en.md) — **Current guide** for duplicate sessions, missing tools, inverted ownership, desktop startup dependencies, and verification.
- [Standard Agent Adapter Requirements](agent-adapter-standard-requirements_en.md) — **Current guide** for discovery, authentication, tasks, idempotent creation, delivery, results, tools, lifecycle, UI, security, and acceptance.
- [Grok Bot Agent adapter](grok-bot-agent-adapter_en.md) — **Experimental**. Deliver to exact Bot sessions on the existing cloud owner and verify source identity, idempotency and QQ/Codex replies.
- [Device Agent adapter contract](device-agent-adapter_en.md) — **Experimental**. Configure glasses as a Route handler, execute on the glasses model, and verify the PC queue, original deliveries, and response receipts.
- [Delegating a glasses connection to the phone](device-peer-connection_en.md) — **Experimental**. Verify device credentials, independent keys, and a short connection lease so forwarded requests retain the glasses identity.
- [Exact Agent delivery and formal replies](agent-endpoint-delivery_en.md) — **Experimental**. Verify source and target owners, original delivery receipts, and required replies; handle timeouts and revoked identities.
- [Codex Desktop Agent Integration and Acceptance Contract](codex-desktop-agent-acceptance_en.md) — **Current fact** for stable IDs, side-effect-free scanning, automatic initialization, the Desktop owner boundary, and metadata bootstrap gates.
- [Rabi Codex Context plugin](rabi-codex-context-plugin_en.md) — **Unified Manager version** where hooks only forward real Codex session events and inject Rabi PC-owned role, plan, memory, and skill context.
- [Role data synchronization retirement](persona-data-sync_en.md) — **Retired**. Automatic/manual synchronization and synchronization APIs are no longer provided. Use existing RabiLink remote role, Agent, and data access without replication; historical data is retained.


## Maintainer: architecture, builds, and diagnostics

- [Camera events and HA recovery](home-camera-events_en.md): explicit persona binding, clip storage, elevated startup, bounded recovery and migration acceptance.

- [Development candidate verification](developer-candidate-admission_en.md): frozen inputs, reusable candidate evidence and admission at existing publication owners.

- [Development validation paths and timing](development-validation_en.md): candidate paths, isolated pilot results, and installed acceptance boundaries.

- [Reliable Agent delivery](reliable-agent-delivery_en.md): durable acceptance, reconnect recovery, original receipts, and delivery-record queries.

- [Persona message configuration upgrades](persona-message-config-upgrade_en.md) — Preview older rules, migrate offline with backups, and restore from snapshots.

- [RabiLink mobile-state contracts](rabilink-mobile-owner-api_en.md) — Maintainer reference for ASR priorities, battery reports, proofs and native idempotent replay.
- [Route control contracts](route-control-api-contract_en.md) — Developer reference for identity, configuration, binding, message processing and native CAS receipts.
- [Device-Agent execution contracts](device-agent-api-contracts_en.md) — Developer reference for device sessions, wake, claims, original delivery and durable receipts.
- [Gateway control contracts](gateway-control-api-contract_en.md) — Maintainer reference for persisted configuration, runtime activation and native CAS transactions.
- [Agent-thread contracts](agent-thread-api-contracts_en.md) — Developer reference for original host actions, provenance and idempotency ledgers.
- [Message-processing contracts](message-processing-api-contract_en.md) — Maintainer reference for the original Board, send-context review, fact fencing and receipts.

- [Bilibili browser-history bridge](bilibili-history-bridge_en.md) — Maintainer setup for the fixed extension, persona-private date shards, and executable API contracts.

- [Target architecture for API contract discovery and remote calls](api-contract-discovery-target-architecture_en.md) — **In progress; runtime acceptance incomplete**. Registration and refresh foundations exist; track full public-entry migration, retirement, and two-computer acceptance.
- [API migration implementation record](api-contract-discovery-implementation-progress_en.md) — Maintainers compare source wiring, compiled profiles and remaining lifecycle acceptance.
- Persona API contracts: [resources](persona-resource-api-contracts_en.md), [history](persona-history-api-contracts_en.md), [plan controls](persona-plan-api-contracts_en.md), [Skills](persona-skill-api-contracts_en.md), [knowledge](persona-knowledge-api-contracts_en.md), [identity](persona-identity-api-contracts_en.md), [health](persona-health-api-contracts_en.md).
- [Role configuration and lifecycle](role-configuration-api-contracts_en.md), [core public services](core-public-api-operations_en.md) and [plugin catalog contracts](plugin-catalog-api-contract_en.md) — Native revisions, receipts, readiness and publication boundaries.
- [Plugin publication lifecycle](plugin-publication-lifecycle_en.md) — Candidate pointer changes, rollback, prior-owner retirement and execution-mode limits.
- [WebGUI static resource contracts](webgui-static-api-contracts_en.md) — Native files, immutable revisions, final fallback and descriptor cleanup; shared integration status is stated in the document.
- [Independent listener contracts](external-listener-contracts_en.md) and [platform-native listeners](platform-native-listeners_en.md) — Native addresses, original authentication, trusted lifecycle publication and separately verified remote reachability.
- [Peer LAN listener discovery](peer-lan-listener-discovery_en.md) — Check the actual bound address, original encrypted protocols, metadata handoff and withdrawal at stop.
- [Webhook HTTP contract](webhook-http-contract_en.md) — Check native methods, paths, input and shutdown behavior for Webhook and RabiLink listeners.
- [Long-term maintenance and self-repair](rabi-maintenance_en.md) — **Maintenance workflow** for a stable intake task, original issue ownership, recovery verification, and periodic code-quality work.
- [Install Rabi knowledge search](../skills/rabi-knowledge-search/README_en.md) — Project maintainers can install the skill to search plans and memories first when online, and use ordinary search when offline.
- [Install the identity relation skill](../skills/manage-rabiroute-identity-relations/README_en.md) — Resolve who an endpoint account is, confirm or correct ownership, handle concurrent conflicts and shared accounts, and keep on-scene Agents to candidate observations.
- [Installed Web hot patches](web-hot-patches_en.md) — Build, activate, pin, and roll back compatible Web bundles.
- [Architecture](architecture_en.md) — **Current fact**. Product boundaries, the Codex Desktop owner, current Outbox, and future Action Queue are separated.
- [Plugin architecture lessons from DSH](dsh-plugin-architecture-lessons_en.md) — **Research and implementation summary**. Covers the completed migration of built-in Manager plugins, WebGUI/Desktop minimal extension hosts, contribution points, process-isolation boundaries, and the future third-party presentation Extension Host.
- [How DSH uses Cordis](dsh-cordis-runtime-analysis_en.md) — **Implementation research**. Explains profiles, Loader, Fibers, service realms, the browser plugin tree, dynamic code, and process-sandbox boundaries.
- [RabiRoute plugin platform target architecture](manager-plugin-implementation-hot-swap_en.md) — **Current architecture**. Defines a minimal Plugin Kernel, independent capability packages, one SDK, multi-host extension, atomic generation switching, out-of-tree plugin acceptance, and one complete removal of the old runtime.
- [Plugin Bundles and hot replacement](plugin-bundles_en.md) — **Current implementation guide**. one Profile, independent packages, the shared SDK, generation hot replacement, and browser revision rollback.
- [Source hot patches](source-hot-patches_en.md) — **In development**. Source mode watches code and declared resources, compiles and validates changes, preserves state, and switches without stopping the service; the document states the installed-runtime acceptance boundary.
- [Code architecture](code-architecture_en.md) — **Current fact**. Backend, Manager, endpoint, Role Knowledge, WebGUI, and desktop module map.
- [Message-search indexing and latency budgets](message-history-search_en.md) — Developer maintenance: index updates, frozen snapshots, the default three-second client deadline, recovery and capacity acceptance scope.
- [Project function map](project-function-map_en.md) — **Current fact**. Locate behavior by maturity, side effect, API, and code owner.
- [Path and directory conventions](path-and-directory-conventions_en.md) — **Current maintainer guide**. Separates software, public samples, local runtime data, and logs, and defines relative-path and business-ID interfaces.
- [Project skill distribution and drift detection](project-skill-distribution_en.md) — **Current maintainer guide** for localized copies of RabiRoute-owned skills under a project's `.agents/skills/`, their recorded baseline, and the read-only command an Agent runs to report upstream drift before porting.
- [Pull request security gates](maintainer-security-gates_en.md) — **Current maintainer guide** for secret scanning, production dependency auditing, CodeQL, least privilege, and merge protection.
- [Manager runtime resilience and incident evidence](manager-runtime-resilience_en.md) — **Current guide** for crash logs, single-instance protection, non-fatal persona-index persistence, watchdog backoff, and soak acceptance.

## Experimental integrations

- [Remote Agent setup and updates](lan-rabi-agent-bootstrap_en.md) — **Experimental integration**. Open RabiLink → Remote Agent (远端智能体 in Chinese) to copy a setup prompt, connect another computer, manage its Agents, and select them as route handlers.
- [Mobile recording interface](rabilink-mobile-recording-ui_en.md) — Four-page navigation, capture modes, offline storage, session replay and compatibility boundaries.
- [Offline glasses recording and live preview](rabilink-offline-recording_en.md): record glasses streams on the phone and watch locally; device acceptance is in progress.
- [Rokid development sources and troubleshooting](rokid-development_en.md) — SDK route, official-source reading status, installation evidence and development skill; CXR-M is excluded.
- [Local YeYu Gamer Manager integration](yeyu-gamer-manager-integration_en.md) — **Experimental integration**. Fixed local port 8877, typed health/meta/snapshot/capability reads, and plan-only Agent work-item creation through a dedicated `rabiroute.token`; disabled by default pending live installation acceptance.
- [Installation-file recovery and offline dialogue extraction](yeyu-install-file-recovery_en.md) — Maintainer compatibility entry point, script arguments, and candidate-data limitations; no installation operations.
- [WeCom integration](wecom-integration_en.md)
- [Feishu endpoint integration](feishu-integration_en.md) — enterprise-app event callbacks, signature/encryption checks, durable deduplication, and source-chat text replies.
- [Video generation plugin](video-generation-plugin_en.md) — Choose models on this or a connected computer, submit generation jobs, and save, preview or download work in the current workspace.
- [Voice interaction workstation](voice-interaction-workstation_en.md) — historical wiring; FenneNote/OumuQ are retired in favor of RabiPC + RabiSpeech.
- [RabiSpeech local TTS / ASR service](rabispeech-plugin_en.md) — direct APIs, hot/persona-keyword delivery, role voice and language, bidirectional ASR/TTS records, opaque voiceprint/cluster evidence, RabiPC, and RabiLink relay. The selected-text menu's reading sub-feature can enqueue host TTS.
- [Call TTS and ASR remotely](user-guide/speech-api_en.md) — application token, target PC, copyable commands, acceptance, and error recovery.
- [Rabi Voice Client](../desktop/rabi-voice-client/README_en.md) — use a meeting-room Windows PC as a LAN microphone and speaker while segmentation and models stay on the RabiSpeech host.
- [Local speech model downloads](local-speech-model-downloads_en.md) — use Model Management for on-demand weights and review each TTS/ASR model's source, isolated runtime, and validation requirements.
- [RabiSpeech performance report](rabispeech-performance-report_en.md) — six TTS and five main ASR models, cold/warm timing, quality indicators, hardware, and CUDA issues.
- [Speech servers and generic tunnels](rabilink-peer-tunnel_en.md) — Select a remote speech server and inspect presence, actual transport and round-trip latency.
- [Device discovery and connection signalling](rabilink-peer-rpc_en.md) — Find PCs in the same application and understand connection handshakes; use [generic tunnels](rabilink-peer-tunnel_en.md) for all API reads, writes and streaming requests.
- [RabiLink Relay](rabilink-relay-server_en.md)
- [RabiLink Cloudflare Worker](rabilink-relay-cloudflare-worker_en.md)
- [RabiLink glasses three-route comparison](rabilink-glasses-route-comparison_en.md) — host, lifecycle, device capability, release cost, and current guidance for native Lingzhu agent, AIUI, and native app routes.
- [Rabi mobile message endpoint](mobile-message-endpoint_en.md) — **Experimental integration** for standalone phone chat, optional glasses, reliable queues, notifications, attachments, configuration assistance, and device acceptance boundaries.
- [Mobile voice calls](mobile-voice-call_en.md) — **Experimental implementation**. Start voice conversations from chat and understand mute, hangup, recording restoration, and late replies.
- [RabiLink phone edge hub](rabilink-phone-edge-hub_en.md)
- [Phone-to-PC direct video](rabilink-direct-video_en.md) — experimental signalling and direct transport; camera capture and cross-network acceptance remain pending.
- [Mobile recording ownership](mobile-recording-event-boundary_en.md) — Developer reference for device configuration, recording events, and legacy retirement.
- [RabiLink wearable health endpoint](rabilink-wearable-health_en.md) — **Experimental integration** for phone settings, structured health history, Agent queries, alert thresholds, and the Xiaomi ADB fallback.
- [AIUI-to-phone/native-glasses parity checklist](rabilink-aiui-native-parity_en.md) — migration status separated by code, automation, and real-device evidence.
- [AIUI phone/device profile HTTP](aiui-agent-profile-http_en.md) — **Experimental** phone settings, device ownership, revision conflicts and application receipts; end-to-end acceptance pending.
- [AIUI profile lifecycle](../apps/rabilink-aiui/docs/agent-profile-runtime_en.md) — Cache, deferred application after the current turn, and model status.
- [AIUI tool contract review](../apps/rabilink-aiui/docs/agent-tool-contract_en.md) — Model and tool events, continuation contracts, and acceptance boundaries.
- [Independent RabiPC knowledge MCP](../apps/rabi-mcp/README_en.md) — HTTP/stdio tools for independent MCP clients; RabiLink uses built-in Manager calls without deploying this service.
- [Local knowledge bridge settings](user-guide/knowledge-bridge-settings_en.md) — Use PC knowledge tools after connecting, and distinguish service readiness from business results.
- [Phone knowledge permissions](knowledge-grant-phone-ui_en.md) — Migrate away from the retired knowledge-grant editor.
- [PC knowledge bridge configuration](rabilink-knowledge-runtime_en.md) — Existing Manager knowledge APIs, application authentication and readiness checks.
- [Knowledge write receipt lookup](rabilink-knowledge-operation-receipts_en.md) — Query persisted receipts with the original operation key and actual device credentials; unknown outcomes are never replayed.
- [New AIUI Agent acceptance](aiui-agent-acceptance_en.md) — Maintenance: verify builds, runtime, hardware wake, and voice interaction against the new contract; track pending criteria.
- [AIUI generic API transport](../apps/rabilink-aiui/docs/generic-api-transport_en.md) — Public APIs, target computers, role ownership and verified transport scope.
- [RabiLink AIUI residency boundaries](rabilink-aiui-residency-plan_en.md)
- [RabiLink proactive-intelligence requirements](rabilink-active-intelligence-requirements_en.md) — target contract and implementation tracker for user state, scenario recognition, plan/memory closure after group-message recall, and intervention decisions.
- [RabiLink native app design](rabilink-glasses-app-design_en.md)
- [XiaoAI integration route](xiaoai-integration/xiaoai-rabiroute-intercept-route_en.md)
- [IR gateway research](xiaoai-integration/ir-remote-gateway-research_en.md)
- [Xiaomi Band heart-rate probe handoff](xiaomi-band-heart-rate-probe-handoff_en.md)

## Designs and history

- [Role-centric configuration architecture](role-centric-architecture_en.md) — Independent role selection and configuration, Plans and memory, Route bindings, archive/restore and guarded permanent deletion. Source collection and isolated validation; no installation in this change.

- [RabiLink unified all-day recording design](rabilink-all-day-recording_en.md) — **Design / implementation in progress, not accepted end to end**. One coordination owner for phone, glasses and watches; independent mode/pause, notifications, durable recording/transcription, privacy boundaries, lossless migration and acceptance contracts.
- [Proactive-intelligence system design overview](../主动智能设计思路_en.md) — **Planned**. Covers user modeling, scenarios, proactive action, memory, and device responsibilities. See Current Capabilities for implementation status.
- [Conversational message collection, message groups, and four-Agent collaboration](group-message-batching-and-triage-plan_en.md) — **Experimental**. Natural-language traffic may be recorded immediately, settled into batches, and sent to dynamic Codex Message Agents by a combined ranking of the quoted message's Agent session, prior message group, conversation, speaker, and endpoint familiarity. Live group/DM and complete four-Agent acceptance remain pending.
- [Role route workbench plan](persona-route-workbench-plan_en.md) — **Partially implemented**. Speech-keyword and per-endpoint context controls are live; side-effect-free RouteDecision/AgentPacket preview is not implemented.
- [WorkBuddy as an Agent endpoint](workbuddy-agent-adapter-plan_en.md) — **Implemented, with one manual credential step**. Wiring WorkBuddy tasks in as a handler: the session process descriptor, task source of truth, local gateway API, delivery body shape and same-id redelivery are all verified by measurement; the gateway credential is recorded once in a local ignored file, and maturity stays `experimental`.
- [Windows tray task-window plan](rabiroute-windows-tray-task-window-plan_en.md) — design record; use `desktop/tray-task-window/` and the packaging guide for the actual implementation.
- [UE/UX audit and refactor](rabiroute-ue-ux-audit-and-refactor_en.md) — phase audit.
- [Historical mobile-app Webhook plan](mobile-app-webhook-integration_en.md) — **Historical**. The current RabiLink path no longer requires a phone bridge as the main relay.

Archived material is under [`archive/`](../archive/README_en.md). Buildable clients live under [`apps/`](../apps/README_en.md), reusable SDKs under [`packages/`](../packages/README_en.md), and copyable samples under [`examples/`](../examples/README_en.md).

## Status definitions

| Status | Meaning |
| --- | --- |
| Current fact | Checked against code, schemas, WebGUI, and tests; safe as the current version's public position. |
| Current guide | Covers implemented behavior but still needs continuous review as code evolves. |
| Experimental integration | A code entry exists, while the external system or hardware path still requires environment-specific acceptance. |
| Needs refresh | Contains useful material but is known to include stale or conflicting statements. Prefer Current Capabilities. |
| Planned | A proposal, requirement, or roadmap rather than an implemented loop. |
| Historical | A superseded path, research record, or handoff rather than the current primary path. |


## Documentation maintenance

1. Check code, schemas, APIs, WebGUI, and tests before updating the Chinese fact source.
2. Maintain the English version manually only after behavior is accurate; do not batch-translate stale documents.
3. Design documents must be labeled Planned or Historical instead of appearing in the current-capability list.
4. Runtime-semantic Markdown (`AGENTS.md`, `SKILL.md`, roles, prompts, memories, and plans) must not be translated mechanically.
