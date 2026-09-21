English | [简体中文](host-onboarding-checklist.md)

# Agent host onboarding checklist

This is a maintainer checklist, not evidence that the current host release has passed acceptance. Load the [adapter skill](../SKILL.md), then verify against current host documentation, implementation, and isolated fixtures. The host owns capabilities and session truth; Rabi owns configuration, routing, bindings, and the managed delivery contract.

## 1. Probe before declaring support

- Inspect CLI help and official programmatic interfaces before choosing CDP, reverse engineering, or UI simulation. Reading help does not authorize its create, send, or mutation commands.
- Verify Hook events, JSON input (session ID, cwd, tool name), output structure, matcher applicability, and loading time. Do not attach tool-only matchers to lifecycle events.
- Resolve the real Home, plugin root, and environment variable names from current processes or managed configuration. Do not derive them from the host name or copy another computer's layout.
- Install temporary probes only with authorization for that experiment. Back up configuration, record only necessary non-sensitive fields, and restore afterward. Do not record credentials or complete private prompts.
- Record host version and verification evidence. A missing installation entry does not prove missing Hook support; writing configuration does not prove execution.

## 2. Session and delivery identity

- Locate the authoritative session database or descriptors. Separate user-assigned names from automatic titles. Resolve names using the fields allowed by the host contract and display name plus ID.
- Real messages use one managed transport that explicitly addresses an existing session ID. An explicit parameter does not eliminate misdelivery risk: still verify the owner, workspace, and receipt.
- Different entry points may mark input as `SYSTEM`, `USER_EXPLICIT`, or other sources. Report what the actual transcript establishes; never call system injection human input.
- Where a live owner is required, verify process, heartbeat, published endpoint, and session kind together under the existing contract. A prewarmed process or missing endpoint is not a deliverable session.
- When Desktop owns real messages, fail closed if it is unloaded or unavailable. Do not switch to a fallback Runtime, the current UI conversation, or automatically enable CDP to bypass failure.
- Obtain endpoints and credentials only through the managed discovery contract. Do not scan ports to guess a service or forward credentials to a new address without established trust.
- Keep credentials in protected, untracked local state, not source or logs. Read authoritative state before handling an uncertain receipt; do not replay automatically.

## 3. Implementation touchpoints

1. `src/shared/agentAdapterCapabilities.ts`: declare types, manifests, maturity, and verified capabilities. One successful HTTP response is insufficient evidence for `deliveryReceiptRecovery`.
2. `src/shared/gatewayConfigModel.ts` and `src/config.ts`: binding fields, normalization, and environment configuration; accepted endpoints follow the existing trust contract.
3. `src/<agent>SessionStore.ts`: read host truth, compare Windows paths using platform semantics, and filter before pagination.
4. `src/<agent>SessionBridge.ts`: the sole real-message transport; distinguish explicit rejection, non-delivery, and unknown outcome.
5. `src/agentAdapters/builtinAgentAdapters.ts` and `<agent>ManagerApi.ts`: discovery and diagnostics that separately expose installation, credentials, endpoint, project, and session status.
6. `src/shared/agentInstance.ts`: query types and capabilities rather than maintaining adapter allowlists or A/B fallbacks.
7. `plugins/rabi-<agent>-context/` and `src/agentAdapters/hookInstallation.ts`: keep Hook declarations authoritative in one place. Merge only fingerprint-owned entries; preserve other keys/Hooks, reject invalid configuration, and make repeat installation idempotent.
8. WebGUI: check `RouteConfigPage.vue`, `QuickSetupDialog.vue`, related stores/types, and manifest exports, not just one panel. Resolve labels from capability definitions rather than falling back to another host.
9. `ribiwebgui/src/i18n/catalog.ts`: maintain Chinese keys and English text; check for duplicate keys first.
10. Bilingual onboarding, capability documentation, and version notes: describe implemented behavior backed by appropriate evidence only.

## 4. Hook diagnostics and acceptance

- Distinguish not executed, executed without context, and Manager unavailable through managed diagnostics. Record event, outcome, elapsed time, and bounded identity hints, not secrets or complete messages.
- Installers and fixtures share an explicit self-check output contract. A nonempty string may be a fail-open error; do not use `Boolean(output)` as connectivity proof. Use the current structured verdict or exact success marker.
- Distinguish plugin installation from user-configuration installation. Hosts such as WorkBuddy may load configuration at session startup; identify the exact sessions that need reopening under the current implementation, rather than restarting the entire Desktop by default.
- Discover Manager using Host `managerBaseUrl`, `applicationGenerationId`, and `managerInstanceId`, or source READY, then verify `/meta`. Ordinary calls accept `healthy` or `degraded`, require `health.live=true` and `health.requiredReady=true`, and leave dependency checks to the endpoint. Rediscover on identity mismatch; do not infer readiness from a fixed port.
- Verify real delivery only when explicitly authorized: expected-source input and a reply appear in the target session, without creating an extra task. Prefer authoritative terminal receipts when available. Do not treat no new task as failure.
- Report configuration paths, events, scripts, self-check results, sessions requiring reopening, and unverified items. Installation, configuration loading, and real interactive acceptance are separate results.

## 5. Isolated tests

Explicitly isolate host Home, databases, session descriptors, credentials, and logs. WorkBuddy fixtures must configure implementation entry points such as `RABI_WORKBUDDY_HOME`, never read the runner's real sessions. Cover missing endpoints, stale owners, incorrect cwd, duplicate names, denied access, structured errors accompanying nonzero exits, uncertain receipts, Hook fail-open, and idempotent installation. Record backend/frontend type checks, affected regressions, and builds separately; headless tests do not replace interactive-session acceptance.

## References

- [Adapter requirements](../../../docs/agent-adapter-standard-requirements_en.md)
- [Integration lessons](../../../docs/agent-adapter-integration-lessons_en.md)
- Current repository implementations such as `rabi-codex-context` and `rabi-workbuddy-context` are comparisons, not proof that historical probes on one computer define a cross-version contract.
