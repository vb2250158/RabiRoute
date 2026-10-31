English | [简体中文](connection-access.md)

# Connections and API access

Invalid computer credential records are isolated by node while independently validated connections remain usable. All records sharing a duplicate `nodeId` are isolated; no record is chosen arbitrarily. Original data remains intact, and enrollment cannot overwrite an isolated identity. `credentialDiagnostics` in `GET /api/lan-agent/instances` and `/api/lan-agent/nodes` reports record positions, identifiable node IDs, and reasons without secrets or hashes. Before repair, back up private `data/.runtime/lan-agent-authority.json`, confirm the intended identity through its existing management process, and repair only the affected records. Do not reset the whole credential file or reenroll every computer. Unparseable JSON or unsupported top-level schemas still report a file-level failure.

Remote connector 0.2.6 authenticates the entire computer with its enrollment credential. Enable Agent is one instance-wide switch, enabled by default. An enabled instance can use all public host APIs, including renaming, plans, memory, Skills, files and tasks, without browser login, a primary Agent, session registration, binding or per-feature grants. Every Agent call supplies its actual type and complete session ID; directories and session lists are discovery, not permissions.

Status: implemented in 0.3.25. Authenticate a connection once, then use its provided APIs without another grant for each feature, persona or skill. The API catalog describes capabilities and parameters; it is not another permission allowlist.

Local operations use the Manager address published by the current Host. LAN WebGUI uses its existing connection key, remote Agents use their enrolled node credential and actual Agent type and complete session ID supplied with this call, and devices in the same RabiLink application reuse application authentication. Requests continue carrying the existing credential without another pairing or feature grant. Revoked connections, disabled Agents and stopped services still take effect.

## Full functionality by default; only explicit configuration disables it

After connection authentication succeeds, RabiLink and remote Agents can use every public RabiPC API by default. No second per-API or per-feature grant is required; absent permission settings do not mean denial. Only capabilities explicitly disabled by the user in WebGUI or configuration files are restricted, and only within the declared scope. An existing remote-Agent enrollment switch controls admission, not a second default-off feature layer after admission.

Plan, persona, workspace, Route, Skill and API catalogs do not grant or revoke API permissions. Pull/merge, publication checks and risk reviews must not invent disabled settings, require extra credentials, remove connection leases or disable pairing. Request-format and revision checks prevent incorrect or duplicate execution; they are not another user-authorization layer.

## Removed duplicate restrictions

| Entry | Current behavior |
| --- | --- |
| Xiaomi device control | A working Home Assistant connection can use supported device actions without another control switch. |
| Xiaomi recording reads | Reuse Manager connection authentication without a separate recording token. Users still choose whether to capture recordings. |
| Persona scripts | Configured local automation can run scripts in its persona's `scripts/` directory without another Route permission switch. Remote persona scripts execute on their owning PC. |
| Message sends | Primary Personas, Plan Agents, secretaries and Message Agents use the same send contract, without a primary-only switch. |
| Persona skills | Authenticated Agents can read and download persona skills without a separate Route binding. Reading does not execute scripts. |
| Agent APIs | Authenticated nodes use provided Manager APIs without a second WebGUI administration key for existing routes outside the discovery catalog. Unknown routes still return not found. |
| RabiLink | Authenticated devices in the same application retain default service access without additional service grants. |
| Nodes, Peers and WebGUI settings | Authenticated connections can manage nodes, discover or call Peers, and change LAN access settings without a second administration key. |
| Gamer integration, model directories and recording archive settings | Reuse connection authentication without a loopback-only caller restriction. Model paths, archive ownership, revisions and idempotency conditions still apply. |
| Browser history bridge | Manager business APIs reuse connection authentication; browser extensions still identify their own paired connection with its existing credential. |
| Installed plugins | Use host APIs declared in their Manifest without another Profile `grants` list. Undeclared host APIs remain outside the plugin contract. |

Authenticated connections explicitly provide the Agent type and full session ID on each send or delegation. The current chat need not be pre-registered, and the connector's saved session is not rebound. Upload receipts are public Manager resources: authenticated host callers and other connections can query the original uploadId and reference the existing file by fileId plus SHA-256. Uploader identity is audit attribution, not another feature grant. Revocation, explicit disables, expiry and content integrity still apply.

## Requests must still follow their contracts

Messages follow the [delivery contract](rabi-agent-interfaces_en.md): identify the sender, target, reply requirements and correlation fields without impersonating another session or a system message. Device actions use supported capabilities and parameters. State versions, configuration revisions, current Manager identities and stable idempotency keys prevent changes to the wrong object or duplicate execution; they do not ask users to authorize again. After a timeout or uncertain result, read the original receipt rather than resending with a new key.

Local file sends have no directory restriction by default. A nonempty Route `messageAdapterPolicies.<channel>.allowedFileRoots` list restricts sends to those resolved directories; an absent or empty list imposes no restriction. Rejection messages identify the configuration entry, current list and scope. File existence, ordinary-file type and content hashes follow the send contract. Plan attachments and uploads still resolve their own file IDs. Size, deadline and concurrency limits are service contracts. Plugins use host APIs from their Manifest without another Profile permission grant; process isolation and package-origin checks still apply. Windows administrator rights, platform account permissions and unsupported device capabilities remain owned by their respective systems.

Installers, Host lifecycle and operations that only make sense locally still execute on the local PC. Remote business access does not disguise requests as local traffic. Camera capture, event subscriptions, Route enablement and user-configured approval workflows are feature choices and are not automatically enabled or deleted by this change.

QQ original-message, history and attachment reads reuse current connection authentication. Enabled, authenticated LAN Agent, Relay and P2P sources can call these APIs without a separate persona, workspace or Route grant. Proxy identity must be proven by the current connection; bare headers cannot impersonate an authenticated source, and in-flight responses must stop when the connection is revoked.

The `/api/internal/` persona projection endpoints bind Manager child processes to their current Route and persona identity. Ordinary Agents use the public persona APIs without projection credentials. Instance ID resets and Host lifecycle belong to the current installed Host; requests from another PC cannot become local Host commands.

QQ attachments and favorite stickers use HTTP(S) resource addresses returned by the selected NapCat, including CDN domains, explicit ports and resource redirects, without a built-in domain allowlist. User-configured HTTP(S) NapCat endpoints may be on a LAN or remote host; message, group-file and diagnostic reads impose no extra loopback restriction. Authenticated Relay/P2P reads reuse the original connection identity and lease.


Configure QQ reads through the Manager process environment and load changes through the normal Host lifecycle. The API catalog reports effective byte bounds. Absent or zero media-size settings impose no application quota; Node Buffer and actual memory capacity still apply. Invalid values identify the variable instead of silently falling back.

| Environment variable | Default and meaning |
| --- | --- |
| `RABIROUTE_QQ_JSON_MAX_BYTES` | `0`: no application byte quota for QQ upstream JSON responses |
| `RABIROUTE_QQ_MEDIA_MAX_BYTES` | `0`: no application attachment-byte quota |
| `RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES` | `0`: no application sticker-preview byte quota |
| `RABIROUTE_QQ_READ_TIMEOUT_MS` | `8000`: message-read deadline in milliseconds |
| `RABIROUTE_QQ_MEDIA_TIMEOUT_MS` | `30000`: attachment-read deadline in milliseconds |
| `RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS` | `10000`: preview deadline in milliseconds |
| `RABIROUTE_QQ_READ_CONCURRENCY` | `2`: simultaneous reads; busy responses identify this setting |
| `RABIROUTE_QQ_STICKER_COUNT` | `1000`: default/maximum favorites requested from NapCat; valid items actually returned are no longer locally truncated |

Byte quotas accept nonnegative safe integers. Deadlines accept 1–2147483647 milliseconds; counts and concurrency accept positive safe integers. The upstream favorites API has no cursor, so `completenessUnknown` / `potentiallyTruncated` remain; one response does not prove a complete collection. Caller cancellation still stops its request, and timeouts are reported separately from user-policy rejection.


QQ, Markdown and segmented-send settings are read by the feature that consumes each field. Invalid values return `READ_SETTING_INVALID` with the variable name. They do not prevent Manager startup or unrelated actions such as plain-text sends, and are never interpreted as unlimited quotas. Correct the process environment and reload through the normal Host lifecycle.

## Old configuration migration

For existing installations, 0.3.25 still accepts `writeEnabled`, `artifactReadTokenEnv`, `personaAutomationScriptsEnabled` and `codexHooks.onlyPrimaryPersonaCanSendMessages`. They no longer determine access: device control and local scripts are available, primary-only sending is disabled, and recording reads reuse connection authentication. The UI and new examples no longer provide these fields. Compatibility input remains only at configuration boundaries and is scheduled for removal in 0.4.0. Remove these fields during migration; use normal connection setup, automation configuration or `dryRun` rehearsal instead.

Older changelog entries describe behavior at their release date. Use this page and the running API for current operation.

### Markdown rendering and upload storage quotas

These are Manager process environment settings, applied after a restart through the normal Host lifecycle. Invalid values name the setting rather than silently using a default. Markdown quotas accept nonnegative safe integers; 0 means no application quota. Runtime memory, Chromium's actual rendering capacity and positive integer viewport range still apply. Quota errors include the setting, effective value, actual value and adjustment instructions.

| Setting | Default | Meaning |
| --- | --- | --- |
| `RABIROUTE_MARKDOWN_MAX_SOURCE_BYTES` | 0 | UTF-8 source bytes per segment |
| `RABIROUTE_MARKDOWN_MAX_HEIGHT` | 0 | Rendered image height in pixels |
| `RABIROUTE_MARKDOWN_MAX_PNG_BYTES` | 0 | Bytes per PNG |
| `RABIROUTE_MARKDOWN_MAX_MESSAGE_PNG_BYTES` | 0 | Combined Markdown PNG bytes per message |
| `RABIROUTE_MARKDOWN_TIMEOUT_MS` | 15000 | Browser startup, connection and each CDP operation deadline; 1–2147483647 milliseconds |
| `RABIROUTE_AGENT_UPLOAD_MAX_TOTAL_BYTES` | max(16 GiB, single-file quota) | Stored and reserved upload bytes |
| `RABIROUTE_AGENT_UPLOAD_MAX_FILES` | 100 | Stored and reserved upload count |
| `RABIROUTE_AGENT_UPLOAD_TTL_MS` | 86400000 | Retention for new uploads in milliseconds |

The three storage settings accept positive safe integers; existing files retain their original expiry. Set the single-file quota in WebGUI RabiLink → Configuration or `agentUploads.maxFileMiB` in `data/Config.json`. Its default is 2048 MiB; integers from 1 to 8589934591 are accepted (the upper bound comes from exact byte-count representation), with no extra 2 GiB clamp. Restart Manager after saving. Lowering new-upload admission does not mark previously accepted files as corrupt. Actual destination-platform responses determine whether that platform supports the file size.

QQ sticker previews preserve valid upstream `image/*` MIME types, including AVIF, BMP and SVG. Non-image responses and invalid MIME types fail explicitly. Client image rendering capabilities determine whether a format can be displayed; a fixed extension list no longer hides images.
