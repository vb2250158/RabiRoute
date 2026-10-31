<!-- docs-language-switch -->
<div align="center">English | <a href="./video-api-contract.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Executable media workspace API contracts

> Status: source migration and isolated tests. Full builds, installed applications, physical peers, model installation and actual generation are confirmed separately.

`io.rabiroute.manager.video` registers 35 contracts from one executable definition set: 34 fixed method/path pairs and one native dynamic model proxy. Fixed endpoints contain 23 JSON operations, two SSE operations and nine native HTTP exchanges; the dynamic proxy adds one exchange. Execution and active discovery use the same definitions. The old boolean/prefix dispatcher, project HTTP wrapper and dedicated HTTP tracker are removed.

The packaged manifest declares `manager.core@1`, `host.manager.http@1`, `host.manager.video@1` and `host.manager.operations@1`. The HTTP service still owns native JSON reading and Manager event publication; the operations service registers these contracts. Lifecycle regression tests load that manifest and let the real kernel check dependencies and `context.services.require()`. They verify rejection of an omitted declaration, restoration of all 35 contracts after correcting it, and no job recovery or contract publication when the provider is missing.

## Endpoints and native owners

Every path below starts with `/api/video`. Counts are method/path pairs.

| Feature | Methods and paths | Count |
| --- | --- | --- |
| Projects | GET/POST `/projects`; GET/PUT `/projects/:mediaId` | 4 |
| Workspace status/runtime | GET `/status`; POST `/runtime/start`, `/runtime/stop` | 3 |
| Workspace jobs | GET/POST `/jobs`; GET `/jobs/:mediaId`; POST `/jobs/:mediaId/cancel`; GET `/jobs/:mediaId/image`, `/video` under that job | 6 |
| Workspace assets | POST `/assets`; GET `/assets/:mediaId` (native media or `metadata=1`) | 2 |
| Models | GET `/models`, `/models/initialization`; POST `/models/initialize`; GET/PATCH `/models/settings`; POST `/models/runtime`, `/models/:modelId/download` | 7 |
| Compute status/runtime | GET `/compute/status`; POST `/compute/runtime/start`, `/compute/runtime/stop` | 3 |
| Temporary compute assets | POST `/compute/assets`; DELETE `/compute/assets/:mediaId` | 2 |
| Compute jobs | POST `/compute/jobs`; GET/DELETE `/compute/jobs/:mediaId`; GET `/compute/jobs/:mediaId/image`, `/video`, `/events` under that job (events is SSE) | 6 |
| Compute notifications | GET `/compute/events` (SSE) | 1 |
| Dynamic model exchange | Any actual HTTP method and raw path starting with `/models`, using the selected `computeDeviceId` and original peer JSON owner | One dynamic contract |

`VideoService` retains queues, job files, keys, generation state and output ownership. `VideoModels` retains model directory revisions and installation/download operations. `VideoAssets` retains assets and inspection state; `VideoProjects` retains project IDs, contents and revisions. `RemoteVideoCompute` retains the selected peer protocol, temporary inputs and receipt recovery. Processes still use native `createVideoRuntime()` and process leases.

Candidate activation only reads job and model settings snapshots. It creates no shared directories, rewrites no unfinished jobs and does not replace the media inspection script. After publication, `lifecycle.mjs` waits for the previous activation's actual requests, jobs and process lease cleanup, then reloads current records before recovery and shared component preparation. All 35 endpoints return native 503 while this startup is pending; this is a readiness state, not an additional permission. Failed candidate cleanup does not persist its read-only job copies, and the old activation remains callable. Model settings are reloaded after the old owner drains, preserving its final receipts and configuration revisions.

The plugin creates its functional owner inside the currently activated module and passes it to `createVideoOperations()`. The common factory does not statically load another plugin implementation, avoiding error-class or owner-module identity splits across hot updates. Original `video:METHOD:/api/video/...` discovery IDs derive from fixed definitions, retaining `:mediaId`. The dynamic branch had no such discovery ID, so it receives no invented legacy alias.

## Field contracts and compatible validation

`contracts.mjs` is the plugin source for command fields, project rules and model settings fields. `workflow.validateCommand` re-exports its exact validator; project owners use its ID, card-kind, count and title rules; model owners use its field sets, revision and layout rules. The current activation passes these definitions to the common factory. Discovery and OpenAPI describe project, job, status, directory, installation and space-plan fields instead of a shared empty schema for stable DTOs.

Input schemas describe fields, defaults and limits while the same native validators retain rejection behavior: original project-ID string coercion, title clipping, nullish command defaults, persisted canvas extensions and native 409 for unknown model-setting fields or revision errors. The parser adds no coercion, field removal or defaults, and does not replace these native errors with framework 400. Named validators expose these conditions; this does not claim JSON Schema alone enforces every constraint.

Canvas drafts/extensions, catalog/provider extensions, raw uploads and selected-peer model JSON remain owned by their original services. Peer results have an explicit open alternative, avoiding local model DTO restrictions on peer JSON. Local and remote response completeness remain distinct. Purged compute receipts may omit prompts, progress and other removed fields.

## Dynamic model exchange

Contract 35 uses `method: "*"`, `/api/video/models:suffix` and explicit `pathRemainder: "suffix"` to retain native `startsWith('/models')`, including `/modelsXYZ`, empty suffixes and nested paths. Generic clients must provide the actual method. Exact contracts for that method take precedence; the dynamic contract handles remaining requests before a known path returns 405. OpenAPI represents it with `x-rabiroute-any-method`.

With `computeDeviceId`, the exchange calls the same `RemoteVideoCompute.json()` using the original pathname. It does not replace dynamic forwarding with a finite feature list. POST/PATCH use the original 4-KiB JSON reader; other methods ignore request bodies. Peer JSON remains intact, including ordinary `metadata` and `frames` properties. Such fields are not interpreted as workspace asset wrappers or file streams. Native peer errors remain owned by that service. Without a selected peer, unknown model operations retain native local 404 behavior, without switching to local compute.

Original ingress target constraints still apply; authenticated Agents cannot use encoded separators to bypass target validation. These are resource correctness constraints, not feature grants. Authenticated enabled connections use all public endpoints by default. Personas, plans, skills and model discovery add no permission layer. Native read-only mode, fixed disks, model roots, processes, queues and resource ownership remain enforced.

## Bodies, state and recovery

Project creation retains 4 KiB, project saves 64 MiB, job submission 25 MiB and model JSON 4 KiB. Raw assets retain the native PNG 9-MiB, MP4 64-MiB and WAV 16-MiB limits and inspection flow. Uploads are not converted to JSON/base64 or made dependent on a local inference installation when the native remote inspection path is selected.

Projects use native revision saves and model settings use expectedRevision. Jobs retain original 8–128-character `Idempotency-Key` semantics: identical intent returns the original job; changed intent conflicts, including a changed compute target. Compute receipts remain separate from workspace history. Purged outputs retain minimal receipts without executing inference again. Existing retention work triggered by compute reads remains in the native service.

Fixed JSON decoding uses the common parser, with 400/413 for malformed/oversized bodies; native owners still validate fields and business rules. Dynamic models and two conditional-body exchanges retain the original reader. Local POST `/models/runtime` and `/models/:modelId/download` ignore bodies; selected peers require 4-KiB JSON, so these remain native exchanges. Discovery describes these boundaries without claiming to enumerate every model workflow or provider field.

Admission captures the original connection before reading a body and retains native queue, filesystem, process and network checks. Re-enabling a revoked Node does not revive its request. The original access owner can retain trusted dispatch evidence through common `mutationOutcome: "unknown"` errors; pre-dispatch failures use `not_started`. Business results remain hidden and no rollback is implied. Accepted generation, installation or downloads remain owned by the plugin lifecycle without retaining initiating request permissions. Recovery inspects the original project, key, workspace job and peer receipt, without replay or changing computers automatically.

## Media, SSE and retirement

Media opens the native owner-approved local path, retaining MIME, filenames, single/suffix Range, 200/206/416, Content-Length and Content-Range. Assets support PNG, MP4 and WAV; job outputs select PNG or MP4 from the original model. Client disconnect, backpressure or retirement cancels and joins the original file. Cancellation while stat is pending prevents creating its raw reader.

Both SSE endpoints retain native publish notifications and job views. Model changes send `compute`; jobs send `progress` and finish at terminal state. Original 20-second heartbeats and comment frames remain raw SSE bytes, rather than becoming new business events. Subscription limits remain native; a bounded queue prevents unbounded slow-consumer memory. Retirement removes subscriptions/timers and ends iteration. Subscriptions created but not disclosed are also canceled on rejection.

Plugin disposal retires both registrations, closes subscriptions and native probe/model/service owners, then joins requests and background cleanup. Peer JSON receives the same cancellation signal while waiting for headers; retirement joins the original upstream instead of leaving detached HTTP work.

## Evidence limits

Tests use native temporary project/job/asset files, controlled media inspection/runtime drivers, the real registrar, an enrolled empty Node and owned HTTP peers. They cover reopening and CAS, original-key replay/conflict, three media kinds and Range, compute ownership/purging, SSE completion/cancellation, Node ABA, backpressured retirement, dynamic methods/paths, conditional bodies, native error identity and uncertain mutation evidence.

No real inference, model download, installation, external service or message is executed. Source and isolated tests do not establish GPU quality, generated visuals, a released package or physical cross-machine acceptance. See the [media workspace guide](video-generation-plugin_en.md) and [target architecture](api-contract-discovery-target-architecture_en.md).
