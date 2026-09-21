<!-- docs-language-switch -->
<div align="center">
English | <a href="./workbuddy-agent-adapter-plan.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# WorkBuddy as an Agent Endpoint

> Status: **implemented; the delivery path is verified end to end, credential setup is still one manual step**. The verified facts come from probing and testing a local WorkBuddy 5.5.6 installation. Session discovery, task-database reading, the standard resolver, credential reading and the delivery bridge have all landed and pass automated tests. Delivery was verified from a separate process with no `CODEBUDDY_*` environment variable: the message enters the bound task's conversation area, is executed by that same task owner, and same-id redelivery does not create a new task. Because the credential still has to be typed into a local file by hand and the desktop exposes no pairing handoff yet, `maturity` stays `experimental` and must not be raised to `verified`.
>
> Prerequisites: this plan follows [Standard Agent Endpoint Requirements](agent-adapter-standard-requirements.md) and is executed under `skills/create-rabiroute-agent-adapter/SKILL.md` and its [owner-first design gate](../skills/create-rabiroute-agent-adapter/references/owner-first-design-gate.md).

## 1. Goal and scope

Wire WorkBuddy (Tencent's AI office workbench) as a RabiRoute **agent endpoint**: after RabiRoute receives a message, it delivers the body into a user-configured WorkBuddy task (session), that task executes it for real, and the result returns through RabiRoute's existing callback chain.

This document covers only "RabiRoute to WorkBuddy delivery and discovery". It excludes:

- The reverse direction (WorkBuddy calling Rabi APIs through MCP / hooks): that is tool integration, not endpoint delivery, and needs its own design.
- Message ingress: WorkBuddy is not a messaging endpoint, so no adapter is added under `src/adapters/`.

### Agent thread bridge and pagination boundary

The WorkBuddy thread bridge supports listing, reading, and delivering to existing tasks. Creation, renaming, and opening remain owned by WorkBuddy Desktop. It does not claim plan-assistant, memory-consolidation, or lost-delivery-receipt recovery capabilities; maturity remains `experimental`.

The store intersects `allowedWorkspaces` with the optional single `workspace`, using one shared path-normalization rule, then orders by latest activity descending and task ID ascending. Workspace selection precedes both the 10,000-row read cap and `offset` / `limit` pagination. An empty allowlist adds no restriction. Query and archive filtering operate within that bounded inventory, so this is not an unlimited task catalog. Interleaved workspaces, identical titles, and larger offsets no longer produce holes caused by filtering a page in the bridge. Detail reads and exact-ID resolution use a parameterized single-row lookup independent of the discovery inventory's 10,000-row cap; workspace-conflict and archived-task checks remain in place.

Validation uses temporary SQLite databases and mock HTTP; it is not a new real-desktop delivery acceptance. Delivery still uses the single session gateway and fails closed when the owner is offline or the workspace differs, without starting a fallback runtime.

## 2. Gate zero: user-observable contract

| Requirement | Needed | Single source of truth | Acceptance evidence | Forbidden substitute |
| --- | --- | --- | --- | --- |
| Where the message appears | Yes | The conversation area of the bound WorkBuddy task | The delivered body appears verbatim in that task | Record readable, HTTP 202, SSE event received |
| How fast it is visible | Yes | Immediately while the session process is alive; otherwise fail closed | The task shows the message and run state after delivery | A background process finishing on its own, log output |
| Who executes the real message | Yes | That session process's agent runtime (same desktop owner) | The turn runs with that task's own model, tools and approvals | A separate headless `codebuddy -p` process standing in |
| Model/tool/permission source | Yes | That task's `sessions` row plus runtime registrations | Matches the actual task settings | Inferring from prompt text or another client |
| New session vs continuation | Yes | Full session ID | Two deliveries to the same ID create no second task | Fuzzy creation by name |
| WorkBuddy absent | Yes | Session process heartbeat file | Manager starts normally and reports an actionable state; no delivery, no fallback | Starting a backup runtime |
| RabiRoute absent | Yes | WorkBuddy itself | WorkBuddy cold-starts, exits and upgrades independently | Depending on RabiRoute ports or env vars |

## 3. Owners and lifecycle

| Object | Owner | Starts/stops it | Authoritative state | RabiRoute read | RabiRoute write | Failure impact |
| --- | --- | --- | --- | --- | --- | --- |
| Host/UI | WorkBuddy desktop app | User | `workbuddy.db`, renderer | Read-only | No | Delivery not visible |
| Runtime | One session process per session | Desktop app | `~/.workbuddy/sessions/<pid>.json` | Read-only | No | That session is undeliverable |
| Transport | Per-session HTTP gateway | Session process | `GET /api/v1/auth/status` | Read-only | No | 401, delivery fails |
| Session/task | Session process + `sessions` table | Desktop/user | `sessions.id` | Read-only | No | Resolver fails closed |
| Turn | Session process | Session process | Run status query / SSE | Read-only | No | Reports busy / unknown result only |
| Tools/approval | Session process | Session process | Runtime registrations | Read-only | No | Reports missing capability, never widens permissions |

Hard boundaries (existing project red lines):

- RabiRoute only probes and calls. It never starts, stops or restarts WorkBuddy or any session process.
- It never writes WorkBuddy user-level configuration, injects `CODEBUDDY_*` env vars, or modifies `app.asar` or the install directory.
- A readable session ID is not a live owner: ID readability plus heartbeat plus endpoint must all hold.
- One adapter, one real message path. No second fallback path.

## 4. Product shape

**Desktop-owner type**, same family as Codex. It differs from DSH in that DSH serves a session API from a standalone apiproxy, while each WorkBuddy **session process serves its own API**.

A CLI-type adapter is rejected: a headless `codebuddy -p` process cannot satisfy "the message appears in the user's existing task". It may only ever be a `stub` (manual relay), and must not coexist with the primary path.

## 5. Verified facts (WorkBuddy 5.5.6, local read-only probe)

### 5.1 Session process descriptor

`~/.workbuddy/sessions/<pid>.json` (a `manual-<name>.json` form also exists, with its own heartbeat timeout):

```json
{
  "pid": 63808,
  "sessionId": "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
  "cwd": "C:\\work\\example",
  "kind": "interactive",
  "url": "http://127.0.0.1:6762",
  "endpoint": "http://127.0.0.1:6762",
  "mode": "local",
  "version": "2.137.1",
  "hostname": "PC-20210412FKBD",
  "startedAt": 1789370850729,
  "lastHeartbeat": 1789372891850,
  "updatedAt": 1789372891862
}
```

This is the only readable "is the owner loaded" signal, equivalent to Codex Desktop IPC reachability. The port changes on every launch, which matches the project's existing rule against hardcoded Manager ports.

### 5.2 Task source of truth

`~/.workbuddy/workbuddy.db` (SQLite), mapping closely to the Codex state DB:

| Column | Meaning | Role in the resolver |
| --- | --- | --- |
| `id` | Session/task identity UUID | **Task identity**; internal dropdown value and persisted binding |
| `custom_title` | User-set name | Preferred source for the dropdown label (mirrors Codex sidebar `Name`) |
| `title` | Auto title from the first prompt | **Reference only; forbidden** as a dropdown label or for name lookups |
| `cwd` | Working directory | Normalized for disambiguation and pre-delivery validation |
| `status` | `working` / `completed` etc. | Runtime state display |
| `deleted_at` | Archive/delete marker | Decides the "archived ID leads to idempotent re-create" branch |
| `created_at` / `updated_at` / `last_activity_at` | Timestamps | `updatedAt` ordering to pick the single newest match |
| `mode` | `craft` / plan / ask | Display only, never identity |
| `model`, `thought_level`, `permission_mode` | Model and permissions | Read-only display, never set on the user's behalf |

The same database also holds `workspaces(path, last_opened_at)` as a workspace candidate source.

### 5.3 Session records

- `~/.workbuddy/projects/<workspace-slug>/<sessionId>.jsonl`: full conversation stream, usable for read-only history and receipt checks.
- `<sessionId>.meta.json` in the same directory: currently only `codebuddy.ai/hostKind` and `acpConnectionId`.

`<workspace-slug>` is a compressed working directory (for example `c-work-example`), so listing sessions per project can be done from the filesystem alone, but the filesystem is **not** the binding source of truth.

### 5.4 Per-session local HTTP gateway

Each session process listens on a loopback port and serves a page titled "CodeBuddy Code Remote Control". It is an Express service with a built-in OpenAPI 3.1 specification. Verified auth and endpoints:

Authentication:

- `GET /api/v1/auth/status` is public and returns `{"authEnabled":true,"authenticated":false}`.
- Every other `/api/v1/*` request without credentials returns `401 {"error":{"code":"AUTH_REQUIRED"}}`.
- Accepted forms (any one): `?password=<password>`, cookie `gateway_session=<hashedPassword>`, `Authorization: Bearer <password>`, a dedicated access-token header, or an HMAC signature (`x-signature` = HMAC-SHA256 of `x-timestamp` + `x-nonce` + body, inside a time window).
- `POST /api/v1/auth/login` with body `{"password":"..."}` returns `{"success":true,"token":"<Bearer token>"}` on success; an empty password returns `login.error.required`; 429 rate limiting applies.
- Credential source: the session process environment variable `CODEBUDDY_GATEWAY_PASSWORD`, injected by the desktop app. When that variable is absent the process falls back to the user-scoped setting `gateway.password`, generating and persisting a random value if missing. On this machine only the environment-variable path is active.

**Endpoints and message format (measured in S0, correcting the built-in OpenAPI spec)**

Use `Authorization: Bearer <gateway password>`. Every session process shares one password: the same credential returned `authenticated:true` on three separate gateways (1204, 2817, 3218), so it is generated per desktop rather than per session.

| Endpoint | Measured result |
| --- | --- |
| `GET /api/v1/auth/status` | Public; `{"authEnabled":true,"authenticated":<bool>}` |
| `POST /api/v1/auth/login` | Body `{"password"}`; returns `{"success":true,"token"}`; an empty password returns `login.error.required` |
| `GET /api/v1/info` | `{"cwd","version":"5.5.6","gatewayMode":"local","tunnelUrl",uptime,"userName"}` |
| `GET /api/v1/sessions?cwd=<absolute path>` | Defaults to the current working directory; `cwd=*` spans projects. Observed fields: `id`, `name`, `createdAt`, `updatedAt`, `messageCount`, `isCurrent`, `projectId`, `cwd` (drive letter lowercased), `status`, `isPlayground`, `isUserDefinedTitle` |
| `GET /api/v1/jobs/resumable` | `{"candidates":[{"sessionId","label","updatedAt"}],"hasMore","nextOffset"}`, paginated |
| `GET /api/v1/jobs/dispatch-context` | Dispatchable agent profiles (`cli` / `ptc` / `minimal` ...) plus `defaultAgentName` |
| `POST /api/v1/runs` | The external-gateway delivery entry. Returns `202 {"runId","status":"accepted"}` |
| `GET /api/v1/runs/{runId}` | `{"runId","active"}` |
| `GET /api/v1/jobs/events`, `GET /api/v1/jobs`, `GET /api/v1/tasks/templates` | SSE subscription, job list, scheduled-task templates |
| `GET /api/v1/instances`, `/api/v1/runs/{runId}/stream` | Returned 404 on the gateways probed here; availability must not be assumed |

The real body shape for `POST /api/v1/runs` (in code this is `handleWebhook`, the same entry used by WeCom/WeChat callbacks):

```json
{
  "id": "<message ID, required>",
  "type": "<type, required; \"action\" takes the action branch, anything else is a normal message>",
  "source": {
    "platform": "rabiroute",
    "sender": { "id": "<stable sender identity>" },
    "conversation": { "id": "<session routing key>", "type": "direct" }
  },
  "payload": { "text": "<body>", "attachments": [] }
}
```

Two things to remember:

1. The built-in OpenAPI spec's `{text, sender:{id,name}}` is **wrong**: without `id`/`type` the gateway returns `400 BAD_REQUEST: Invalid generic message format`. Defaults: `version`, `source` and `payload` may be omitted, `payload.text` may come from a top-level `text` or `prompt`, and `source.conversation.id` defaults to the message `id`.
2. **`source.conversation.id` is the session routing key.** The handler then calls `getOrCreateSession(source.conversation.id)`, so the same `conversation.id` reuses the same session. This turns P0's "continue the same ID, never create twice" into a native protocol capability: RabiRoute only has to pin `conversation.id` to the bound full `sessionId`.

What did not pass: a smoke message on a temporary conversation key returned `202` and `GET /runs/{runId}` reported `active:true`, yet within 30 seconds **no** new desktop task row appeared and nothing showed up in `sessions?cwd=*`. In other words the message was accepted and executed, but "lands in the user's existing task, executed by that task's owner, visible in the desktop task list" is still unproven — that is P0 #3 and the single blocking gap today.


### Why this side needs a credential while Codex does not

Codex delivery is not unauthenticated; its **trust is established by the transport**. `src/codexDesktopBridge.ts` connects to the Windows named pipe `\\.\pipe\codex-ipc` (on POSIX, `$TMPDIR/codex-ipc/ipc-<uid>.sock`) over a bare `net.Socket`, and the file contains no token, no Authorization header and no handshake — only processes of the same user on the same machine can open that pipe, so the kernel ACL is the credential.

Each WorkBuddy session exposes loopback HTTP only. The operating system does not distinguish callers, so any local process can connect, and the gateway must therefore authenticate at the application layer; otherwise any local script could drive the user's sessions. This is not an extra step bolted on, it is what the transport dictates:

- The session descriptor advertises an HTTP `url`/`endpoint` only, with no IPC address.
- Processes and ports agree: a session process (for example `sessions/62288.json` serving `127.0.0.1:1204`) listens on TCP.
- In practice `GET /api/v1/sessions` returns `401 AUTH_REQUIRED` even from loopback; `/api/v1/auth/status` is the only public endpoint and exposes nothing usable.

Requiring credentials for HTTP-based agent endpoints is already established in this project: the whole `src/dshHttpAuth.ts` module exists to obtain a DSH token (reading `dsh web: ...?token=` from the launch log and exchanging it for an HttpOnly cookie kept in memory), and AstrBot likewise needs an explicit session ID and credential. So the real open item is not "credential or not" but "how does a separate process obtain it once", with the credential confined to a local ignored file and an in-memory cache, never the repository.

Explicitly rejected alternative: setting WorkBuddy's `gateway.auth` to `none` to skip authentication. That is a security downgrade (any process on the machine could drive the session) and a host-configuration write, which RabiRoute must never perform; it is available only as a last resort if the user personally accepts the risk.

### 5.5 Verified delivery and redelivery (this test run)

After delivering with the bound real `sessionId` as `source.conversation.id`, the target's `~/.workbuddy/projects/<project-slug>/<sessionId>.jsonl` shows:

- A `type: "message" / role: "user"` record whose `parentId` points at the session's own previous assistant message and whose body matches the delivered text verbatim. It is a **genuine user turn**, not a side-channel job.
- An immediately following `role: "assistant" / status: "completed"` reply whose `providerData.model` is that session's own model (observed: `deepseek-v4.1-flash`), executed by the task's Agent Runtime.
- Two consecutive deliveries wrote to the **same** `<sessionId>.jsonl`, and the `sessions` table row count stayed unchanged (18 → 18), confirming that same-id redelivery not creating a new task is native protocol behaviour.

Reproduced from a separate process (critically, one **without** `CODEBUDDY_GATEWAY_PASSWORD`): after unsetting the variable, the gateway password was read from the local credential file alone, a live session process was discovered dynamically, delivery returned `202`, the task count stayed the same, and the message appeared in the target task. This proves neither the credential path nor the delivery path depends on a session process's environment.

The earlier "not proven" item was a **misdiagnosis**: it treated "a new task row appeared" as the success signal, but delivering into an existing task by ID is precisely why no new row should appear.

### 5.6 Credential acquisition (settled: local ignored file)

The desktop injects `CODEBUDDY_GATEWAY_PASSWORD` into every session process; RabiRoute Manager is a separate process and cannot read another process's environment. Implemented resolution order:

1. `RABI_WORKBUDDY_GATEWAY_PASSWORD` process environment (tests and wrapper scripts).
2. `{"password":"..."}` in `<state>/data/workbuddy-auth.json`, the same location and shape as `data/dsh-auth.json`, already covered by `.gitignore`.

When neither exists, delivery fails closed: it never sends an unauthenticated request and never replays a delivery rejected with 401. The file only has to be prepared once before the first delivery; after a password rotation the module re-reads on a 5-minute TTL or the first 401.

### 5.7 Implemented in this change

Landed and tested:

- `src/workbuddySessionStore.ts`: session descriptor reading (the `prewarm` pool's named pipe is metadata only), task-database reading, workspace normalization, and the standard resolver. `deliverable` requires all four of: process alive, heartbeat fresh, gateway address published, and kind not `prewarm`/`teammate`.
- `src/workbuddyHttpAuth.ts`: gateway credential reading and caching. Ordered multi-source resolution (environment → local ignored file); loopback-only; the credential stays in memory and a local file, never the repository or logs; 5-minute TTL plus immediate invalidation on 401.
- `src/workbuddySessionBridge.ts`: the **single real message path**. Binding read, pre-delivery owner/workspace revalidation, `POST /api/v1/runs` delivery, and `GET /runs/{runId}` settlement polling. Four outcomes are distinguishable: `unreachable` (safe to retry), `rejected` (not applied), `unauthorized` (not applied, never replayed), and `unknown` (may have applied — check the receipt first).
- `src/agentAdapters/workbuddyManagerApi.ts`: Manager-side scan/status (`installed`, `auth`, `endpoints`, `projects`, paginated `sessions`, `warnings`), including whether the local credential is configured.
- `workbuddy` is registered in `agentAdapterTypes` and the manifest with `maturity: experimental`, `transport: http/session-gateway`, `host: WorkBuddy Desktop (required)`, and declares `managedTasks.messageProcessingAgent` (delivery works) plus `managedTasks.hooks` (lifecycle hooks work). It does **not** declare plan assistants or memory consolidation — those paths go through the Codex/DSH thread driver — nor `deliveryReceiptRecovery`: the gateway returns a one-shot acceptance receipt and keeps no readable inbound log.
- Route binding mirrors DSH: `adapterConfig.json` stores only `workbuddySessionId` / `workbuddySessionName` / `workbuddyCwd` / `workbuddyEndpoint` (the last for display and fallback only — delivery always prefers the live address from the session descriptor). The credential is never written into route config.
- WebGUI: a WorkBuddy card in the agent list, a task dropdown with liveness, and workspace plus optional gateway-address fields.


### Hook integration (this delivery)

The WorkBuddy CLI core (CodeBuddy Code) exposes the same lifecycle-hook family as Codex: the same event names (`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`), the same `matcher` + `hooks[]` JSON shape, the same input contract (`session_id` / `transcript_path` / `cwd` / `hook_event_name` / `tool_name` / `tool_input`) and the same `hookSpecificOutput.additionalContext` output. The plugin declaration also lives in the plugin root's `hooks/hooks.json`; only the plugin-root variable is `${CODEBUDDY_PLUGIN_ROOT}` and the manifest directory is `.codebuddy-plugin/`.

**Confirmed by measurement** (local WorkBuddy 5.5.6 / CLI 2.137.1): after writing `hooks` into `~/.workbuddy/settings.json`, a headless session really did fire and execute the hook script, with `session_id`, `cwd` and `hook_event_name` present in the input JSON, and `CODEBUDDY_CONFIG_DIR` resolving to `~/.workbuddy`. The user-level settings file is therefore the reliable installation point on this machine. One contract difference is worth remembering: CodeBuddy honours `matcher` **only on `PreToolUse` / `PostToolUse`**; attaching a matcher to a lifecycle event makes that hook silently never fire.

**Implementation choice**: `plugins/rabi-workbuddy-context` is a plugin package isomorphic to `rabi-codex-context` (with `hooks/hooks.json` as the single declaration source), but installation does **not** go through the plugin CLI:

- A `codebuddy plugin` subcommand measured over ninety seconds per invocation (`--version` is fast, so the cost is the subcommand's own loading and checks), which would make the "update hooks" button an unacceptable wait;
- The CLI executable lives inside the WorkBuddy install directory (`resources/app.asar.unpacked/cli/bin/codebuddy`) and moves with every desktop upgrade, so it must not be written into long-lived configuration;
- The Manager is a separate process whose config-directory resolution when calling the CLI depends on environment variables.

So instead, `updateAgentHooks(rootDir, "workbuddy")` copies the packaged scripts to the stable path `<LOCALAPPDATA>\RabiRoute\agent-hooks\rabi-workbuddy-context\`, reads `hooks/hooks.json`, substitutes `process.env.CODEBUDDY_PLUGIN_ROOT` with that absolute path, and **merges** the result into `hooks` in `~/.workbuddy/settings.json`.

Merge semantics: only entries carrying the `rabi-workbuddy-hook.mjs` fingerprint are replaced; hooks the user wrote and every other settings key survive untouched; re-running is idempotent; a settings file that is not valid JSON is refused rather than overwritten. The plugin package still ships with the release, so a user who prefers `/plugin` management can run `codebuddy plugin marketplace add <install>/dist/agent-hooks` and install from there — both paths share one `hooks/hooks.json`.

**Difference from Codex/DSH**: those two install through their own plugin managers and let the plugin system inject the plugin root; WorkBuddy is configured directly in the user settings file by RabiRoute. The capability is equivalent (same five events, same context injection and completion reporting); only the installation vehicle differs, and it buys freedom from CLI startup cost and path coupling.

**Hook self-check boundary (candidate implementation, not production acceptance)**: writing configuration does not establish self-check health. The installer uses asynchronous Node `spawn` to run `--self-check`, with a default 20-second limit and a combined 64 KiB stdout/stderr limit. Timeout or cancellation must confirm child exit; the exit code takes precedence, so an output field of `ok:true` cannot override a nonzero exit. The script returns `ok:true` only for nonempty valid context through the existing client path, excluding known fail-open diagnostics. Empty responses (including empty context synthesized locally by a disabled helper) or `null` from `handleHookInput` mean only “no verifiable context; availability not confirmed” and exit nonzero; they do not establish that Manager is offline. This verifies context evidence, not complete Manager health, and does not prove that the host has loaded the Hook.

**Not yet verified**: Hook end-to-end validation on a real interactive task has not run. Already-open sessions must reload (restart the session if necessary) to read the new configuration. These candidate changes and isolated tests do not establish a build, deployment, or production release.

### 5.8 Open items and blockers

1. **Desktop visibility** (**resolved**, see 5.5): delivery enters an existing user task's conversation area and runs under the same owner with that session's own model; same-id redelivery creates no new task.
2. **Credential acquisition** (**settled, still one manual step**): RabiRoute Manager is a separate process and cannot read the session process's `CODEBUDDY_GATEWAY_PASSWORD`, so the operator records it once in `<state>/data/workbuddy-auth.json`. **Still open**: the desktop exposes no remote-control/pairing handoff yet, so this remains manual — the main reason maturity stays `experimental`.
3. **Credential rotation**: what triggers `regeneratePassword()` and how often is unknown; the current 5-minute TTL plus immediate invalidation on 401 means a rotation surfaces as one actionable failure rather than a misdelivery.
4. **Steer / queueing**: whether delivery during an active turn queues, steers, or reports busy. Two consecutive deliveries to one session are known not to create a new task and both do execute; the exact queueing semantics are not yet verified item by item.
5. **Idempotency keys**: none were observed on `/api/v1/runs`; RabiRoute must carry its own dedup ledger if needed.
6. **Endpoint inconsistency**: `/api/v1/instances` and `/runs/{runId}/stream` returned 404 on the gateways probed here, so the built-in OpenAPI spec includes endpoints that are disabled or mode-specific; integrations must not assume they exist. Neither endpoint is currently relied upon.

### 5.9 Capability mapping: whatever WorkBuddy has, Rabi must expose

"Whatever it has, we must have too" concretely means: every semantic the WorkBuddy gateway offers must have a named landing place in the Rabi adapter contract, and anything it cannot offer must be declared unsupported rather than overclaimed.

| WorkBuddy capability (measured) | Rabi adapter contract | Status |
| --- | --- | --- |
| `GET /sessions` (`id`/`name`/`cwd`/`updatedAt`/`status`/`isUserDefinedTitle`) | `listSessions(cursor/query)`, `readSession(id)` | **Implemented** (task-database reads, fields aligned) |
| `cwd=*` cross-project queries plus `projectId` | `listWorkspaces()`, workspace filtering | **Implemented** (`listWorkbuddyWorkspaces` plus normalized comparison) |
| `isUserDefinedTitle` separating user names from auto titles | Dropdown name source plus `userNamed` | **Implemented** (`custom_title` preferred; `title` is display/search only) |
| `jobs/resumable` (`hasMore`/`nextOffset`) | `sessionPage` pagination contract | **Implemented** |
| Session descriptor plus heartbeat | `health()`, owner-loaded detection | **Implemented** (process alive + fresh heartbeat + published endpoint) |
| `POST /runs` (gateway entry, `conversation.id` as routing key) | `send(sessionId, delivery)` | **Implemented** (`deliverWorkbuddyMessage`, fails closed, four distinguishable outcomes) |
| `GET /runs/{runId}` → `active` | `getTurnStatus(turnId)` | **Implemented** (`waitForWorkbuddyTurn` settlement polling; a timeout is not a failure) |
| CodeBuddy lifecycle hooks (`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`) | `updateAgentHooks(adapter)`, context injection, plan completion reporting | **Implemented** (`plugins/rabi-workbuddy-context` plus the user-settings installer; installation is measured, real-task end-to-end is pending — see the hook integration section) |
| SSE `/jobs/events`, `/runs/{runId}/stream` | Streaming events / `readResult` | Not implemented; 404 on some gateways, so availability must be probed before any claim |
| `jobs/{id}/reply` (live session delivers immediately, exited session stores a pending reply) | `steer` / `queue` | Not implemented (its semantics versus `/runs` need measuring) |
| Agent profiles from `dispatch-context` | Model/capability catalog display | Not wired; `modelInherited` does not map onto Rabi's model selection, so ownership must be decided first |
| `POST /auth/login`, `auth/status` | `auth` state and re-login entry | Partially implemented (`auth.required=true` plus wording; `loggedIn` stays unknown rather than guessed) |
| Session rename, delete, archived-session resume | — | To be decided; Rabi does not currently claim to rewrite host task metadata |
| Attachments (`payload.attachments`) | Inbound image/attachment support | Not implemented; evaluate after the delivery path is accepted |

The principle is unchanged: business and policy stay in Rabi, the host only supplies sessions and execution, and WorkBuddy's job system is never modelled as Rabi's plan or memory source of truth.


## 6. Single real message path

```text
RabiRoute event -> workbuddy adapter -> loopback HTTP (session gateway) -> session process for that sessionId -> turn -> desktop-visible result
```

The number of code paths that can execute real prompt text must be exactly 1. `readWorkbuddySession`, `scanWorkbuddy`, `health` and every read-only probe must never carry a body, and a test must hold that line.

## 7. Identity and resolver contract

Mapped to the six P0 requirements:

1. **Valid `sessionId`**: read the `sessions` row, confirm empty `deleted_at`, a normalized `cwd` matching the bound workspace, and a heartbeat in `sessions/<pid>.json`; then deliver to that exact ID without comparing `custom_title`, `title` or the task's default directory.
2. **Archived ID**: at a real delivery or save commit point only, create a new task under an idempotency key scoped to the old ID; never reuse another task with the same name. Scans and refreshes only report archive state.
3. **Empty/invalid/missing ID**: look up by `custom_title` plus normalized `cwd`; one or more candidates bind to the single newest by `updated_at`; a tie on the newest timestamp asks the user to choose; zero matches create once, and only when the name was entered explicitly.
4. **Save performs the switch**: the save commit point reuses the same resolver as real delivery and persists the full `sessionId`, name and workspace before reporting success.
5. **Renames and default-directory changes do not retarget**: changes to `custom_title`, `title` or the default `cwd` keep the same ID; when the user explicitly types a new name on the Rabi side, the UI clears the old ID first.
6. **Scan on demand**: one automatic scan on entering settings, then only explicit scan clicks. Expanding, typing, `blur`, saving, health polling and timers must never scan.

Create idempotency key: `agentProfile + normalizedWorkspace + requestedName`, single-flight, re-querying by that key whenever the create result is unknown.

## 8. Maturity

**`experimental`** (delivery works, the credential is configured by hand). It is registered in `src/shared/agentAdapterCapabilities.ts` and declares `managedTasks.messageProcessingAgent` plus `managedTasks.hooks`; it declares neither plan assistants nor memory consolidation (not adapted yet), nor `deliveryReceiptRecovery` (the gateway returns a one-shot acceptance receipt and keeps no readable inbound log). `verified` only after S5 cold-start verification and once the desktop pairing handoff exists.

```ts
// The declaration that landed (claims only what is already true)
workbuddy: {
  type: "workbuddy",
  label: "WorkBuddy (Tencent AI office workbench)",
  maturity: "experimental",
  transport: { protocol: "http", mode: "session-gateway" },
  host: { name: "WorkBuddy Desktop", required: true },
  // Only the two verified paths are declared: plan assistants and memory
  // consolidation go through the Codex/DSH thread driver, so neither is declared
  // until adapted — the UI then offers no panel whose call would necessarily
  // fail. The credential is still a manual step, so receipt recovery is not
  // declared either.
  capabilities: {
    managedTasks: {
      messageProcessingAgent: true,
      hooks: true
    }
  }
}
```

## 8.1 Credential setup (the one manual step before use)

Write to `<stateRoot>/data/workbuddy-auth.json` (already covered by `.gitignore`):

```json
{ "password": "<WorkBuddy session gateway password>" }
```

When it is missing, the scan reports an actionable note and delivery fails closed without ever sending an unauthenticated request. If it is present but rejected, update the file and retry — RabiRoute will not replay a delivery that was rejected with 401.

## 9. Code entry points

| File | Change |
| --- | --- |
| `src/shared/agentAdapterCapabilities.ts` | Add `workbuddy` to `agentAdapterTypes` and `manifestsByAgentType` |
| `src/agentAdapters/types.ts` | No extra branch; the shared `parseAgentAdapterType` covers it |
| `src/workbuddySessionBridge.ts` (new) | Discovery, resolver, delivery, result reading; mirrors `src/dshSessionBridge.ts` |
| `src/workbuddyHttpAuth.ts` (new) | Credential acquisition and caching; mirrors `src/dshHttpAuth.ts` (stores endpoints and source paths, never credentials) |
| `src/workbuddyWorkspaces.ts` (new) | Working-directory collection and normalized comparison |
| `src/agentAdapters/workbuddyAdapter.ts` (new) | Interface-based adapter, registered in `builtinAgentAdapters.ts` |
| `src/agentAdapters/workbuddyManagerApi.ts` (new) | `scanWorkbuddyAgent` / `getWorkbuddyStatus` / `openWorkbuddy`, aggregated by `managerApi.ts` |
| `src/agentAdapters/managerApi.ts` | Aggregate the new endpoint into `/api/scan/agents` as `agents.workbuddy` |
| `src/manager.ts` | Wiring only; no WorkBuddy-specific logic |
| `ribiwebgui/src/types.ts`, `pages/RouteConfigPage.vue`, `components/QuickSetupDialog.vue` | Agent card, parameter panel, status and action buttons |
| `README.md`, `docs/configuration.md`, `docs/current-capabilities.md` | User-visible guidance and maturity wording |

Delivery binding follows the DSH shape: the route's `adapterConfig.json` holds `workbuddySessionId` / `workbuddySessionName` / `workbuddyCwd` / `workbuddyEndpoint`. **Credentials never go into route config**; they live in a local ignored file, mirroring how `data/dsh-auth.json` stores only endpoints and source paths.

Landed (checked) versus pending:

- [x] `src/workbuddySessionStore.ts` (new) — descriptors + task database + normalization + resolver
- [x] `src/workbuddySessionStore.test.ts` (new) — 8 cases, including regressions for the real data shapes
- [x] `src/workbuddyHttpAuth.ts` (new) — credential reading and caching, loopback restriction, TTL and invalidation
- [x] `src/workbuddySessionBridge.ts` (new) — binding resolution, pre-delivery validation, delivery, settlement polling
- [x] `src/workbuddySessionBridge.test.ts` (new) — 12 cases: body shape, routing key, 401/unreachable/no-runId/empty-body, timeout, binding and fail-closed
- [x] `src/agentAdapters/workbuddyManagerApi.ts` (new) — `scanWorkbuddyAgentAdapter`, including credential-configured status
- [x] `src/agentAdapters/workbuddyManagerApi.test.ts` (new) — 3 cases: listing sessions in the real shapes, paging and filtering, and an actionable empty result on a clean machine
- [x] `src/shared/agentAdapterCapabilities.ts` — type and manifest (declares `managedTasks.messageProcessingAgent` and `hooks`, not plan assistants, memory consolidation or `deliveryReceiptRecovery`)
- [x] `plugins/rabi-workbuddy-context/` — the WorkBuddy hook package (`.codebuddy-plugin/plugin.json` + `hooks/hooks.json` + `scripts/`), isomorphic to `rabi-codex-context`
- [x] `src/agentAdapters/hookInstallation.ts` — WorkBuddy install branch (copy to a stable path + merge into `~/.workbuddy/settings.json`; idempotent, preserves user hooks, refuses to overwrite invalid JSON)
- [x] `.codebuddy-plugin/marketplace.json` + `scripts/build-agent-hook-packages.mjs` — the plugin marketplace ships with the release
- [x] `src/agentAdapters/managerApi.ts` — aggregated into `agents.workbuddy`, options and type exports
- [x] `src/agentAdapters/builtinAgentAdapters.ts` — wired to `notifyWorkbuddySession`
- [x] `src/manager/messageProcessingDeliveryTarget.ts`, `src/forwarding.ts` — primary-persona delivery target supports `workbuddy`
- [x] `src/shared/gatewayConfigModel.ts`, `src/config.ts` — binding fields, normalization and loopback validation
- [x] `src/shared/agentInstance.ts` — instance-binding allowlist now includes `workbuddy`
- [x] `ribiwebgui/` — agent card, task dropdown with liveness, workspace and gateway-address fields
- [x] Rounded out this change's wording in `README.md`, `docs/README.md`, `docs/current-capabilities.md`, `版本更新日志.md`


## 10. Staged implementation

| Stage | Work | Exit criteria (evidence required) |
| --- | --- | --- |
| **S0 Probe** | Temporary script answering the open questions; read-only plus one harmless smoke message | **Complete**: auth model, session-list fields, `runs` body shape, the `conversation.id` routing key and the credential resolution order are all confirmed |
| **S1 Minimal vertical slice** | Discover one real task, deliver one marked message, see it **in the desktop task** | **Passed**: the message is written into the target `<sessionId>.jsonl` as a genuine user turn, executed by that task with its own model, and reproduced from a separate process without the environment variable |
| **S2 Repeat to same ID** | Deliver a second message to the same ID | **Passed**: both deliveries land in the same session file; task count stays 18 → 18 |
| **S3 Negative cases** | Owner absent, archived ID, cwd conflict, expired credential | Covered by unit tests (unreachable / 401 / no runId / empty body / owner absent / no binding); not yet staged one by one against a real gateway |
| **S4 WebGUI** | Card, parameter panel, scan, diagnostics, action buttons | Card and parameter panel landed; scan counts satisfy P0 #6; dirty config never written |
| **S5 End-to-end and cold start** | RabiRoute stopped, WorkBuddy cold-starts; WorkBuddy stopped, Manager starts | Not done: needs verification on a real Manager process, including rediscovery after a restart |
| **S6 Docs and maturity** | README, configuration, current capabilities, bilingual sync; raise to `verified` if earned | Docs match code; the build passes. Raising to `verified` requires S5 plus a working desktop pairing handoff |

If any stage requires a second execution path, a user-level configuration write, or evidence that only proves a readable record, stop and return to the design gate.

## 11. Acceptance test matrix

Inheriting section 9 of the standard requirements and the skill's verification list, WorkBuddy must at least cover:

- Session listing: every result reachable beyond the default page size; `cwd=*` agrees with per-directory queries.
- Name disambiguation: identical `custom_title` plus identical `cwd` picks the newest by `updated_at`; ties ask the user; `title` changes never break same-ID continuation.
- Idempotency: concurrent saves create one task; retrying right after a create whose list has not refreshed returns the same ID; timeouts re-query first.
- Delivery: two deliveries to one session create no second task; an active turn queues or reports busy explicitly; unknown result is distinguishable from a definite failure.
- Scan counting: entering settings adds one, an explicit scan click adds one; expanding, typing, `blur`, saving and idling add none.
- Cold start: each side starts and stops independently.
- Security: `git diff` confirms no user-level env var, registry, WorkBuddy config or install-directory changes; no credential in logs, examples or the repository.

## 12. Security and privacy

- Credentials exist only in a local ignored file or an in-memory cache with expiry and re-acquisition; never in the repository, examples, logs or build output.
- Loopback endpoints only; non-loopback addresses are rejected so a local launch credential can never leak to a remote host.
- Reads stay inside allowed roots; no traversal of unrelated user documents.
- Delivered bodies and screenshots stay out of public bundles; diagnostics redact everything but the port.
- RabiRoute's Action Gate and WorkBuddy's own approvals stay independent; a WorkBuddy denial must never be bypassed.

## 13. Risks and stop conditions

| Risk | Handling |
| --- | --- |
| Credential unobtainable outside the process | No delivery code until S0 resolves it; if only the host can hand it over, review that separately as a minimal host enhancement limited to credential handoff |
| Undocumented gateway API that shifts between versions | Declare `versionSensitive`; concentrate endpoint probing in `workbuddyHttpAuth.ts` and the bridge; run the same contract tests before and after upgrades |
| Delivery lands in a "job" rather than the user's task | Judge it as failing P0 #3, keep `experimental`, state the gap, and do not degrade into a background runtime |
| Conflict with WorkBuddy's built-in IM channels | Never take over or rewrite WorkBuddy's wechat/wecom channel configuration; RabiRoute only delivers |

Stop conditions (matching the design gate): needing a second runtime to hide an error, needing a user-level environment or host startup-configuration write, tests that only prove a readable record, or an inability to point at the single place where real message text executes.

## 14. Relationship to existing docs

- [Standard Agent Endpoint Requirements](agent-adapter-standard-requirements.md): the standard this plan implements.
- [Agent adapter integration: history, boundaries, verification](agent-adapter-integration-lessons.md): why these boundaries exist.
- [DSH web session bridge authentication](dsh-browser-auth.md): the existing precedent for local launch-credential acquisition.
- [Configuration and integration](configuration.md): how users configure existing adapters.
- `skills/create-rabiroute-agent-adapter/SKILL.md`: turns the standard into an execution workflow.
