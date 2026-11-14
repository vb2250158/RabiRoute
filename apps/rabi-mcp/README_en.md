# Rabi MCP

English | [简体中文](README.md)

This application exposes category discovery, search, descriptions and calls for all public Rabi operations over the official MCP SDK's stdio or Streamable HTTP transport. CLI and MCP share the operation SDK. The current Manager and original plugin owner execute business behavior. The MCP host launches `node knowledge-mcp.mjs`, while local Host discovery supplies the current endpoint and identity.

This describes the current source implementation. Installed adoption and tool loading in an external Agent host are confirmed by release acceptance. See [Unified CLI and MCP API](../../docs/unified-agent-api_en.md) for contracts and commands.

## Default tools

The default catalog contains six tools: `rabi_categories`, `rabi_list`, `rabi_search`, `rabi_describe`, `rabi_call` and `rabi_session`. Start with category or keyword summaries, inspect a single input contract, then invoke the original operation. Read large result schemas through result/full views as needed.

`rabi_call.operation` is the stable business operation ID. Its `input` is the same JSON consumed by CLI. `requestId/idempotencyKey` identifies this request and `expectedRevision` carries the original strong ETag. HTTP, binary and file results retain status and receipts. Streaming calls return an original `sessionId` for subsequent reads, sends or closure through `rabi_session`.

The ten existing knowledge tool names remain callable for compatibility. The visible catalog presents the shared six actions. New plugin operations become discoverable through the current catalog without adding a separate MCP tool per operation.

## Configuration

Configure these values in the MCP host's launch environment.

- `RABIROUTE_HOST_EXE` is optional. Discovery uses the standard installation and current running Host when omitted.
- `RABI_MCP_ALLOWED_ROLES` is an optional JSON string array. Omission permits every role. An explicit list applies only to that configured scope.
- `RABI_MCP_ALLOW_WRITES` defaults to `true`. Explicit `false` disables state-changing calls according to current operation effects and reports the setting.
- `RABI_MCP_MAX_SESSIONS` defaults to `16` and controls concurrent active stream and WebSocket sessions.
- `RABI_MCP_MAX_SESSION_BYTES` defaults to `1048576` and sets each session frame queue high-water mark; consumption resumes the producer, and an empty queue accepts one larger native-legal frame. Read or close unread terminal results when the retained budget is full. Set both as positive integers in the MCP launch environment.

The catalog provides discovery. Calls retain current connection authentication, resource semantics, CAS and idempotency. Preserve original identifiers and payloads after uncertain writes and inspect their original receipts.

## Controlled HTTP access

Set `RABI_MCP_TRANSPORT=http` and supply a random `RABI_MCP_HTTP_TOKEN` of at least 32 characters through the launch environment. `RABI_MCP_HTTP_PORT` defaults to `0` (OS allocation); a structured `READY` line reports the actual address without the secret. The listener defaults to `127.0.0.1`; set `RABI_MCP_HTTP_HOST` to select another bind address. Business requests require Bearer authentication; cookies and Host aliases do not add a separate rejection. Optional `RABI_MCP_ALLOWED_ORIGINS` is a JSON array: omission allows all Origins, while an explicit list (including `*` or `null`) is enforced. Browser OPTIONS preflight is supported. `RABI_MCP_HTTP_MAX_BODY_BYTES` sets the body budget (default 65536 bytes); oversized requests identify this setting. Never put the token in URLs, logs or public configuration.

Streamable HTTP uses standard MCP. Remote devices use the existing authenticated PC/Relay connection to the selected computer. Launch configuration owns the bind address, role/Origin scope and write setting. Host tool loading, connectivity and business outcomes are verified separately.

## Independent local artifact

Use a complete source snapshot containing this application, the shared transport sources in `apps/rabi-agent/lib/`, and the shared contract in `packages/rabi-knowledge-contract/`. Preserve repository-relative directories. The shared schema is bundled into the artifact and recorded in the source-input hash manifest:

```sh
npm ci
node scripts/build.mjs --output <new-absolute-directory>
```

The artifact includes both `knowledge-mcp.mjs` and `rabi-cli.mjs` from the same SDK. CLI `--config` retains the existing enrolled Agent connection and durable delivery owner. MCP discovers the local Host. Updating these independent clients does not restart Manager.

The output must not exist and its parent must already exist. Accessible local, NAS/UNC and mapped-drive paths are supported; prior output is not overwritten. Windows executes npm CLI through Node, avoiding cmd losing a UNC working directory. The script inlines relative source dependencies, keeps the SDK external and installs production dependencies using the independent lock and `npm ci --ignore-scripts`. It emits the entry, bilingual documentation, dependencies and `artifact-manifest.json` file hashes. Failures retain incomplete output for inspection without automatic deletion. MCP supports local Host startup; CLI also accepts an existing private connection configuration. The Windows runtime source manifest includes the shared CLI/MCP entry and dependencies. The actual packaged bytes and installed adoption are confirmed by release acceptance.

## Development and packaging boundaries

Three source bridges reference the single maintained transport implementation in `../rabi-agent`. Run source from a complete source snapshot. An independent artifact must inline these relative dependencies or explicitly stage controlled files; copying this directory alone is insufficient. This application and the PC root runtime use their own pinned SDK dependency. The SDK is not added to `rabi-agent`, and remote Agent update dependencies remain unchanged. Build and dependency installation use the accessible directory selected by the user.

Coverage includes module tests, a real HTTP fake Manager, official SDK in-memory and real stdio subprocess tests. Initialization and read-only tool discovery against a real local Host were verified without reading or writing real knowledge. Passing tests does not mean an Agent host has registered the tools or a phone can directly configure MCP. Phone Relay management requires selecting the target computer; tool loading and permissions remain owned by the external Agent host.

The WebGUI timeout page owns `mcp.*` settings. The launch environment can supply `RABIROUTE_TIMEOUT_OVERRIDES` for initial Host discovery; verified `/meta` refreshes the snapshot afterward. Discovery and knowledge HTTP budgets apply to subsequent operations. HTTP request/header/keepalive settings apply on the next server start. Missing overrides preserve previous defaults.
