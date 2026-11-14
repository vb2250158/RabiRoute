<!-- docs-language-switch -->
<div align="center">
English | <a href="./unified-agent-api.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Unified CLI and MCP API

CLI and MCP share the operation SDK, calling Manager and business plugins over existing HTTP, SSE or WebSocket transports. DSH, mobile and other hosts forward the same catalog, schema and execution owner through their generic HTTP, CLI or MCP tools. Agents can discover and invoke every public business and management operation in the running version. Configured, authenticated connections work by default; explicit user restrictions are explained by their configuration.

This describes the current source implementation. Build, installation and live coverage are confirmed by the corresponding release acceptance.

## Find a capability

From the independent client artifact, use `node rabi-cli.mjs <command>`. From the complete source root, use the path below. Updating independent CLI/MCP clients does not restart Manager. The entry discovers the current Manager through Host and writes a JSON result to stdout.

```sh
node apps/rabi-agent/rabi-cli.mjs categories
node apps/rabi-agent/rabi-cli.mjs list --category messages --limit 20
node apps/rabi-agent/rabi-cli.mjs search "QQ history" --category messages
node apps/rabi-agent/rabi-cli.mjs describe agent.qq.history.read --view input
node apps/rabi-agent/rabi-cli.mjs call agent.qq.history.read --input-file request.json
```

An enrolled remote computer uses the same entry with its original private connection configuration, Agent type and full session ID.

```sh
node apps/rabi-agent/rabi-cli.mjs search "chat history" --config /private/rabi-agent.json --agent-type codex --id <full-session-id>
```

The standard MCP catalog presents six tools using the same model as CLI. Hosts with generic HTTP, CLI or MCP tools forward the public contracts directly without adding these six native tools or rebuilding business interfaces. Hosts obtain short hints from the same catalog and handle protocol adaptation and presentation.

| Tool | Purpose |
| --- | --- |
| `rabi_categories` | List business and plugin-defined categories |
| `rabi_list` | List short summaries by category, provider or owner |
| `rabi_search` | Find operations by keywords and optional category |
| `rabi_describe` | Read one operation's input, result or full contract |
| `rabi_call` | Execute an operation with structured input |
| `rabi_session` | Read, send to or close the original stream/WebSocket session |

Read a summary, select an operation and inspect `view=input`. `view=result` describes results, while `view=full` returns its executable contract. CLI describe defaults to input. See [Rabi MCP](../apps/rabi-mcp/README_en.md) for launch settings.

## Categories and keywords

| Stable category ID | Content |
| --- | --- |
| `messages` | Message connections, conversations, search, history, sending, replies and message attachments |
| `agents` | Agent software, execution sessions, collaboration, native history and receipts |
| `knowledge` | Memories, plans, steps, Skills and plan materials |
| `devices` | Computers, terminals, files, windows, home devices and media |
| `settings` | Roles, persona configuration, Routes and Rabi PC settings |
| `automation` | Rules, schedules, events, Hooks and execution records |
| `runtime` | Rabi plugin installation/removal, versions, lifecycle, status and diagnostics |

Plugins declare categories, titles, keywords and providers in an operation definition's `discovery`; explicit declarations take precedence. Missing Chinese navigation fields for existing APIs belong in the public discovery plugin's base navigation data. This preserves executable contracts, schemas, owners and permissions without inventing APIs for search. Custom categories retain stable IDs, optional parents and plugin ownership. Public operations without category metadata remain globally searchable. Cross-category tags and related-operation links refer to the same operation.

`category` filters scope. Search matches actual titles, keywords and relevant phrases; Chinese/English synonym groups expand on the query side rather than adding every category term to each operation. Catalog `provider` identifies a capability provider. Documentation calls a model vendor ModelProvider; wire fields remain unchanged.

## HTTP discovery contract

| Endpoint | Result |
| --- | --- |
| `GET /api/agent/categories` | `data.categories` with descriptions, parents and current counts |
| `GET /api/agent/operations` | Short `data.items`, `count`, `total` and `nextCursor` |
| `GET /api/agent/operations/:operationId?view=input` | Input contract, parameter sources and related operations in `data.operation` |

List filters are `category`, `query`, `provider`, `owner`, `method`, `pathPrefix`, `limit` and `cursor`. Pages default to 20 items and support `limit` 1–200. Search covers IDs, aliases, titles, summaries, paths and declared keywords; categories filter scope. A cursor binds its original snapshot and filters. After a 409, discover a current page.

Responses include `schemaVersion`, Manager identity, `pluginGenerationId`, `catalogRevision` and `catalogDigest`. The compatible complete help at `/api/agent/help` and OpenAPI export remain available. Normal discovery uses short summaries and a single-operation description.

## From API capabilities to business resources

`categories`, `list` and `search` return API capabilities. List `total` counts matching operations, not computers, messages or plans. Find a real operation with scenario terms such as “computer list” or “group history”, read its input and `inputSources`, then call its business directory for devices, online status or messages. An empty search or terminal-session list does not establish that device-control capabilities are absent.

The DSH HTTP bridge can make the same three discovery GET requests. An existing bridge plus short hints from the catalog provides public business access. When Rabi reads Codex/DSH native sessions, history, the Codex Desktop owner or DSH-native plugin management, its platform adapter reaches the real owner. See [Standard Agent Adapter Requirements](agent-adapter-standard-requirements_en.md) for both directions.

## Shared input and request identity

CLI `--input-file`, `--input-json` or `--input-stdin` and MCP `input` consume the same JSON. Path, query and body retain their namespaces.

```json
{
  "pathParams": {},
  "query": { "routeId": "example-route", "kind": "group", "target": "123456789", "limit": 50 }
}
```

| Field | Meaning |
| --- | --- |
| `operation` | Stable business operation ID, corresponding to the CLI call positional argument |
| `input.pathParams` | Path parameters encoded against the current path template |
| `input.query` | Scalar or scalar-array query parameters |
| `input.body` | JSON body, including JSON encoding for string values |
| `input.bodyBase64` | Base64 representation of original binary bytes |
| `input.headers` | Business headers required by the contract |
| `requestId` / `idempotencyKey` | Identity of this write request and its original receipt |
| `expectedRevision` | Original strong ETag, corresponding to CLI `--if-match` |

Catalog `operationId` identifies a capability. Some legacy transport fields use `operationId` for one request's identity. Adapters preserve the exact mapping. A fixed operation ID must not become a shared idempotency key for multiple writes.

`inputSources` references real operations, parameter mappings and result fields. QQ history, for example, obtains the Route and contact directory before using the original `routeId`, `kind` and `target`. Errors retain the field, valid-parameter discovery entry, HTTP status and receipt. Interpret `accepted`, `committed`, `delivered` and `uncertain` according to the original owner's actual stage.

## Files and live connections

Finite downloads use CLI `--output` or MCP `input.outputPath`. SSE requires an output file or existing stream consumer. WebSocket CLI captures frames with `--output frames.jsonl` and accepts input through `--frames-stdin`. Command termination and cancellation close the original session.

MCP streaming calls return `sessionId`. Use `rabi_session` to read frames, send frames or close that session. Transport state and the original receipt describe connection acknowledgement and business results. Reconcile uncertain writes by the original ID.

## Native Agent capabilities

| Provider | Public paths and owner |
| --- | --- |
| Codex | `/api/agent/providers/codex/sessions`, `/sessions/:sessionId` and `/sessions/:sessionId/history`, read by the Codex plugin from native directories and records |
| DSH | `/api/agent/providers/dsh/sessions` and its detail/history paths. History delegates to native `session/events` |
| DSH plugins | Provider paths for `/plugins`, `/bundles`, `/plugin-market`, market search and plugin install/update/remove delegate to DSH's PluginManager / PluginMarket |

Codex history retains native events, tool IDs, physical sequence and returned cursors. Later plain-JSONL pages seek to their returned position. DSH retains native sequence, cursor and coverage fields. Rabi delivery/reply records describe their own business facts. Choose the documented source for the requested history.

## Skills and automation templates

Role Skills retain their list, detail and download endpoints. Editing starts with `GET /api/roles/:roleId/skills/:skillId/source`, returning the complete document, supporting-file index and strong ETag.

- `POST /api/roles/:roleId/skills` creates a Skill using `id`, `content` and optional `files`.
- `PUT /api/roles/:roleId/skills/:skillId` updates its document and relative supporting files.
- `DELETE /api/roles/:roleId/skills/:skillId` removes the original Skill.
- Writes carry a stable `Idempotency-Key`. Updates and deletion carry the original `If-Match`.
- `GET /api/roles/:roleId/skill-operations/:requestId` reads the original mutation receipt.

`GET /api/automation/templates` pages through built-in and plugin template summaries. `GET /api/automation/templates/:templateId` returns the complete editable action. Selecting a template expands it into an ordinary automation rule. Users edit its schedule, target, busy policy and body. The shared scheduler executes it.

The memory-and-Skill template reads memories, compares existing Skills, updates or creates reusable procedures, saves and reads back consolidation results, then summarizes changes. Other presets cover work review, plan review, message summaries, runtime checks and blank delivery.

## Plugin changes and query parity

Discovery metadata is published with the active registry snapshot. Category and keyword changes update the catalog revision. Executable contract changes update `contractDigest`. SDK caches single-operation contracts and refreshes after catalog events, reconnects or identity changes.

Verify UI, CLI and MCP against the same sources for lists, full text, related records, members, images and merged forwards. Compare IDs, fields and paging coverage. Report an individual failure in its own scope while healthy data remains queryable. Installed versions and external-host tool loading are confirmed by their release and runtime acceptance. Record actual host tools, loaded hints and adapter versions. Scenario searches such as “computer list” and “group history” must locate real APIs and read business resources. HTTP 200, a Host version and a source build establish only their respective scopes.

## Legacy-data upgrades

After the application is fully started, WebGUI reads the cached status at `GET /api/data-upgrades`. Pending items open an upgrade overview. Each migration owner supplies its category, source and target version or layout, status, changes and known record counts or sizes. Unknown counts remain pending inspection. The first page reads lightweight status. Discovery runs in a bounded child process.

Confirmation calls `POST /api/data-upgrades/start` with `{ "operationId": "<this-upgrade-request-id>", "expectedRevision": 1 }`. Use the revision from the latest status. In this body, `operationId` is the stable identity of one upgrade request. The accepted response carries its status. Background progress is published through `data-upgrade-status` and the original status endpoint.

When migration requires retired data owners, the UI labels confirmation as “Upgrade and restart”. It persists the accepted operation before requesting one restart through the formal Host entry. Closing the window leaves the accepted operation running. After reconnecting, read its original status. Ordinary transaction recovery and format upgrades retain their own lifecycles. Healthy reads and independent features remain usable, with progress delivered through events.
