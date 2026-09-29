# PC knowledge HTTP bridge (experimental)

English | [简体中文](rabilink-knowledge-runtime.md)

The PC runtime forwards dedicated device knowledge requests to existing MCP Streamable HTTP. It does not proxy model inference or duplicate Manager business logic. Installation and device acceptance remain pending.

Local `rabiLinkRelay.knowledgeBridge` configuration is disabled by default. Configure `enabled`, `url`, `token`, `allowedRoles`, `allowedTools`, `allowWrites`, and `grants`. Only `http://127.0.0.1:<port>/mcp` is accepted. Use a private random token of at least 32 characters, never in a URL. Each grant contains `appId`, `deviceBindingId`, and `ownerAccountId`, matching Relay-authenticated ownership. The target must also match this PC. Knowledge access accepts canonical PC deviceId values only (alphanumeric ends; letters, digits, underscores and hyphens inside; no repeated hyphens). Noncanonical IDs do not advertise capability. Legacy worker mismatches fail closed: normalize the PC name and reselect its target, never guess by GUID. Configuration uses existing local file storage, not claimed encryption at rest. Public configuration exposes only `tokenConfigured`; omitting token in a patch preserves its existing value.

## Operator setup

The existing WebGUI RabiLink settings now include a collapsed local knowledge MCP settings panel. Load before editing; leaving the secret blank preserves it. Saving reads back nonsensitive fields and stops retries on mismatch. Saved configuration and actual handshake readiness are shown separately. This uses the existing controlled management entry, without broadening generic glasses proxy permissions. The current configuration API has no revision CAS; concurrent-update safety is not claimed.

For management API use, discover Manager through the local Host and verify its generation with `/meta`, then read `GET /api/rabi/identity` through the controlled local management channel. On that same channel, `PATCH /api/rabi/identity` with `{rabiLinkRelay:{knowledgeBridge:{enabled:true,url,token,allowedRoles,allowedTools,allowWrites,grants}}}`, using the actual local MCP service and verified device ownership. Do not deploy placeholder values. Never write back `tokenConfigured`; subsequent partial patches may omit token to preserve it, while empty or masked values are rejected.

Saving synchronizes runtime, but connection acceptance still requires the online PC's `knowledgebridge` capability and actual tool discovery. Phone profile references do not replace this service connection or authorization on both sides. Disable using `{rabiLinkRelay:{knowledgeBridge:{enabled:false}}}`. Do not broaden generic mobile WebGUI allowlists to configure secrets remotely.

The dedicated queue path is `/__rabilink/knowledge`. Top-level `knowledge` carries authenticated identity and the Relay grant; the body contains only a list/call request. A body cannot forge this marker. Relay must reject reserved paths through generic proxy entry points. PC intersects local and Relay roles, tools, and write permissions. Lists include restricted roleId enums, allowedRoles, and allowWrites; calls revalidate the shared schema.

Writes and recent-detail touch requests require `nonReplayable` and stable business idempotency keys. Transport failures report `uncertain`, without automatic retries. Relay owns queue deduplication and non-replay semantics; a single PC HTTP attempt is not an exactly-once guarantee.

Only successful SDK initialization and tool-list probing advertise `knowledgebridge`; a call transport failure withdraws it. Existing configuration synchronization or connection restart probes recovery without new high-frequency polling.

The root application uses the pinned official MCP SDK. Pure schemas live in `packages/rabi-knowledge-contract`. The independent `apps/rabi-mcp` adapter remains useful for standalone hosts/tests; the two clients share schemas, not duplicated plan or memory implementations.
