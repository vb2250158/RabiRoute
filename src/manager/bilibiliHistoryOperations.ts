import type { ApiOperationContract, ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "./apiOperationContract.js";
import { API_ENDPOINT, BILIBILI_HISTORY_BODY_BYTES, MAX_PAGE_ITEMS, MAX_JOB_PAGES, BilibiliHistoryBridge, type PageSubmission } from "./bilibiliHistoryBridge.js";

const empty = { type: "object", additionalProperties: false } as const;
const ignored = { type: "object" } as const;
const string = { type: "string" } as const, number = { type: "number" } as const;
const count = { type: "integer", minimum: 0 } as const;
const nullable = (schema: ApiSchema) => ({ anyOf: [schema, { type: "null" }] });
const array = (items: ApiSchema) => ({ type: "array", items });
const object = (properties: Record<string, ApiSchema>, required = Object.keys(properties)): ApiSchema => ({ type: "object", properties, required, additionalProperties: true });
const map = { type: "object", additionalProperties: number } as const;
const cursor = object({ max: { anyOf: [number, string] }, view_at: number, business: string });
const summary = object({ itemCount: count, consumedSeconds: number, completedCount: count, activeDays: map, businessCounts: map, tagCounts: map, authorCounts: map, themeCounts: map },
  ["itemCount", "consumedSeconds", "activeDays", "businessCounts", "tagCounts", "authorCounts", "themeCounts"]);
const job = object({ id: string, roleId: string, createdAt: string, updatedAt: string, sinceEpoch: number, untilEpoch: number,
  timezoneOffsetMinutes: number, status: { enum: ["queued", "running", "completed", "failed", "paused"] }, cursor, pagesProcessed: count,
  pageDelayMs: number, lastError: string, summary, persistence: object({ recordCount: count, activeDays: map, lastPersistedAt: string }) },
  ["id", "createdAt", "updatedAt", "sinceEpoch", "untilEpoch", "timezoneOffsetMinutes", "status", "cursor", "pagesProcessed", "pageDelayMs", "lastError", "summary"]);
const index = object({ schemaVersion: { const: 1 }, recordClass: { const: "private-bilibili-history-date-shards" }, action: { const: "date-partition" },
  updatedAt: string, totalRecordCount: count, days: array(object({ date: string, file: string, recordCount: count, firstViewedAt: number, lastViewedAt: number })) });
const record = object({ schemaVersion: { const: 1 }, recordId: string, localDate: string, timezoneOffsetMinutes: number, firstCapturedAt: string, lastCapturedAt: string,
  sourceJobIds: array(string), viewedAt: number, title: string, uri: string, authorName: string, progress: number, duration: number, history: ignored },
  ["schemaVersion", "recordId", "localDate", "timezoneOffsetMinutes", "firstCapturedAt", "lastCapturedAt", "sourceJobIds", "viewedAt"]);
const success = (properties: Record<string, ApiSchema>, required?: string[]) => object({ code: { const: 0 }, ...properties }, required ? ["code", ...required] : undefined);
const json = (schema: ApiSchema) => ({ mediaType: "application/json", schema });
const failure = json(object({ code: { const: -1 }, error: string }));
const headers = Object.freeze({ "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "cache-control": "no-store" });
const body = (schema: ApiSchema): ApiOperationContract["request"]["body"] => ({ kind: "json", schema, maxBytes: BILIBILI_HISTORY_BODY_BYTES, emptyValue: {}, allowAnyContentType: true });

/** One declaration owns registration and discovery; the bridge retains state, file writes and producer identity. */
export function createBilibiliHistoryOperations(owner: BilibiliHistoryBridge): readonly ApiOperationDefinition[] {
  const define = (id: string, method: ApiOperationContract["method"], suffix: string, description: string, responses: ApiOperationContract["responses"],
    handler: (input: ApiOperationInput) => ApiOperationResult, options: { path?: ApiSchema; body?: ApiOperationContract["request"]["body"]; producer?: boolean; effects?: string; recovery?: string; remainder?: string; pathCaseInsensitiveLiterals?: readonly string[] } = {}): ApiOperationDefinition => {
    const run: ApiOperationDefinition["handler"] = input => {
      input.signal?.throwIfAborted();
      const refused = owner.admit(input.request, options.producer);
      if (refused) return { ...refused, headers };
      const result = handler(input);
      return { ...result, headers: { ...headers, ...result.headers } };
    };
    return { contract: { operationId: `manager.bilibili-history.${id}`, aliases: [`bilibili-history:${method}:/api/bilibili-history/${suffix}`], contractVersion: "1.0.0", method, pathTemplate: `/api/bilibili-history/${suffix}`,
      exposure: "public", transport: "http", description,
      request: { path: options.path ?? empty, query: ignored, headers: ignored, body: options.body ?? { kind: "none" }, ...(options.remainder ? { pathRemainder: options.remainder } : {}),
        ...(options.pathCaseInsensitiveLiterals ? { pathCaseInsensitiveLiterals: options.pathCaseInsensitiveLiterals } : {}) },
      responses: { "400": failure, "401": failure, "403": failure, "404": failure, "409": failure, ...responses },
      effects: { mode: options.effects ? "write" : "read", description: options.effects ?? "Read the original bridge state or the selected persona's private history records; no Bilibili network request or browser action is performed by Manager." },
      recovery: { strategy: options.effects ? "inspect-original-state" : "repeatable-read", description: options.recovery ?? "Read again for current state; do not create another history job to recover a query." },
      validators: [{ id: "native-history-owner", description: "Retain native role existence, date/time normalization, fixed-extension identity, request size and durable per-role storage. Enabled authenticated Manager connections need no new feature grant. Existing browser producer tokens authenticate next/page submissions, not a new Manager permission." }]
    }, prepare: input => {
      const refused = owner.admit(input.request, options.producer);
      if (refused) return { ...refused, headers };
      const assertOriginal = owner.captureAdmission();
      return current => { assertOriginal(); return run(current); };
    }, handler: run };
  };
  const role = object({ roleId: string });
  return [
    define("bridge.pair", "POST", "bridge/pair", "Pair the fixed browser extension once or recover its existing producer token for the same extension ID; an optional Origin must match chrome-extension://<extensionId>.", { "200": json(success({ token: string })) },
      input => owner.pair(input.body as { extensionId?: string }, String(input.request.headers.origin ?? "").trim()), {
        body: body(object({ extensionId: { description: "Native String conversion followed by trim; must be exactly 32 lowercase letters a-p." } }, [])),
        effects: "May persist the original bridge's extension ID and generated private producer token. The token is returned only by pairing and never appears in status or public jobs.",
        recovery: "Retry pairing only for the same fixed extension ID; it returns the existing token without replacing the pairing. A different ID receives BRIDGE_ALREADY_PAIRED. Do not log the returned token."
      }),
    define("status.read", "GET", "status", "Read sanitized bridge status and the latest 20 jobs. Excludes the producer token, last-page idempotency key, per-record bookkeeping and raw titles/URLs.",
      { "200": json(success({ paired: { type: "boolean" }, bridge: nullable(object({ extensionId: string, pairedAt: string, lastSeenAt: string })), jobs: array(job) })) }, () => owner.status()),
    define("roles.days.read", "GET", "roles/:roleId/days", "Read the selected persona's daily history index, rebuilt in memory from private date shards without rewriting the index file.",
      { "200": json(success({ roleId: string, index })) }, input => owner.days(input.path.roleId), { path: role, pathCaseInsensitiveLiterals: ["roles", "days"] }),
    define("roles.day.read", "GET", "roles/:roleId/days/:date", "Read one persona-private date shard, newest first; offset defaults to 0 and limit to 100 (bounded 1..500) using native Number/truncation.",
      { "200": json(success({ roleId: string, date: string, total: count, offset: count, limit: count, records: array(record) })) }, input => owner.day(input.path.roleId, input.path.date, input.url.searchParams),
      { path: object({ roleId: string, date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }), pathCaseInsensitiveLiterals: ["roles", "days"] }),
    define("jobs.create", "POST", "jobs", "Queue a bounded time-window browser history job for an existing persona. Manager does not access the signed-in website; the paired extension supplies pages.",
      { "202": json(success({ job })) }, input => owner.createJob(input.body as Parameters<BilibiliHistoryBridge["createJob"]>[0]), {
        body: body(object({ roleId: {}, since: {}, until: {}, pageDelayMs: {}, timezoneOffsetMinutes: {} }, [])),
        effects: "Persist a new queued job with a unique ID; keep the most recent 100 jobs. Raw history details are stored only in the target persona's private date shards when pages later arrive.",
        recovery: "There is no job-creation idempotency key. Retain the returned job ID; on uncertain results inspect status and the original time window before creating another job."
      }),
    define("jobs.read", "GET", "jobs/:jobId", "Read the original durable job and sanitized aggregate/persistence progress by its stable ID.", { "200": json(success({ job })) }, input => owner.job(input.path.jobId), { path: object({ jobId: string }), pathCaseInsensitiveLiterals: ["jobs"] }),
    define("bridge.next", "GET", "bridge/next", "The existing authenticated browser producer claims the next queued job or resumes the running one; despite GET this updates durable state.",
      { "200": json(success({ job: nullable(object({ id: string, endpoint: { const: API_ENDPOINT }, sinceEpoch: number, untilEpoch: number, cursor, pageSize: { const: MAX_PAGE_ITEMS }, pageDelayMs: number })) })) },
      input => owner.next(input.request), { producer: true, effects: "Update bridge lastSeenAt; change the original queued job to running and persist before returning its fixed read-only Bilibili endpoint/cursor.",
        recovery: "With the same producer identity, next resumes the running job. Inspect that original job before fetching or submitting another page; do not start another browser worker implicitly." }),
    define("bridge.page", "POST", "bridge/page", "Accept one page from the existing browser producer, deduplicate records into the original persona's date shards, and advance or stop the original job.",
      { "200": json(success({ done: { type: "boolean" }, status: { enum: ["running", "completed", "paused", "failed"] }, nextCursor: cursor, waitMs: number }, ["done", "status"])) },
      input => owner.submitPage(input.body as PageSubmission, input.request), { producer: true,
        body: body(object({ jobId: {}, pageKey: {}, code: {}, message: {}, items: {}, nextCursor: {} }, [])),
        effects: `Persist at most ${MAX_PAGE_ITEMS} submitted items in the requested time window to persona-private date shards; update aggregate/cursor/page progress. -101 and -412 pause immediately, other nonzero codes fail; stop at empty pages, boundary crossing, unchanged cursor or ${MAX_JOB_PAGES} pages.`,
        recovery: "Inspect the original job and private date records before resubmitting. Same last pageKey avoids duplicate page accounting; stable record IDs deduplicate overlapping pages. Multi-file persistence is not an atomic transaction, so reconcile the original job after an uncertain failure."
      }),
    define("options", "OPTIONS", ":remainder", "Preserve preflight for every path under /api/bilibili-history/, including unknown and empty suffixes; no wildcard Access-Control-Allow-Origin is added.",
      { "204": { mediaType: "application/json", schema: false } }, () => ({ status: 204 }), { path: object({ remainder: string }), remainder: "remainder" })
  ];
}
