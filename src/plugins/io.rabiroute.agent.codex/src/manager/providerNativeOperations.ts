import { createHash } from "node:crypto";
import type { ApiOperationDefinition, ApiOperationInput } from "@rabiroute/host-api/manager/apiOperationContract";
import { readCodexDesktopThread, listCodexNativeSessionPage } from "../codexDesktopBridge.js";
import { readCodexRolloutLines, statCodexRollout, type CodexRolloutSource } from "../codexRolloutReader.js";

type ThreadSource = {
  id: string;
  title?: string;
  cwd?: string;
  updatedAt?: string | number;
  archived?: boolean;
  rolloutPath?: string
};
type Cursor = {
  version: 1;
  sessionId: string;
  source: string;
  offset: number;
  sequence: number;
  size: number;
  modified: number
};
type HistoryOptions = { cursor?: string; limit?: number; maxBytes?: number; signal?: AbortSignal };

export class CodexNativeReadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function positive(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new CodexNativeReadError(400, "CODEX_HISTORY_PARAMETER_INVALID", "Page limit and maxBytes must be positive safe integers.");
  return result;
}
function sourceIdentity(source: CodexRolloutSource): string {
  return createHash("sha256").update(JSON.stringify([source.physicalPath, source.stat.dev, source.stat.ino, source.stat.birthtimeMs])).digest("hex");
}
function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString("base64url"); }
function decode(value: string | undefined, sessionId: string): Cursor | undefined {
  if (!value) return undefined;
  let cursor: Cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); }
  catch {
    throw new CodexNativeReadError(400, "CODEX_HISTORY_CURSOR_INVALID", "Use the cursor returned by this exact session history.");
  }
  if (cursor.version !== 1 || cursor.sessionId !== sessionId || typeof cursor.source !== "string" || ![cursor.offset, cursor.sequence, cursor.size, cursor.modified].every(Number.isFinite)
    || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0) {
    throw new CodexNativeReadError(400, "CODEX_HISTORY_CURSOR_INVALID", "Use the cursor returned by this exact session history.");
  }
  return cursor;
}

/** Plain pages seek to returned record boundaries; immutable compressed sources are decoded once per source stamp. */
export class CodexNativeHistoryReader {
  private readonly archives = new Map<string, readonly string[]>();
  constructor(private readonly readThread: (sessionId: string) => ThreadSource | null | undefined = readCodexDesktopThread) { }

  async read(sessionId: string, options: HistoryOptions = {}) {
    options.signal?.throwIfAborted();
    const thread = this.readThread(sessionId);
    if (!thread || thread.id !== sessionId) throw new CodexNativeReadError(404, "CODEX_SESSION_NOT_FOUND", "The exact Codex session was not found.");
    if (!thread.rolloutPath) throw new CodexNativeReadError(404, "CODEX_HISTORY_UNAVAILABLE", "This Codex session has no recorded native history source.");
    const source = await statCodexRollout(thread.rolloutPath);
    const identity = sourceIdentity(source), cursor = decode(options.cursor, sessionId);
    if (cursor && (cursor.source !== identity || source.stat.size < cursor.size || source.stat.size === cursor.size && source.stat.mtimeMs !== cursor.modified || source.physicalPath.endsWith(".zst") && (cursor.size !== source.stat.size || cursor.modified !== source.stat.mtimeMs))) {
      throw new CodexNativeReadError(409, "CODEX_HISTORY_SOURCE_CHANGED", "The native history source changed. Read a fresh first page for this session.");
    }
    const limit = positive(options.limit, 50), maxBytes = positive(options.maxBytes, 262144);
    let offset = cursor?.offset ?? 0, sequence = cursor?.sequence ?? 0, scanned = 0, bytes = 0, hasMore = false, pendingTail = false;
    const entries: Array<{ sequence: number; record: unknown }> = [];
    const warnings: Array<{ sequence: number; errorCode: string }> = [];
    const firstSequence = sequence + 1;
    const accept = (line: string, nextOffset: number, terminated: boolean): boolean => {
      if (!terminated) { pendingTail = true; hasMore = true; return false; }
      if (scanned >= limit) { hasMore = true; return false; }
      let record: unknown;
      try { record = JSON.parse(line.replace(/^\uFEFF/, "")); }
      catch {
        scanned++;
        sequence++;
        offset = nextOffset;
        warnings.push({ sequence, errorCode: "CODEX_HISTORY_ROW_INVALID" });
        return true;
      }
      const size = Buffer.byteLength(line);
      if (bytes + size > maxBytes) {
        if (!scanned) throw new CodexNativeReadError(413, "CODEX_HISTORY_EVENT_TOO_LARGE", `The next complete native event requires ${size} bytes. Set maxBytes to at least that value to read it without truncation.`);
        hasMore = true;
        return false;
      }
      scanned++;
      sequence++;
      bytes += size;
      offset = nextOffset;
      entries.push({ sequence, record });
      return true;
    };
    if (source.physicalPath.endsWith(".zst")) {
      const stamp = `${identity}:${source.stat.size}:${source.stat.mtimeMs}`;
      let cached = this.archives.get(stamp);
      if (!cached) {
        const rows: string[] = [];
        for await (const line of readCodexRolloutLines(thread.rolloutPath, sessionId, {
          signal: options.signal,
          verifyIdentity: true,
          requireTerminatedRecords: true,
          onSource: opened => {
            if (sourceIdentity(opened) !== identity || opened.stat.size !== source.stat.size || opened.stat.mtimeMs !== source.stat.mtimeMs) {
              throw new CodexNativeReadError(409, "CODEX_HISTORY_SOURCE_CHANGED", "The native archive changed before this page was read.");
            }
          }
        })) rows.push(line);
        cached = rows;
        this.archives.set(stamp, rows);
        while (this.archives.size > 4) this.archives.delete(this.archives.keys().next().value!);
      }
      const rows = cached;
      options.signal?.throwIfAborted();
      for (let index = offset; index < rows.length; index++) {
        if (!accept(rows[index]!, index + 1, true)) break;
        if (scanned >= limit) { hasMore = offset < rows.length; break; }
      }
    } else {
      let position = { startOffset: offset, nextOffset: offset, terminated: true };
      for await (const line of readCodexRolloutLines(thread.rolloutPath, sessionId, {
        signal: options.signal,
        verifyIdentity: true,
        startOffset: offset,
        onSource: opened => {
          if (sourceIdentity(opened) !== identity || opened.stat.size < source.stat.size || opened.stat.size === source.stat.size && opened.stat.mtimeMs !== source.stat.mtimeMs) throw new CodexNativeReadError(409, "CODEX_HISTORY_SOURCE_CHANGED", "The native history source changed before reading this page.");
        },
        onLine: (_line, value) => { position = value; }
      })) {
        if (!accept(line, position.nextOffset, position.terminated)) break;
        if (scanned >= limit) { hasMore = offset < source.stat.size; break; }
      }
    }
    const resumeCursor = encode({
      version: 1,
      sessionId,
      source: identity,
      offset,
      sequence,
      size: source.stat.size,
      modified: source.stat.mtimeMs
    });
    return {
      provider: "codex",
      sessionId,
      source: "codex-native-rollout",
      entries,
      nextCursor: hasMore ? resumeCursor : null,
      resumeCursor,
      coverage: {
        firstSequence,
        lastSequence: sequence,
        scannedRecords: scanned,
        returnedRecords: entries.length,
        reachedEnd: !hasMore,
        pendingTail,
        partial: warnings.length > 0 || pendingTail
      },
      warnings
    };
  }
}

const sessionSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    cwd: { type: "string" },
    updatedAt: { anyOf: [{ type: "string" }, { type: "number" }] },
    archived: { type: "boolean" }
  },
  additionalProperties: true
};
const historySchema = {
  type: "object",
  required: ["provider", "sessionId", "source", "entries", "nextCursor", "resumeCursor", "coverage", "warnings"],
  properties: {
    provider: { const: "codex" },
    sessionId: { type: "string" },
    source: { const: "codex-native-rollout" },
    entries: {
      type: "array",
      items: {
        type: "object",
        required: ["sequence", "record"],
        properties: {
          sequence: { type: "integer", minimum: 1 },
          record: { description: "Original native JSON event, including native message/tool IDs and payload." }
        },
        additionalProperties: false
      }
    },
    nextCursor: { type: ["string", "null"] },
    resumeCursor: { type: "string" },
    coverage: {
      type: "object",
      properties: {
        firstSequence: { type: "integer" },
        lastSequence: { type: "integer" },
        scannedRecords: { type: "integer" },
        returnedRecords: { type: "integer" },
        reachedEnd: { type: "boolean" },
        pendingTail: { type: "boolean" },
        partial: { type: "boolean" }
      },
      additionalProperties: false
    },
    warnings: {
      type: "array",
      items: {
        type: "object",
        required: ["sequence", "errorCode"],
        properties: { sequence: { type: "integer" }, errorCode: { type: "string" } },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

export type CodexNativeOperationDependencies = {
  listSessions?: (options: { limit: number; offset: number; query?: string }) => { items: unknown[]; nextOffset: number | null } | Promise<{ items: unknown[]; nextOffset: number | null }>;
  readSession?: (id: string) => unknown | Promise<unknown>;
  history?: CodexNativeHistoryReader;
};
const queryNumber = (input: ApiOperationInput, key: string): number | undefined => input.url.searchParams.has(key) ? Number(input.url.searchParams.get(key)) : undefined;
export function createCodexNativeOperations(dependencies: CodexNativeOperationDependencies = {}): ApiOperationDefinition[] {
  const history = dependencies.history ?? new CodexNativeHistoryReader();
  const list = dependencies.listSessions ?? (options => {
    const page = listCodexNativeSessionPage(options);
    return {
      ...page,
      items: page.items.map(row => ({ id: row.id, title: row.title, cwd: row.cwd, updatedAt: row.updatedAt, archived: row.archived }))
    };
  });
  const read = dependencies.readSession ?? (id => {
    const row = readCodexDesktopThread(id);
    if (!row) throw new CodexNativeReadError(404, "CODEX_SESSION_NOT_FOUND", "The exact Codex session was not found.");
    return { id: row.id, title: row.title, cwd: row.cwd, updatedAt: row.updatedAt, archived: row.archived };
  });
  const specs = [
    {
      id: "list",
      suffix: "",
      title: "List Codex sessions",
      query: {
        limit: { type: "string", pattern: "^[1-9][0-9]*$" },
        offset: { type: "string", pattern: "^[0-9]+$" },
        query: { type: "string" }
      },
      run: async (input: ApiOperationInput) => {
        const limit = positive(queryNumber(input, "limit"), 50), offset = queryNumber(input, "offset") ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new CodexNativeReadError(400, "CODEX_SESSION_OFFSET_INVALID", "offset must be a non-negative safe integer.");
        const rows = await list({
          limit,
          offset,
          query: input.url.searchParams.get("query") ?? undefined
        });
        return { provider: "codex", ...rows };
      }
    },
    {
      id: "read",
      suffix: "/:sessionId",
      title: "Read Codex session metadata",
      query: {},
      run: (input: ApiOperationInput) => read(input.path.sessionId!)
    },
    {
      id: "history.read",
      suffix: "/:sessionId/history",
      title: "Read native Codex conversation events",
      query: {
        limit: { type: "string", pattern: "^[1-9][0-9]*$" },
        maxBytes: { type: "string", pattern: "^[1-9][0-9]*$" },
        cursor: { type: "string" }
      },
      run: (input: ApiOperationInput) => history.read(input.path.sessionId!, {
        cursor: input.url.searchParams.get("cursor") ?? undefined,
        limit: queryNumber(input, "limit"),
        maxBytes: queryNumber(input, "maxBytes"),
        signal: input.signal
      })
    }
  ];
  return specs.map(spec => ({
    discovery: {
      title: spec.title,
      summary: spec.title,
      category: { id: "native.codex", title: "Codex native sessions", parentId: "agents" },
      provider: "codex",
      inputSources: spec.suffix ? [{
        field: "path.sessionId",
        operationId: "agent.providers.codex.sessions.list",
        resultPath: "/data/items",
        valuePath: "/id"
      }] : [],
      tags: ["codex", "sessions", "native", ...(spec.id === "history.read" ? ["history", "messages", "tool-events"] : [])]
    },
    contract: {
      operationId: `agent.providers.codex.sessions.${spec.id}`,
      contractVersion: "1.0.0",
      method: "GET",
      pathTemplate: `/api/agent/providers/codex/sessions${spec.suffix}`,
      exposure: "public",
      transport: "http",
      description: `${spec.title}. History contains original native message and tool events with stable sequence/cursor and coverage; Rabi delivery records are a separate source.`,
      request: {
        path: {
          type: "object",
          properties: spec.suffix ? { sessionId: { type: "string", minLength: 1 } } : {},
          required: spec.suffix ? ["sessionId"] : [],
          additionalProperties: false
        },
        query: { type: "object", properties: spec.query, additionalProperties: false },
        headers: { type: "object" },
        body: { kind: "none" }
      },
      responses: {
        ...Object.fromEntries([400, 404, 409, 413, 503].map(status => [String(status), { mediaType: "application/json", schema: { type: "object", additionalProperties: true } }])),
        "200": {
          mediaType: "application/json",
          schema: {
            type: "object",
            required: ["code", "data"],
            properties: {
              code: { const: 0 },
              data: spec.id === "history.read" ? historySchema : spec.id === "read" ? sessionSchema : {
                type: "object",
                required: ["provider", "items", "nextOffset"],
                properties: {
                  provider: { const: "codex" },
                  items: { type: "array", items: sessionSchema },
                  nextOffset: { type: ["integer", "null"] }
                },
                additionalProperties: false
              }
            },
            additionalProperties: false
          }
        }
      },
      effects: {
        mode: "read",
        description: "Reads this Codex owner's native state/history without sending prompts or creating sessions."
      },
      recovery: {
        strategy: "owner-read",
        description: "Continue with the returned cursor. Invalid rows remain local warnings. A changed source requires a fresh first page."
      },
      validators: []
    },
    async handler(input: ApiOperationInput) {
      try {
        input.signal?.throwIfAborted();
        const data = await spec.run(input);
        input.signal?.throwIfAborted();
        return { status: 200, body: { code: 0, data } };
      }
      catch (error) {
        if (input.signal?.aborted) throw error;
        return {
          status: error instanceof CodexNativeReadError ? error.status : 503,
          body: {
            code: -1,
            errorCode: error instanceof CodexNativeReadError ? error.code : "CODEX_NATIVE_READ_UNAVAILABLE",
            message: error instanceof CodexNativeReadError ? error.message : "Codex native data is temporarily unavailable.",
            repair: `Read the current contract for agent.providers.codex.sessions.${spec.id}. Preserve the original session ID.`
          }
        };
      }
    }
  }));
}
