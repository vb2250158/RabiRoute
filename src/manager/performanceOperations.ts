import { errorResponsePresentation } from "../shared/errorPresentation.js";
import type { ApiOperationContract, ApiOperationDefinition, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";
import { PerformanceApi, PERFORMANCE_EVENT_LIMITS } from "./performanceRoutes.js";
import { performanceMonitoringConfigRules, type PerformanceSample, type PerformanceSystemMetrics,
  type FrontendPerformanceMetrics, type PerformanceOperationSummary, type PerformanceSlowOperation,
  type PerformanceSeriesPoint } from "../shared/performanceContract.js";

const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const string = { type: "string" } as const;
const number = { type: "number" } as const;
const integer = { type: "integer", minimum: 0 } as const;
const boolean = { type: "boolean" } as const;
function object(properties: Record<string, ApiSchema>, required = Object.keys(properties)): ApiSchema {
  return { type: "object", required, properties, additionalProperties: true };
}
const array = (items: ApiSchema): ApiSchema => ({ type: "array", items });
// Both branches together accept every JSON value. Object/array structure is discovery metadata,
// not a second validator for native merge/coercion or per-item rejection counts.
const metadataObject = (properties: Record<string, ApiSchema>, description?: string): ApiSchema => ({ ...(description ? { description } : {}),
  anyOf: [{ type: "object", properties }, { not: { type: "object" } }] });
const metadataArray = (items: ApiSchema): ApiSchema => ({ anyOf: [{ type: "array", items }, { not: { type: "array" } }] });
const observedNumber = { description: "Normally a number. Native sample ingress does not validate this optional metric; existing values remain accepted.", examples: [0] };
const observedString = { description: "Normally a string; native sample ingress leaves this optional metadata unvalidated." };
const operationFields = { operation: observedString, count: observedNumber, errorCount: observedNumber, totalMs: observedNumber,
  p50Ms: observedNumber, p95Ms: observedNumber, maxMs: observedNumber, totalBytes: observedNumber, maxBytes: observedNumber
} satisfies Record<keyof PerformanceOperationSummary, ApiSchema>;
const systemFields = { cpuPercent: observedNumber, rssBytes: observedNumber, heapUsedBytes: observedNumber,
  heapTotalBytes: observedNumber, externalBytes: observedNumber, eventLoopP50Ms: observedNumber, eventLoopP95Ms: observedNumber,
  eventLoopMaxMs: observedNumber, eventLoopUtilization: observedNumber, gcCount: observedNumber, gcDurationMs: observedNumber, gcMaxMs: observedNumber
} satisfies Record<keyof PerformanceSystemMetrics, ApiSchema>;
const frontendFields = { page: observedString, navigationMs: observedNumber, longTaskCount: observedNumber, longTaskMaxMs: observedNumber,
  jsHeapUsedBytes: observedNumber, jsHeapLimitBytes: observedNumber } satisfies Record<keyof FrontendPerformanceMetrics, ApiSchema>;
const slowFields = { time: observedString, operation: observedString, durationMs: observedNumber, kind: observedString,
  statusCode: observedNumber, requestId: observedString } satisfies Record<keyof PerformanceSlowOperation, ApiSchema>;
const sourceMetadata = metadataObject({ kind: { description: "Native admission accepts webgui, or gateway with an existing local Gateway and loopback provenance. Manager injection is rejected.", examples: ["webgui", "gateway"] },
  id: { description: "Native validator requires a nonempty string up to 256 characters." },
  runtimeId: { description: "Native validator requires a nonempty string up to 256 characters." },
  pid: { description: "Opaque optional metadata; native validator does not constrain pid." } });
const sampleFields = {
  schemaVersion: { description: "Native sample admission requires literal 1.", examples: [1] }, kind: { description: "Native sample admission requires performance_sample.", examples: ["performance_sample"] },
  sampleId: { description: "Nonempty string up to 512 characters; native bounded deduplication uses this value." },
  time: { description: "String up to 64 characters accepted by Date.parse; native validation owns invalid-date rejection." },
  intervalMs: { description: "Native admission requires a finite number of at least 1000; not coerced." }, source: sourceMetadata,
  system: metadataObject(systemFields), http: metadataObject({ ...operationFields, operations: metadataArray(metadataObject(operationFields)) }),
  operations: metadataArray(metadataObject(operationFields)), frontend: metadataObject(frontendFields),
  slowOperations: metadataArray(metadataObject(slowFields))
} satisfies Record<keyof PerformanceSample, ApiSchema>;
const configInputFields = Object.fromEntries(Object.entries(performanceMonitoringConfigRules).map(([key, rule]) => [key, {
  description: "conversion" in rule ? rule.conversion
    : `Native Number(value), then finite check, Math.round and clamp to ${rule.minimum}..${rule.maximum}; nonfinite values fall back to ${rule.default}. Omitted fields retain current config.`,
  examples: [rule.default]
}]));
const configInput = metadataObject(configInputFields, "Any JSON is accepted. Objects merge with current config; other JSON acts as an empty patch. Unknown fields are ignored; normalization belongs to the native owner.");
const batchInput = metadataObject({ ...sampleFields, samples: metadataArray(metadataObject(sampleFields)) },
  "Any JSON is decoded. An array-valued samples field selects per-item admission; otherwise the body is one candidate. Native validation, enabled state, provenance and deduplication determine accepted/rejected counts; optional metric values are not structurally validated.");
const config = object({ enabled: boolean, sampleIntervalMs: integer, retentionHours: integer, maxDiskMb: integer, slowOperationMs: integer });
const source = object({ kind: { enum: ["manager", "gateway", "webgui"] }, id: string, runtimeId: string,
  pid: { description: "Optional native metadata; the existing sample validator does not constrain pid." } }, ["kind", "id", "runtimeId"]);
const status = object({ enabled: boolean, loaded: boolean, logDirectory: string, pendingRecords: integer, retainedRecords: integer, fileCount: integer,
  diskBytes: integer, droppedRecords: integer, summaryCacheHits: integer, lastPersistedAt: string, lastError: string,
  lastAppendDurationMs: number, lastSummaryDurationMs: number, lastFlushDurationMs: number, lastCleanupDurationMs: number },
  ["enabled", "loaded", "logDirectory", "pendingRecords", "retainedRecords", "fileCount", "diskBytes", "droppedRecords", "summaryCacheHits"]);
const sample = object({ ...sampleFields, schemaVersion: { const: 1 }, kind: { const: "performance_sample" }, sampleId: string, time: string, intervalMs: number, source },
  ["schemaVersion", "kind", "sampleId", "time", "intervalMs", "source"]);
const pointFields = { time: observedString, source: sourceMetadata, cpuPercent: observedNumber, rssBytes: observedNumber,
  heapUsedBytes: observedNumber, eventLoopP95Ms: observedNumber, eventLoopMaxMs: observedNumber, eventLoopUtilization: observedNumber,
  gcCount: observedNumber, gcDurationMs: observedNumber, gcMaxMs: observedNumber, requestCount: observedNumber, errorCount: observedNumber,
  requestP95Ms: observedNumber, requestMaxMs: observedNumber, longTaskCount: observedNumber, longTaskMaxMs: observedNumber, jsHeapUsedBytes: observedNumber
} satisfies Record<keyof PerformanceSeriesPoint, ApiSchema>;
const point = object({ ...pointFields, time: string, source, gcCount: integer, requestCount: integer, errorCount: integer, longTaskCount: integer },
  ["time", "source", "gcCount", "requestCount", "errorCount", "longTaskCount"]);
const operation = object({ ...operationFields, operation: string, count: integer, errorCount: integer, totalMs: number, p50Ms: number, p95Ms: number, maxMs: number, source },
  ["operation", "count", "errorCount", "totalMs", "p50Ms", "p95Ms", "maxMs", "source"]);
const summary = object({ generatedAt: string, rangeMs: number, bucketMs: number, config, status,
  sources: array(object({ source, lastSeenAt: string, online: boolean, latest: metadataObject(pointFields) }, ["source", "lastSeenAt", "online"])), points: array(point), httpOperations: array(operation), hotOperations: array(operation),
  slowOperations: array(object({ ...slowFields, time: string, operation: string, durationMs: number, source }, ["time", "operation", "durationMs", "source"])) });
const error = { mediaType: "application/json", schema: object({ code: { const: -1 }, message: string }) } as const;
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const envelope = (data: ApiSchema) => object({ code: { const: 0 }, data });
const result = (body: unknown): ApiOperationResult => ({ status: 200, headers: { "cache-control": "no-store" }, body });
const failure = (status: number, reason: unknown): ApiOperationResult => ({ status, body: errorResponsePresentation({ code: -1, message: reason instanceof Error ? reason.message : String(reason) }, status) });

/** These declarations install every performance route and power discovery from the same owner. */
export function createPerformanceOperations(owner: PerformanceApi): readonly ApiOperationDefinition[] {
  const define = (operationId: string, method: ApiOperationContract["method"], suffix: string, description: string,
    responses: ApiOperationContract["responses"], handler: ApiOperationDefinition["handler"], options: {
      body?: ApiOperationContract["request"]["body"]; query?: ApiSchema; transport?: "http" | "sse"; effects?: string; recovery?: string;
    } = {}): ApiOperationDefinition => {
    const run: ApiOperationDefinition["handler"] = async input => {
      owner.assertActive(); input.signal?.throwIfAborted();
      try { return await handler(input); }
      catch (reason) {
        // A store/config write may already have happened; the common registry reports unknown write failures as uncertain.
        if (method !== "GET") throw reason;
        return failure(500, reason);
      }
    };
    return { contract: { operationId: `manager.performance.${operationId}`, contractVersion: "1.0.0", method, pathTemplate: `/api/performance/${suffix}`,
      exposure: "public", transport: options.transport ?? "http", description,
      request: { path: empty, query: options.query ?? ignored, headers: ignored, body: options.body ?? { kind: "none" } }, responses: { "400": error, "500": error, ...responses },
      effects: { mode: options.effects ? "write" : "read", description: options.effects ?? "Read the original performance service's bounded in-memory state without flushing or starting read workers." },
      recovery: { strategy: options.effects ? "inspect-before-retry" : "repeatable-read", description: options.recovery ?? "Read the same current state again. Samples are bounded and may expire; this is not a historical archive query." },
      validators: [{ id: "native-performance-owner", description: "The original service owns normalization, sample validation/deduplication, retained memory and storage. Ordinary authenticated remote connections require no per-feature grant. Query conversion preserves native first-value Number conversion and defaults." }]
    }, prepare: () => { owner.assertActive(); return run; }, handler: run };
  };
  const batch = object({ code: { enum: [0, -1] }, accepted: integer, rejected: integer });
  return [
    define("config.read", "GET", "config", "Read the active performance recording configuration.", { "200": json(envelope(config)) }, () => result({ code: 0, data: owner.config() })),
    define("config.save", "PATCH", "config", "Merge supplied values into current performance configuration, normalize, persist and apply to the original collector.", { "200": json(envelope(config)) }, input => result({ code: 0, data: owner.saveConfig(input.body) }), {
      body: { kind: "json", maxBytes: 16 * 1024, allowAnyContentType: true, emptyValue: {}, schema: configInput },
      effects: "Persist global performance config and update the original store and collector immediately; changes affect recording and retention.",
      recovery: "Read /api/performance/config and compare normalized values before retrying. There is no idempotency key or CAS; a later patch can overwrite fields changed by another writer."
    }),
    define("batches.append", "POST", "batches", "Submit a sample or {samples: [...]} and receive native accepted/rejected counts. A 202 acknowledges memory admission, not disk persistence.", { "202": json(batch), "400": json(batch) }, input => {
      const body = owner.ingest(input.body, input.request); return { status: body.accepted ? 202 : 400, body };
    }, { body: { kind: "json", maxBytes: 1024 * 1024, allowAnyContentType: true, emptyValue: {}, schema: batchInput },
      effects: "Append accepted samples to the original bounded store and emit sample notifications; asynchronous persistence follows existing store lifecycle.",
      recovery: "Read logs or summary for the original sampleId before resubmitting an uncertain batch. Native deduplication is bounded, so replay after expiry is not guaranteed idempotent."
    }),
    define("summary.read", "GET", "summary", "Read in-memory trends, sources, operations and slow records; rangeMs defaults to one hour and native bounds are one minute to 48 hours.", { "200": json(envelope(summary)) }, input => result({ code: 0, data: owner.summary(input.url.searchParams.get("rangeMs")) }), {
      query: object({ rangeMs: { description: "First query value only; Number(first value || one-hour default), then native summary clamping to one minute..48 hours. Empty/missing and NaN use one hour; positive/negative infinity clamp to the upper/lower bound. Unknown and repeated keys remain accepted." } }, []) }),
    define("logs.read", "GET", "logs", "Read recent in-memory raw samples, including pending records; limit defaults to 100, invalid numbers use 100, native bounds are 1 to 1000.", { "200": json(object({ code: { const: 0 }, data: array(sample), status })) }, input => result(owner.logs(input.url.searchParams.get("limit"))), {
      query: object({ limit: { description: "First query value only; Number(first value || 100), nonfinite fallback 100, Math.trunc then native bounds 1..1000. Unknown and repeated query keys remain accepted." } }, []) }),
    define("status.read", "GET", "status", "Read the original performance store status and active configuration.", { "200": json(object({ code: { const: 0 }, data: status, config })) }, () => result(owner.status())),
    define("events.subscribe", "GET", "events", "Subscribe to ready and sample notifications from the original performance store. Events contain time/source only and are not a durable replay log.", { "200": { mediaType: "text/event-stream", stream: {
      framing: "sse-json", maxFrameBytes: PERFORMANCE_EVENT_LIMITS.frameBytes,
      frameSchema: { oneOf: [object({ event: { const: "ready" }, retry: { const: 3000 }, data: empty }), object({ event: { const: "sample" }, data: object({ time: string, source }) }), object({ comment: string })] },
      completion: "Client disconnect, original owner retirement or bounded notification queue overflow; no event IDs or replay cursor.",
      cancellation: `Stop the original store subscription and ${PERFORMANCE_EVENT_LIMITS.keepAliveMs}ms heartbeat, unblock the iterator and drain to EOF before releasing its operation lease. At most ${PERFORMANCE_EVENT_LIMITS.queuedFrames} pending notifications; overflow closes the connection.`
    } } }, () => ({ status: 200, headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" }, stream: owner.events() }), { transport: "sse", recovery: "Reconnect for a fresh ready event and read the current summary/logs; disconnected notifications are not replayed." })
  ];
}
