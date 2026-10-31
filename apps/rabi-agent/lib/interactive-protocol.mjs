/** Protocol facts shared by the remote executors, Manager replay owner and API contracts. */
export const TERMINAL_LIMITS = Object.freeze({ idPattern: "^[a-f0-9-]{36}$", inputBytes: 16384, eventCodeUnits: 16384,
  replayBytes: 262144, replayEvents: 2048, viewers: 4, waitMs: 25000, transportSessions: 128,
  activeSessions: 8, retainedSessions: 64, inputReceipts: 256, inputQueueBytes: 65536,
  minCols: 20, maxCols: 400, minRows: 5, maxRows: 200, streamQueueBytes: 524288, heartbeatMs: 25000 });
export const COMPUTER_LIMITS = Object.freeze({ chunkBytes: 65536, chunkBase64CodeUnits: 87384, uploadBytes: Number.MAX_SAFE_INTEGER,
  uploadIdPattern: TERMINAL_LIMITS.idPattern, hashPattern: "^[a-f0-9]{64}$" });
const text = { type: "string" }, integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, bool = { type: "boolean" };
export const terminalIdSchema = { type: "string", pattern: TERMINAL_LIMITS.idPattern };
const hash = { type: "string", pattern: COMPUTER_LIMITS.hashPattern };
const exact = properties => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
const branch = (action, required, properties = {}) => ({ type: "object", required: ["action", ...required],
  properties: { action: { const: action }, ...properties }, additionalProperties: true });
export const terminalRequestSchema = { anyOf: [branch("list", []),
  branch("open", ["terminalId", "shell"], { terminalId: terminalIdSchema, shell: text, cwd: { description: "A falsey value uses the remote default; otherwise the executor requires an existing absolute directory." } }),
  ...["get", "close"].map(action => branch(action, ["terminalId"], { terminalId: terminalIdSchema })),
  branch("input", ["terminalId", "sequence", "data"], { terminalId: terminalIdSchema, sequence: { ...integer, minimum: 1 }, data: text }),
  branch("resize", ["terminalId", "cols", "rows"], { terminalId: terminalIdSchema,
    cols: { type: "integer", minimum: TERMINAL_LIMITS.minCols, maximum: TERMINAL_LIMITS.maxCols }, rows: { type: "integer", minimum: TERMINAL_LIMITS.minRows, maximum: TERMINAL_LIMITS.maxRows } })
] };
export const terminalSnapshotSchema = { type: "object", required: ["terminalId", "shell", "cwd", "state", "createdAt", "nextInputSequence"],
  properties: { terminalId: terminalIdSchema, shell: text, cwd: text, state: { enum: ["starting", "running", "closing", "exited"] }, createdAt: text,
    nextInputSequence: { ...integer, minimum: 1 }, pid: integer, exitCode: { anyOf: [{ type: "integer" }, { type: "null" }] } }, additionalProperties: false };
export const terminalListSchema = exact({ shells: { type: "array", items: text }, sessions: { type: "array", maxItems: TERMINAL_LIMITS.retainedSessions, items: terminalSnapshotSchema } });
export const terminalEventSchema = { type: "object", required: ["sequence", "type"], properties: { sequence: integer,
  type: { enum: ["output", "exit", "gap", "disconnected"] }, data: text, exitCode: { anyOf: [{ type: "integer" }, { type: "null" }] } }, additionalProperties: false };
export const terminalReadSchema = exact({ terminal: terminalSnapshotSchema, outputEvents: { type: "array", maxItems: TERMINAL_LIMITS.replayEvents, items: terminalEventSchema }, nextOutputSequence: integer, truncated: bool });
const fileFields = { path: text }, uploadId = terminalIdSchema;
export const computerRequestSchema = { anyOf: [branch("file.stat", ["path"], fileFields),
  branch("file.read", ["path", "version", "offset"], { ...fileFields, version: text, offset: integer }),
  branch("upload.begin", ["uploadId", "path", "size", "sha256"], { ...fileFields, uploadId, size: { ...integer, maximum: COMPUTER_LIMITS.uploadBytes }, sha256: hash }),
  branch("upload.write", ["uploadId", "offset", "data", "sha256"], { uploadId, offset: integer,
    data: { type: "string", maxLength: COMPUTER_LIMITS.chunkBase64CodeUnits, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, sha256: hash }),
  ...["upload.commit", "upload.status", "upload.abort"].map(action => branch(action, ["uploadId"], { uploadId })),
  branch("windows.list", [], { limit: { description: "The native Windows helper applies Convert.ToInt32 and its 1..200 bound." }, query: { description: "The Windows helper applies Convert.ToString and its UTF-16 length bound." } }),
  branch("screen.capture", [], { maxWidth: { description: "The Windows helper applies Convert.ToInt32 and its 320..3840 bound." },
    windowId: { description: "If supplied, the native helper validates the hexadecimal window handle and requires its queried pid." }, pid: {} })
] };
const bounds = exact({ x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } });
export const computerResponseSchema = { anyOf: [
  exact({ path: text, size: integer, version: text, chunkBytes: { const: COMPUTER_LIMITS.chunkBytes } }),
  exact({ path: text, version: text, offset: integer, nextOffset: integer, size: integer, eof: bool, data: text, sha256: hash }),
  exact({ uploadId, path: text, size: integer, sha256: hash, offset: integer, state: { enum: ["uploading", "committed", "aborted"] } }),
  exact({ windows: { type: "array", items: exact({ windowId: text, pid: integer, title: text, minimized: bool, bounds }) }, truncated: bool }),
  exact({ mimeType: { const: "image/png" }, width: { ...integer, minimum: 1 }, height: { ...integer, minimum: 1 }, bounds, capturedAt: text, data: text })
] };
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
for (const value of [terminalIdSchema, terminalRequestSchema, terminalSnapshotSchema, terminalListSchema, terminalEventSchema, terminalReadSchema, computerRequestSchema, computerResponseSchema]) freeze(value);
