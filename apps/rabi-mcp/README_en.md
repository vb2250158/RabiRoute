# Rabi knowledge MCP

English | [简体中文](README.md)

Status: experimental implementation; installation/release and real Agent, phone and glasses acceptance remain pending.

This application exposes RabiPC plans and memories through the official MCP SDK over stdio or controlled Streamable HTTP. It does not perform inference, own business data or launch a remote Agent. The MCP host launches `node knowledge-mcp.mjs`. Each business call discovers Manager through the local Host and verifies its identity; no fixed Manager port is used.

## Configuration

Set these environment variables in the MCP host:

- `RABIROUTE_HOST_EXE`: optional local Host executable; defaults to the current user's standard installation.
- `RABI_MCP_ALLOWED_ROLES`: required JSON string array, e.g. `["example"]`; tool arguments cannot expand authorization.
- `RABI_MCP_ALLOW_WRITES`: defaults to `false`; explicit `true` enables mutations and recent details that update view timestamps.

Default tools provide knowledge search, plan lists/details/status catalogs, memory lists and consolidated details. Write mode adds plan and recent-memory creation/updates. Updates require the exact strong ETag; mutations require a previously saved stable idempotency key. Recent details follow the current Manager touch receipt contract; a read-only Manager without that receipt is not confirmed successful.

Deletion, archival writes, consolidation execution, attachments, task bindings and arbitrary HTTP requests are excluded. Timeouts, 503, identity changes or incomplete receipts require authoritative readback, never automatic replay. After 412, reread and confirm intent before using a new key and ETag.

## Controlled HTTP access

Set `RABI_MCP_TRANSPORT=http` and supply a random `RABI_MCP_HTTP_TOKEN` of at least 32 characters through the launch environment. `RABI_MCP_HTTP_PORT` defaults to `0` (OS allocation); a structured `READY` line reports the actual address without the secret. The server binds only loopback and accepts Bearer-authenticated `/mcp` POST requests, rejecting cookies, unauthorized Origins and bodies over 64 KiB. The CLI grants no browser Origins. Never put the token in URLs, logs or public configuration.

This is standard MCP Streamable HTTP, not arbitrary REST forwarding. Glasses cannot reach PC loopback directly; authenticated PC/Relay transport and device authorization are still required. Do not change the binding to public access as a shortcut. Role allowlists and write policy remain startup-owned. The HTTP module has official SDK client tests; the earlier stdio artifact predates HTTP changes and must be rebuilt.

## Independent local artifact

Use a complete local snapshot containing this application, the shared transport sources in `apps/rabi-agent/lib/`, and the shared contract in `packages/rabi-knowledge-contract/`. Preserve repository-relative directories. The shared schema is bundled into the artifact and recorded in the source-input hash manifest:

```sh
npm ci
node scripts/build.mjs --output <new-absolute-local-directory>
```

The output must not exist and its parent must already exist. NAS/UNC paths, mapped network drives and overwriting prior output are rejected. The script inlines relative source dependencies, keeps the SDK external and installs production dependencies using the independent lock and `npm ci --ignore-scripts`. It emits the entry, bilingual documentation, dependencies and `artifact-manifest.json` file hashes. Failures retain incomplete output for inspection without automatic deletion. The artifact supports local Host only; an unexecuted LAN branch retains a dynamic `bonjour-service` reference and does not provide remote mode. Windows installation integration and installation itself are not included.

## Development and packaging boundaries

Three source bridges reference the single maintained transport implementation in `../rabi-agent`. Run source only from a complete local build snapshot. An independent artifact must inline these relative dependencies or explicitly stage controlled files; copying this directory alone is insufficient. This application and the PC root runtime use their own pinned SDK dependency. The SDK is not added to `rabi-agent`, and remote Agent update dependencies remain unchanged. Build and dependency installation must run on local disk.

Coverage includes module tests, a real HTTP fake Manager, official SDK in-memory and real stdio subprocess tests. Initialization and read-only tool discovery against a real local Host were verified without reading or writing real knowledge. Passing tests does not mean an Agent host has registered the tools or a phone can directly configure MCP. Phone Relay management requires selecting the target computer; tool loading and permissions remain owned by the external Agent host.
