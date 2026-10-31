<!-- docs-language-switch -->
<div align="center">English | <a href="./route-control-api-contract.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Executable contracts for Route control APIs

> Status: source migration with passing focused isolated tests. Full builds, installed releases and physical cross-computer calls require separate acceptance.

`io.rabiroute.manager.route-control` registers APIs through `createRabiControlOperations()`. The same definitions install routes, validate inputs and outputs, and populate the active API catalog. The plugin no longer keeps an exact/prefix route list or calls the retired `handleRabiApi` HTTP dispatcher.

## Operations and owners

All operations use the `manager.route-control.` prefix and remain public. Authenticated remote connections use the same owners; personas, plans and Route bindings do not add feature permissions.

| Operation suffix | Method and path | Original owner |
| --- | --- | --- |
| `identity.read` / `identity.update` | GET / PATCH `/api/rabi/identity` | Global configuration, Relay synchronization and gateway lifecycle |
| `link-home.read` | GET `/api/rabi/link-home` | Saved Relay configuration and device summary reader |
| `instances.list` | GET `/api/rabi/instances` | DNS-SD discovery and generation verification |
| `routes.list` | GET `/api/rabi/instances/:guid/routes` | Local Route catalog or selected Manager |
| `agent-options.read` | GET `/api/rabi/instances/:guid/routes/:routeId/agent-options` | Original Agent catalog scanner |
| `agent-binding.update` / `agent-binding.post` | PATCH / POST `/api/rabi/instances/:guid/routes/:routeId/agent-binding` | Original Route configuration transaction |
| `rabilink-replies.list` | GET `/api/rabi/instances/:guid/routes/:routeId/rabilink-replies` | Original reply file reader |
| `message-processing.read` / `message-processing.update` | GET / PATCH `/api/rabi/instances/:guid/routes/:routeId/message-processing` | Original worker state and Route configuration transaction |
| `message-processing.cleanup` | POST `/api/rabi/instances/:guid/routes/:routeId/message-processing-cleanup` | Original workspace, title and adapter selection rules and cleanup owner |
| `manager-config.read` / `manager-config.update` | GET / POST `/manager-config` | Manager configuration repository and directory preparation |

There are 14 operations in this plugin. This count does not prove migration of every public API in the project.

## Preserved execution behavior

- Route binding and worker configuration mutations still require the original `Idempotency-Key` and strong `If-Match`. Preparation checks the original generation/instance headers and write conditions before consuming a body. Remote targets cannot launder weak ETags either. The original `writeConfig` owns storage and commit receipts.
- Contracts discard ignored native read bodies without decoding them. `link-home` still rejects query parameters, bodies and transfer-encoded requests. Native JSON writes retain empty-body defaults, arbitrary Content-Type, unknown properties and existing coercion, without introducing a new application byte limit.
- Selected Managers come from existing DNS-SD discovery and are verified before forwarding. Only the original mutation and generation headers are forwarded; caller cookies, Authorization and Relay tokens are not. Independently versioned upstreams retain their native valid JSON and status. Their response contracts explicitly describe this open JSON boundary rather than claiming a local DTO.
- Local identity reads and updates return a public Relay summary without its token. Device home continues to use saved Relay credentials and return bounded fields. Changes to the saved configuration or local GUID invalidate an in-flight result.
- Cleanup preserves explicitly retained sessions and tasks outside the original message-processing rules. DSH deletion can partially succeed; HTTP success does not prove every deletion succeeded. Identity, path configuration and cleanup have no request-level idempotency; inspect original state before deciding whether to repeat uncertain work.
- Operations wait for their original owners to finish. HTTP disconnection cannot prematurely release a plugin operation lease. Revoking the original Node hides business data at the common response boundary while retaining uncertainty about execution.

## Verification boundary

Focused tests use the real contract registry, isolated HTTP servers, real Node enrollment and the original global configuration files. They cover identity and path readback, original Route CAS/idempotent receipts, native device home, preconditions before bodies, revocation, lease joining after disconnect, and independent readback of both original cleanup files. Tests send no real Agent prompts, modify no production Routes, and do not establish installed-release or physical two-computer acceptance.

See the [target architecture](api-contract-discovery-target-architecture_en.md) and [implementation record](api-contract-discovery-implementation-progress_en.md) for overall acceptance.
