# RabiLink PC knowledge bridge (experimental wiring)

English | [简体中文](rabilink-knowledge-bridge.md)

`src/manager/rabiLinkKnowledgeBridge.ts` is a disabled-by-default policy layer. `apps/rabi-mcp/lib/knowledge-http-client.mjs` uses the official SDK to connect to the existing knowledge MCP HTTP service. Neither implements Manager business logic, creates an inference runtime, or executes a shell.

The root runtime now uses official SDK 1.30.1 through `rabiLinkKnowledgeRuntime.ts`, dispatching dedicated queues before generic local proxying. rabi-agent dependencies remain unchanged; the independent adapter remains available for standalone hosts. Actual HTTP and fake-queue tests do not imply installation or device acceptance. See the [runtime contract](rabilink-knowledge-runtime_en.md) for configuration, secret redaction, grants and capability advertisement. Never accept module paths, endpoint URLs or tokens from device requests.

Local settings are enabled, url, token, allowedRoles, allowedTools and allowWrites. The URL must be exactly `http://127.0.0.1:<port>/mcp`, without query, user information or other paths. Writes default off. Recent-memory details update view timestamps and also require write permission and a stable business idempotency key. Argument validation shares the single `packages/rabi-knowledge-contract` schema with knowledge-tools, without duplicating tools or Manager paths.

The caller must authenticate and inject appId, deviceBindingId, ownerAccountId and targetDeviceId. This module checks their presence, not their identity or ownership. Relay must explicitly select the app-owned PC. Generic WebGUI queue requests must not forge reserved paths or device metadata. Effective authorization remains the intersection of device grants, local PC policy and MCP server policy.

Transport failures never retry automatically. Mutations return `uncertain`; the queue owner must durably preserve the original business key/body and reconcile authoritatively, never replay with a new key. Errors do not expose underlying exceptions or credentials. Tests cover rejection before transport, stable keys, single-attempt failures and official SDK HTTP initialization/discovery/call.
