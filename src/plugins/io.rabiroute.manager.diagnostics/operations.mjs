/** Plugin-owned HTTP contract and query policy; Gateway state remains with its owner. */
const text = { type: "string" };
const bool = { type: "boolean" };
const nullableText = { anyOf: [text, { type: "null" }] };
const gateways = { type: "array", items: { type: "object", required: ["id"],
  properties: { id: { type: "string", minLength: 1 }, name: text, configName: text, routeName: text, enabled: bool, running: bool, lifecycleState: text,
    pid: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, lastError: nullableText, startedAt: nullableText, stoppedAt: nullableText,
    messageAdapters: { type: "array", items: text }, roleInfo: { type: "object" }, messageFiles: { type: "object", additionalProperties: true },
    log: { type: "array", items: text } }, additionalProperties: true } };

/** Diagnostic owners retain their extensible provider/status payloads; no readiness grant is added. */
export function createDiagnosticsRoutes(context) {
  const define = (operationId, pathTemplate, schema, read) => {
    const contract = { operationId,
      contractVersion: "1.0.0", method: "GET", pathTemplate, exposure: "public", transport: "http",
      description: "Read existing Gateway diagnostics, retaining provider-specific fields and current cached status.",
      request: { path: { type: "object", properties: {}, additionalProperties: false },
        query: { type: "object", additionalProperties: true, description: "Existing diagnostic owners ignore query parameters. Use exact /meta without query for identity discovery." },
        headers: { type: "object" }, body: { kind: "none" } },
      responses: { "200": { mediaType: "application/json", schema,
        headers: { type: "object", required: ["cache-control"], properties: { "cache-control": { const: "private, no-store" } }, additionalProperties: true } } },
      effects: { mode: "diagnostic-read", description: "Reads current identity/status through the existing diagnostic owners and performance instrumentation. Does not launch a Runtime, scan Agent sessions, change Route state or grant business permissions." },
      recovery: { strategy: "repeatable-read", description: "Rediscover through Host/READY on identity change. Health false, startup or unrelated dependency failure remains diagnostic data; it does not authorize a second Manager or a fallback Runtime." },
      validators: [{ id: "manager.diagnostics.owner-payload", description: "Identity strings are nonempty. Health values are validated by type, never required to be healthy/ready. Provider-specific diagnostic sections remain extensible. The same ingress connection authority applies before and after awaited reads; no separate persona, workspace or feature grant is introduced." }] };
    return { contract, discovery: { title: '消息连接与路由目录', summary: '查询当前消息连接、路由和运行状态。', category: { id: 'messages.connections', title: '消息连接', parentId: 'messages' }, tags: ['连接', '路由', '渠道', 'Route', 'Gateway'], provider: '' }, handler: async () => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: await read() }) };
  };
  return { operations: [define("manager.gateways.read", "/api/gateways", gateways, context.gatewayDiagnosticsPayload),
    ...(context.callHistory ? createCallHistoryRoutes(context.callHistory) : [])] };
}

function createCallHistoryRoutes(owner) {
  const object = properties => ({ type: "object", properties, additionalProperties: false });
  const string = { type: "string" };
  const empty = object({});
  const json = { mediaType: "application/json", schema: { type: "object", required: ["code"], properties: {
    code: { type: "integer" }, data: { type: "object" }, message: string
  }, additionalProperties: true } };
  const define = (id, method, tail, description, request, handler, response = json) => ({
    contract: { operationId: "manager.calls." + id, contractVersion: "1.0.0", method,
      pathTemplate: "/api/diagnostics/calls" + tail, exposure: "public", transport: response.stream ? "sse" : "http", description,
      request: { path: tail.includes(":callId") ? object({ callId: string }) : empty,
        query: empty, headers: { type: "object" }, body: { kind: "none" }, ...request },
      responses: { "200": response, "400": json, "404": json, "503": json },
      effects: { mode: method === "GET" ? "diagnostic-read" : "write", description: "Reads or records diagnostic observations through the original call-history owner. Business operations retain their own receipts." },
      validators: [{ id: "diagnostics.call-history.input", description: "The original owner validates query cursors, configuration and client observation identities." }],
      recovery: { strategy: method === "GET" ? "repeatable-read" : "inspect-before-retry", description: "Client observations use stable call/span IDs. Inspect the original business receipt independently." } },
    discovery: { title: description, summary: description, category: { id: "diagnostics.calls", title: "调用记录" }, tags: ["调用记录", "请求", "返回值", "Agent", "日志", "MCP", "CLI"] },
    handler: async input => {
      try { return await handler(input); }
      catch (error) { return { status: error?.statusCode === 400 ? 400 : 503, body: { code: -1,
        message: error?.statusCode === 400 ? "调用记录参数无效，请检查筛选或回执格式。" : "调用记录存储当前不可用。" } }; }
    }
  });
  const ok = data => ({ status: 200, headers: { "cache-control": "private, no-store" }, body: { code: 0, data } });
  return [
    define("list", "GET", "", "查询 Agent 调用记录，按来源、会话、状态、接口和时间筛选。", {
      query: object({ limit: { anyOf: [{ type: "integer", minimum: 1, maximum: 200 }, { type: "string", pattern: "^[0-9]+$" }] }, cursor: string, source: string, status: string, sessionId: string, query: string, from: string, to: string })
    }, async input => ok(await owner.list(input.query))),
    define("read", "GET", "/:callId", "按需读取一次调用的阶段目录与单个阶段的请求、响应。", {
      query: object({ spanId: string, boundary: { enum: ["server", "client", "tool"] } })
    }, async input => {
      const data = input.query.spanId ? await owner.detail(input.path.callId, input.query.spanId, input.query.boundary) : await owner.listStages(input.path.callId);
      return data ? ok(data) : { status: 404, body: { code: -1, message: "调用记录不存在或已移出当前存储。" } };
    }),
    define("client.observe", "POST", "/client", "提交 MCP 或 CLI 的客户端观察回执，按调用和阶段 ID 去重。", {
      body: { kind: "json", maxBytes: 16 * 1024 * 1024, schema: { type: "object", required: ["callId", "spanId", "boundary", "startedAt", "status"],
        properties: { callId: string, spanId: string, boundary: { enum: ["client", "tool"] }, startedAt: string, status: string }, additionalProperties: true } }
    }, async input => ok(await owner.ingest(input.body))),
    define("config.save", "PUT", "/config", "设置服务端调用记录开关、正文记录和单条捕获大小。", {
      body: { kind: "json", maxBytes: 1024, schema: { ...object({ enabled: { type: "boolean" }, captureBodies: { type: "boolean" }, maxBodyBytes: { type: "integer", minimum: 1024, maximum: 16777216 } }), required: ["enabled", "captureBodies", "maxBodyBytes"] } }
    }, async input => ok(await owner.configure(input.body))),
    define("events", "GET", "/events", "订阅调用记录变化，重连后查询最新列表。", {}, () => ({
      status: 200, headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" }, stream: owner.events()
    }), { mediaType: "text/event-stream", stream: { framing: "sse-json", maxFrameBytes: 1024,
      frameSchema: { oneOf: [object({ event: { const: "changed" }, data: object({ revision: { type: "integer" } }) }), object({ comment: string })] },
      completion: "Client disconnect or original owner disposal.", cancellation: "Unsubscribe, stop heartbeat, unblock the iterator and complete its original lease." } })
  ];
}
