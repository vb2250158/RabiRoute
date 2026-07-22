<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute Documentation

This directory contains current guides, experimental integrations, designs, research, and historical handoffs. The existence of a file does not mean its feature is complete; check its status before relying on it.

## Status definitions

| Status | Meaning |
| --- | --- |
| Current fact | Checked against code, schemas, WebGUI, and tests; safe as the current version's public position. |
| Current guide | Covers implemented behavior but still needs continuous review as code evolves. |
| Experimental integration | A code entry exists, while the external system or hardware path still requires environment-specific acceptance. |
| Needs refresh | Contains useful material but is known to include stale or conflicting statements. Prefer Current Capabilities. |
| Planned | A proposal, requirement, or roadmap rather than an implemented loop. |
| Historical | A superseded path, research record, or handoff rather than the current primary path. |

## Start here

- [RibiWebGUI User Guide](user-guide/README_en.md) — **Current guide**. Task-based product instructions for first delivery, status, adapters, handlers, persona rules, troubleshooting, and safety, with screenshot placeholders at key actions.
- [Current Capabilities and Maturity](current-capabilities_en.md) — **Current fact**. The most reliable feature entry, separating `verified`, `experimental`, `stub`, `planned`, and `historical` capabilities.
- [Getting Started](getting-started_en.md) — **Current guide**. Install, start the Manager, open RibiWebGUI, and verify the first route.
- [Configuration](configuration_en.md) — **Current guide**. Current fields, endpoint maturity, Codex Desktop IPC delivery, and handler configuration.
- [Troubleshooting](troubleshooting_en.md) — **Current guide**. NapCat, encoding, Codex Desktop ownership, task bridging, models, and approval boundaries.

## Routing, personas, and handlers

- [Routing configuration](routing-configuration_en.md) — **Current guide** for `personaConfig.json`, route kinds, regex, pipelines, and template variables.
- [Routing and personas](routing-and-personas_en.md) — **Current guide** for route/role boundaries and persona decision templates.
- [Agent context injection](agent-context-injection_en.md) — **Current guide** for the persona-scoped bidirectional ledger, per-endpoint/conversation recent-message budgets, archival boundaries, role knowledge, paths, and reply context inside `AgentPacket`.
- [Rabi Agent interfaces](rabi-agent-interfaces_en.md) — **Current guide** for replies, thread bridge, plans, memory, Remote Agent, and role skills.
- [Plans and memory](plan-and-memory-model_en.md) — **Current guide** for Role Knowledge sources, recall, explicit consolidation, and side effects.
- [Pipeline presets](pipeline-presets_en.md) — Agent-session defaults, explicit external targets, and Outbox statuses; FenneNote output is archival compatibility only.
- [Agent Adapter Integration Lessons](agent-adapter-integration-lessons_en.md) — **Current guide** for duplicate sessions, missing tools, inverted ownership, desktop startup dependencies, and verification.
- [Standard Agent Adapter Requirements](agent-adapter-standard-requirements_en.md) — **Current guide** for discovery, authentication, tasks, idempotent creation, delivery, results, tools, lifecycle, UI, security, and acceptance.
- [Codex Desktop Agent Integration and Acceptance Contract](codex-desktop-agent-acceptance_en.md) — **Current fact** for stable IDs, side-effect-free scanning, automatic initialization, the Desktop owner boundary, and metadata bootstrap gates.
- [Rabi Codex Context plugin](rabi-codex-context-plugin_en.md) — **Unified Manager version** where hooks only forward real Codex session events and inject Rabi PC-owned persona, plan, memory, and skill context.

## Architecture and maintenance

- [Architecture](architecture_en.md) — **Current fact**. Product boundaries, the Codex Desktop owner, current Outbox, and future Action Queue are separated.
- [Code architecture](code-architecture_en.md) — **Current fact**. Backend, Manager, endpoint, Role Knowledge, WebGUI, and desktop module map.
- [Project function map](project-function-map_en.md) — **Current fact**. Locate behavior by maturity, side effect, API, and code owner.
- [Windows launcher and packaging](windows-launcher-and-packaging_en.md) — **Current guide** for the Node/WebGUI baseline and Qt/Windows convenience layer.
- [Unattended NapCat](napcat-unattended_en.md) — **Current guide** for login state, quick login, Manager recovery, and supervision boundaries.

## Experimental integrations

- [WeCom integration](wecom-integration_en.md)
- [Voice interaction workstation](voice-interaction-workstation_en.md) — historical wiring; FenneNote/OumuQ are retired in favor of RabiPC + RabiSpeech.
- [RabiSpeech local TTS / ASR service](rabispeech-plugin_en.md) — direct APIs, hot/persona-keyword delivery, persona voice and language, bidirectional ASR/TTS records, the shared speaker registry, RabiPC, and RabiLink relay.
- [Call TTS and ASR remotely](user-guide/speech-api_en.md) — application token, target PC, copyable commands, acceptance, and error recovery.
- [Rabi Voice Client](../desktop/rabi-voice-client/README_en.md) — use a meeting-room Windows PC as a LAN microphone and speaker while segmentation and models stay on the RabiSpeech host.
- [Local speech model downloads](local-speech-model-downloads_en.md) — per-model sources, downloads, isolated environments, and validation.
- [RabiSpeech performance report](rabispeech-performance-report_en.md) — six TTS and five main ASR models, cold/warm timing, quality indicators, hardware, and CUDA issues.
- [RabiLink Relay](rabilink-relay-server_en.md)
- [RabiLink Cloudflare Worker](rabilink-relay-cloudflare-worker_en.md)
- [RabiLink glasses three-route comparison](rabilink-glasses-route-comparison_en.md) — host, lifecycle, device capability, release cost, and current guidance for native Lingzhu agent, AIUI, and native app routes.
- [Rabi mobile message endpoint](mobile-message-endpoint_en.md) — **Experimental integration** for standalone phone chat, optional glasses, reliable queues, notifications, attachments, configuration assistance, and device acceptance boundaries.
- [RabiLink phone edge hub](rabilink-phone-edge-hub_en.md)
- [RabiLink wearable health endpoint](rabilink-wearable-health_en.md) — **Experimental integration** for phone settings, structured health history, Agent queries, alert thresholds, and the Xiaomi ADB fallback.
- [AIUI-to-phone/native-glasses parity checklist](rabilink-aiui-native-parity_en.md) — migration status separated by code, automation, and real-device evidence.
- [RabiLink AIUI residency boundaries](rabilink-aiui-residency-plan_en.md)
- [RabiLink proactive-intelligence requirements](rabilink-active-intelligence-requirements_en.md)
- [RabiLink native app design](rabilink-glasses-app-design_en.md)
- [XiaoAI integration route](xiaoai-integration/xiaoai-rabiroute-intercept-route_en.md)
- [IR gateway research](xiaoai-integration/ir-remote-gateway-research_en.md)
- [Xiaomi Band heart-rate probe handoff](xiaomi-band-heart-rate-probe-handoff_en.md)

## Designs and history

- [Proactive-intelligence system design overview](../%E4%B8%BB%E5%8A%A8%E6%99%BA%E8%83%BD%E8%AE%BE%E8%AE%A1%E6%80%9D%E8%B7%AF_en.md) — **Planned**. Long-term vision for continuous sensing, intent hypotheses, proactive action, memory, and device responsibilities; use Current Capabilities for the implemented scope.
- [Persona route workbench plan](persona-route-workbench-plan_en.md) — **Partially implemented**. Speech-keyword and per-endpoint context controls are live; side-effect-free RouteDecision/AgentPacket preview is not implemented.
- [Windows tray task-window plan](rabiroute-windows-tray-task-window-plan_en.md) — design record; use `desktop/tray-task-window/` and the packaging guide for the actual implementation.
- [UE/UX audit and refactor](rabiroute-ue-ux-audit-and-refactor_en.md) — phase audit.
- [Historical mobile-app Webhook plan](mobile-app-webhook-integration_en.md) — **Historical**. The current RabiLink path no longer requires a phone bridge as the main relay.

Archived material is under [`archive/`](../archive/README_en.md). Buildable clients live under [`apps/`](../apps/README_en.md), reusable SDKs under [`packages/`](../packages/README_en.md), and copyable samples under [`examples/`](../examples/README_en.md).

## Documentation maintenance

1. Check code, schemas, APIs, WebGUI, and tests before updating the Chinese fact source.
2. Maintain the English version manually only after behavior is accurate; do not batch-translate stale documents.
3. Design documents must be labeled Planned or Historical instead of appearing in the current-capability list.
4. Runtime-semantic Markdown (`AGENTS.md`, `SKILL.md`, personas, prompts, memories, and plans) must not be translated mechanically.
