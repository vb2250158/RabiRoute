<!-- docs-language-switch -->
<div align="center">
English | <a href="./performance-monitoring.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Resident performance recording and inspection

> Audience: local operators and project maintainers. Use this feature to retain recent evidence for sustained slowdowns, memory growth, and slow requests in Manager, Gateway, or the browser UI.

## Enable and inspect

1. Open RibiWebGUI and go to **Performance**.
2. Enable performance recording, then set the sample interval, retention period, disk limit, and slow-operation threshold.
3. Save the settings. Manager and the current browser apply them immediately. Running Gateways read the new settings within 30 seconds.
4. The page shows CPU, memory, garbage collection, API P95, event-loop delay, internal hotspots, HTTP hotspots, collector status, and recent JSON records.

Recording is disabled by default. Disabling it stops new samples; existing files remain subject to retention and disk cleanup.

Performance pages read bounded Manager memory directly: recent raw records are capped at 1,000 rows and 16 MB total, while 10-second, 1-minute, and 5-minute incremental summaries cover at most 48 hours. Samples not yet flushed to JSONL appear immediately. A 720-hour retention setting affects disk files only; Manager does not restore or keep every raw sample resident.

## Plugin updates and shutdown

A performance plugin candidate only prepares its operations and resources. A failed candidate or rollback before publication does not replace the HTTP recording hook or start or stop the current collector. The kernel's `context.publication` transaction switches the hook, then starts the shared collector. Successful updates and revision rollbacks retain the same collector and operation sink without reinitialization.

Once the old version stops accepting requests, it cancels and joins its original event subscriptions, heartbeats, stream generators, and admitted operations. An HTTP timeout response, disconnected client, or plugin cleanup timeout does not prove that work has released its resources. The shared collector stops only after the last published version's actual work has joined. Delayed old cleanup cannot clear the new HTTP hook. Startup failure after publication uses the plugin runtime-failure flow; it is not reported as a rollback before publication.

## Discovering API fields

The current performance operation contracts expose the five config input fields, single-sample and `{samples: [...]}` shapes, the `rangeMs`/`limit` query fields, and system, HTTP, frontend, and slow-operation metrics in existing responses. Config defaults, Number conversion, rounding, and bounds come directly from the native normalization definitions.

Input structure supports discovery while preserving arbitrary JSON: non-object config acts as an empty patch, unknown fields are ignored, and native sample admission returns accepted/rejected counts. No required-field or field-type rejection is added. Queries still use the first value and native conversion; empty and repeated parameters keep their behavior.

Known metric fields are listed, but native sample admission does not deeply validate optional metrics or `pid`. Those values continue to accept existing opaque content. Discoverable fields do not imply complete deep validation; coverage and precision claims remain conservative.

## File location and format

Performance records are separate from ordinary runtime logs:

```text
data/.runtime/performance/performance-YYYY-MM-DD-HH.jsonl
```

Each hourly file contains one complete JSON object per line. These files are local runtime data and must not be committed. Example:

```json
{"schemaVersion":1,"kind":"performance_sample","sampleId":"...","time":"2026-08-17T08:00:00.000Z","intervalMs":5000,"source":{"kind":"manager","id":"manager","runtimeId":"...","pid":1234},"system":{"cpuPercent":4.2,"rssBytes":146800640,"heapUsedBytes":73400320,"heapTotalBytes":94371840,"externalBytes":2097152,"eventLoopP50Ms":10.1,"eventLoopP95Ms":12.6,"eventLoopMaxMs":18.4,"eventLoopUtilization":0.03,"gcCount":1,"gcDurationMs":2.4,"gcMaxMs":2.4},"http":{"operation":"all","count":21,"errorCount":0,"totalMs":146.2,"p50Ms":4.8,"p95Ms":31.2,"maxMs":46.7,"totalBytes":482100,"operations":[]},"operations":[{"operation":"manager.http.json_serialize","count":21,"errorCount":0,"totalMs":18.6,"p50Ms":0.4,"p95Ms":3.1,"maxMs":4.2}]}
```

`source.kind` values:

- `manager`: Manager process CPU, memory, event loop, and HTTP requests.
- `gateway`: CPU, memory, event loop, and HTTP requests for each Gateway process.
- `webgui`: Manager API timing, navigation timing, and browser long tasks from an open page.

`operations` contains low-cardinality internal phases and never includes task, role, or message IDs. Current coverage:

- Manager: metadata and Gateway payload construction, JSON serialization, plan catalog cache/refresh, read-worker queue and execution, Desktop readiness and task-catalog stages inside Agent discovery, message-board summary/persistence, shared RabiSpeech status flights, health/capability probes, and performance summary generation.
- Gateway: route decisions, AgentPacket construction, message registration, Agent delivery, and complete forwarding.
- Shared runtime path: JSONL history appends and history-file scans used to deduplicate voice or Feishu messages.
- WebGUI: route navigation through two completed animation frames.

The page ranks internal phases and HTTP endpoints by accumulated time. HTTP rows also show accumulated response bytes, separating expensive computation from oversized responses. Recorder append, summary, file-write, and cleanup timings are shown separately so monitoring overhead remains visible.

`/api/events` and `/api/speech/events` are persistent event streams. Their connection lifetime is excluded from HTTP latency, P95, and slow-request metrics because it does not represent Manager processing time. The top Manager cards use the most recently reporting Manager runtime; pre-restart runtimes remain only in the timeline and details.

## Performance risks to check first

| Symptom | Inspect first | Common cause |
| --- | --- | --- |
| `/gateways` or `/api/gateways` slows down | `manager.gateways.build_*`, `manager.http.json_serialize`, accumulated response bytes | More diagnostics are read while building status, or the response object has grown too large |
| Voice history or conflict checks wait intermittently | `manager.read_worker.queue_wait.*`, `manager.read_worker.execute.*` | Worker concurrency is exhausted, or a directory scan/parse has become expensive |
| Agent discovery is slow | `manager.agent_scan.desktop_ready`, `manager.agent_scan.codex_catalog`, `manager.read_worker.*.agent_scan`, `/api/scan/agents` response bytes | Desktop readiness or the task-catalog service is slow; the catalog stage is capped at eight seconds, after which the page continues with a retryable warning |
| Recent-memory reads are slow | `manager.read_worker.*.role_memory_*` | A large memory directory; enumeration, Markdown/JSON parsing, and `viewedAt` writes run in a Worker |
| The message board response is oversized | `manager.message_board.summary`, `/api/message-processing/board` response bytes | The list returns only UI summary fields; complete evidence is read from the requirement-detail API |
| The first speech-status request is slow | `manager.speech.status.cache_hit`, `manager.speech.status.shared_flight`, `manager.speech.probe.health`, `manager.speech.probe.capabilities` | Cold RabiSpeech health checks or model capability discovery; concurrent callers share one probe and adjacent calls reuse a 500 ms status result |
| The plan page is slow on first open | `manager.plan_catalog.cold_load`, `manager.plan_catalog.refresh`, `manager.plan_catalog.cache_hit` | Cold enumeration and parsing, or frequent file changes causing refreshes |
| The event loop spikes while processing messages | `runtime.history.append`, `runtime.history.duplicate_scan`, event-loop P95 | Synchronous JSONL writes, or deduplication scanning a growing history file |
| Routing completes but the reply is delayed | `gateway.forward.message_register`, `gateway.forward.agent_deliver.*`, `gateway.forward.total` | Manager registration, Desktop/Agent delivery, or the external handler is waiting |
| Page navigation stutters | `webgui.route_render.*`, browser long tasks, JS heap | Expensive component rendering, main-thread long tasks, or browser memory pressure |
| All endpoints slow down briefly | GC duration, event-loop P95, CPU | Garbage collection, CPU contention, or a synchronous main-thread phase |

Compare HTTP timing, internal phases, event-loop delay, and GC in the same interval. If HTTP slows down while internal phases remain normal, inspect network, browser, or caller-side waiting next.

Query strings are removed and common dynamic IDs are replaced before paths are recorded, preventing per-task or per-message metric names. Performance files can still reveal API names, process IDs, and local runtime timestamps, so treat them as diagnostic material before sharing.

## Configuration limits

| Setting | Range | Default |
| --- | --- | --- |
| Sample interval | 1–60 seconds | 5 seconds |
| Retention | 1–720 hours | 48 hours |
| Maximum disk use | 16–4096 MB | 256 MB |
| Slow-operation threshold | 100–120000 ms | 2000 ms |

Manager checks expired files and the disk limit every hour. When the limit is exceeded, it removes the oldest performance files first. Memory is separately capped at 20,000 time buckets and 50,000 operation entries per tier, 10,000 deduplication IDs, 1,024 source snapshots, and 100 slow operations. Operation names beyond 64 in one bucket are merged into `__other__`.

## APIs

RibiWebGUI uses these Manager APIs:

- `GET /api/performance/config`: read settings.
- `PATCH /api/performance/config`: save settings.
- `POST /api/performance/batches`: submit Gateway and WebGUI sample batches.
- `GET /api/performance/summary?rangeMs=...`: read downsampled trends and slow operations.
- `GET /api/performance/logs?limit=...`: read recent raw records.
- `GET /api/performance/status`: read file count, disk use, pending writes, and errors.
- `GET /api/performance/events`: receive new-sample notifications for page refresh.

The seven operations are installed and discovered from the same executable API contracts. Their stable IDs are `manager.performance.config.read`, `config.save`, `batches.append`, `summary.read`, `logs.read`, `status.read`, and `events.subscribe` (the latter six share the `manager.performance.` prefix). Enabled authenticated remote connections can call these public operations without another feature grant. Gateway samples still require loopback provenance and an existing Gateway ID; authenticated remote connections can submit WebGUI samples. Injected Manager samples are rejected.

Configuration PATCH bodies are limited to 16 KiB and batch submissions to 1 MiB. Both retain native JSON decoding and configuration/sample validation. Read configuration back after saving; there is no CAS or request-level idempotency key. Batch status 202 acknowledges memory admission rather than disk persistence; inspect `status` for persistence. Native sample deduplication is bounded, so inspect the original `sampleId` before resubmitting an uncertain request.

The event stream starts with `ready` (3000 ms retry interval), sends `sample` notifications containing `time` and `source`, and emits a keepalive comment every 15 seconds. Each connection has at most 256 queued frames, with a 4096-byte frame limit; overflow disconnects a slow consumer. Disconnect or plugin retirement cancels the original subscription, stops the heartbeat, and joins iterator cleanup. Notifications have no durable replay cursor; reconnect and refresh summary or recent logs.

## Main-thread protection

- `/api/scan/agents` performs directory probes, task reads, and result construction in a bounded low-priority child process. Concurrent identical requests share one scan. The Codex Desktop task-catalog stage is capped at eight seconds; a timeout stops the short-lived metadata process and returns partial discovery results.
- Codex Desktop tasks default to pages of 200. The UI loads later pages on demand instead of constructing and serializing a multi-megabyte response at once.
- Recent and consolidated memory enumeration, parsing, lifecycle projection, and viewed-time writes run in low-priority read child processes.
- The message-processing board list omits attachments, local paths, raw reply context, and full evidence. The detail endpoint provides those fields when needed.
- Concurrent status requests for the same RabiSpeech URL share one probe, and adjacent calls reuse a 500 ms status result, so multiple pages do not duplicate the same `/health` and `/v1/capabilities` batch.
- Performance summaries read 10-second, 1-minute, and 5-minute in-memory aggregates. Recent raw records are capped at 1,000 rows and 16 MB total; responses return at most 1,000 rows, and an invalid `limit` uses the default 100. Page queries do not flush or parse JSONL.
- Read child processes for memory and Agent scans remain resident between requests and reuse module caches. All pools share a process-wide budget of two low-priority heavy tasks. `executionMode`, `workerPids`, `globalActive`, and `globalMaxConcurrency` expose isolation and the shared budget, while `workers` and `spawnedWorkers` reveal unexpected restarts.
- During startup, Manager scans only JSONL shards intersecting the configured retention and the maximum 48-hour query range, then builds aggregates one line at a time. Older long-retention files are not parsed.
- When child-process concurrency or queue limits are exhausted, Manager returns a retryable error instead of moving the work back onto the HTTP main thread.

## Diagnosing gaps

- Collector shown as offline: no sample arrived within three sample intervals. Confirm that the process is still running.
- File count or disk use does not change: confirm recording is enabled, then inspect the page error and `/api/performance/status` `lastError`.
- Request timing exists but CPU does not: the WebGUI collector is working, while the Manager or Gateway collector is not reporting.
- Short spike: use the 15-minute range. For sustained growth, use the 6-hour or 24-hour range.

This system retains recent trends and slow-operation evidence. It does not produce flame graphs and does not replace an operating-system profiler.
