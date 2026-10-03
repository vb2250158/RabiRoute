# PC knowledge service and RabiLink connections

English | [简体中文](rabilink-knowledge-runtime.md)

Authenticated devices in the same RabiLink application can use the PC's provided knowledge tools by default, including writes and recent-memory read markers. No separate local MCP address, knowledge secret, role/tool allowlist or device grants are required. Independent Agent nodes, anonymous LAN discovery and devices in other applications do not gain access.

The PC uses existing Manager plan, memory and knowledge APIs. Manager owns business state and durable receipts. Stable tool mappings, schema and receipt checks live in `packages/rabi-knowledge-contract`; standalone `apps/rabi-mcp` reuses them. PC requests require no separate MCP process.

Current Manager context supplies the complete URL, application generation, instance ID and actual local persona catalog. Calls verify `/meta` identity, live, requiredReady and healthy/degraded. Post-write checks verify identity; an identity change or failed confirmation is uncertain. Startup probes verify identity only to avoid waiting on their own READY state. The `knowledgebridge` advertisement means the current probe succeeded. Manager ready, persona-catalog changes and reconnection events trigger checks; request failure or event-stream disconnection revokes readiness. Speech advertisements use the actual capability endpoint and Speech ready / capabilities_changed events. Disconnected streams reconnect with bounded backoff; idle connections do not poll capabilities. Advertisements do not prove business completion.

Relay's dedicated `/__rabilink/knowledge` queue carries `{appId,deviceBindingId,ownerAccountId,targetDeviceId}` with only the tool request in its body. PC checks the target and actual persona catalog, rejecting body overrides of identity, addresses or tool scope. All implemented tools are available by default; roleId enums reflect actual personas under Manager’s global rolesRoot. Custom Route persona roots are excluded from this knowledge API. Missing personas and unimplemented tools still fail.

Writes and recent-detail touch keep stable idempotency keys and nonReplayable. Transport failure returns uncertain without automatic replay or replacement keys. Installed addresses must be discovered from current Host status, never a persisted port.

Migration: configuration normalization and saving remove retired `speechProxyEnabled` and `knowledgeBridge` permission fields, preserving Relay connection, app token, instance identity, data and other parameters. Both PC and Relay require updates. Real cross-PC and phone/glasses acceptance remains separate from local tests.
