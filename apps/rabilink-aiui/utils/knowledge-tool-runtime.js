// Single-step execution only. Transport owns device credentials and endpoint authorization.
const READ_TOOLS = ["knowledge_search", "plan_list", "plan_get", "plan_statuses", "memory_list", "memory_get"];
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { const error = new Error(code); error.code = code; return error; };
function bounded(value, maximum) {
  const text = JSON.stringify(value);
  if (typeof text !== "string" || text.length > maximum) throw fail("TOOL_PAYLOAD_LIMIT");
  return JSON.parse(text);
}
function fingerprint(name, args) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") { const result = {}; Object.keys(value).sort().forEach(key => { result[key] = canonical(value[key]); }); return result; }
    return value;
  }
  return JSON.stringify([name, canonical(args)]);
}
export function summarizeKnowledgeResult(result) {
  const safe = bounded(result, 65536);
  const receipt = safe && safe.structuredContent;
  if (!receipt || receipt.ok !== true || receipt.uncertain === true || safe.isError === true) return "工具结果：查询未确认成功，请检查连接或权限。";
  // Never speak arbitrary tool text, prompts, secrets, or data fields.
  const data = receipt.data;
  const rows = Array.isArray(data) ? data : data && [data.items, data.plans, data.memories, data.results].find(Array.isArray);
  return rows ? `工具结果：查询成功，返回 ${rows.length} 条记录。` : "工具结果：查询成功，详情已返回。这是独立工具结果，不是模型续轮回答。";
}
/** list() => {tools}; call({name,args}) => official MCP CallToolResult.
 * selectedRole is explicit user selection; authorizedRoles is trusted policy, never model input.
 * storage.load/save retain bounded call IDs within a caller-owned device/turn scope.
 * onResult receives bounded untrusted data for text-only rendering; never execute its contents. */
export function createKnowledgeToolRuntime({ list, call, storage, authorizedRoles, selectedRole, onResult = () => {}, timeoutMs = 12000 } = {}) {
  if (typeof list !== "function" || typeof call !== "function" || !storage || typeof storage.load !== "function" || typeof storage.save !== "function") throw fail("TOOL_DEPENDENCIES_REQUIRED");
  if (!Array.isArray(authorizedRoles) || !authorizedRoles.every(role => typeof role === "string") || !authorizedRoles.includes(selectedRole)) throw fail("TOOL_ROLE_DENIED");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw fail("TOOL_TIMEOUT_INVALID");
  let catalog = [], busy = false, generation = 0, disposed = false;
  let history = null;
  async function ledger() {
    if (history) return history;
    const stored = await storage.load();
    if (stored !== null && stored !== undefined && (!Array.isArray(stored) || stored.length > 128 || stored.some(row => !row || typeof row.id !== "string" || typeof row.fingerprint !== "string"))) throw fail("TOOL_LEDGER_INVALID");
    history = stored ? bounded(stored, 131072) : [];
    return history;
  }
  return Object.freeze({
    async loadTools() {
      if (disposed || busy) throw fail("TOOL_BUSY_OR_CLOSED");
      const epoch = generation;
      const result = bounded(await list(), 65536);
      if (disposed || epoch !== generation) throw fail("TOOL_CANCELLED");
      if (!result || !Array.isArray(result.tools) || result.tools.length > 32) throw fail("TOOL_CATALOG_INVALID");
      if (!Array.isArray(result.allowedRoles) || !result.allowedRoles.includes(selectedRole)) throw fail("TOOL_ROLE_DENIED");
      const seen = new Set();
      catalog = result.tools.filter(tool => tool && READ_TOOLS.includes(tool.name)).map(tool => {
        if (seen.has(tool.name)) throw fail("TOOL_CATALOG_DUPLICATE"); seen.add(tool.name);
        const schema = tool.inputSchema;
        if (!schema || schema.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw fail("TOOL_SCHEMA_INVALID");
        const copy = bounded(schema, 8192);
        copy.properties.roleId = { type: "string", enum: [selectedRole] };
        if (tool.name === "memory_get") copy.properties.kind = { type: "string", enum: ["consolidated"] };
        delete copy.properties.idempotencyKey;
        return { type: "function", function: { name: tool.name, description: `只读知识查询：${tool.name}。结果单独展示，不自动续轮。`, parameters: copy } };
      });
      return clone(catalog);
    },
    async handleToolCall(event) {
      if (disposed) throw fail("TOOL_CLOSED");
      if (!event || event.isComplete !== true) return { ignored: true };
      if (busy) throw fail("TOOL_BUSY");
      busy = true;
      const epoch = generation;
      let timer, inflight = null, timedOut = false;
      try {
        if (typeof event.callId !== "string" || !/^[A-Za-z0-9:._-]{1,128}$/.test(event.callId)) throw fail("TOOL_CALL_ID_INVALID");
        const name = event.functionName;
        const tool = catalog.find(item => item.function.name === name);
        if (!tool) throw fail("TOOL_NOT_AVAILABLE");
        const args = bounded(typeof event.arguments === "string" ? JSON.parse(event.arguments) : event.arguments, 8192);
        if (!args || typeof args !== "object" || Array.isArray(args)) throw fail("TOOL_ARGUMENTS_INVALID");
        if (args.roleId !== undefined && args.roleId !== selectedRole) throw fail("TOOL_ROLE_DENIED");
        if (args.idempotencyKey !== undefined || (name === "memory_get" && args.kind !== "consolidated")) throw fail("TOOL_WRITE_DENIED");
        if (Object.keys(args).some(key => !Object.prototype.hasOwnProperty.call(tool.function.parameters.properties, key))) throw fail("TOOL_ARGUMENTS_INVALID");
        args.roleId = selectedRole;
        const fp = fingerprint(name, args), rows = await ledger();
        const previous = rows.find(row => row.id === event.callId);
        if (previous) { if (previous.fingerprint !== fp) throw fail("TOOL_CALL_ID_CONFLICT"); return { duplicate: true }; }
        if (rows.length >= 128) throw fail("TOOL_LEDGER_FULL");
        const next = rows.concat([{ id: event.callId, fingerprint: fp }]);
        await storage.save(clone(next)); history = next;
        if (disposed || epoch !== generation) return { cancelled: true, executed: false };
        // Persist before dispatch. A timeout must never trigger automatic replay.
        inflight = Promise.resolve().then(() => call({ name, args }));
        const result = await Promise.race([inflight, new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(fail("TOOL_TIMEOUT")); }, timeoutMs); })]);
        const boundedResult = bounded(result, 65536);
        if (disposed || epoch !== generation) return { cancelled: true, executed: true };
        const output = { callId: event.callId, name, summary: summarizeKnowledgeResult(boundedResult), result: boundedResult, singleStep: true };
        onResult(output);
        return output;
      } finally {
        if (timer) clearTimeout(timer);
        // Timed-out HTTP may still execute: keep concurrency occupied until it settles.
        if (timedOut && inflight) inflight.then(() => { busy = false; }, () => { busy = false; });
        else busy = false;
      }
    },
    cancelPresentation() { generation++; },
    dispose() { disposed = true; generation++; catalog = []; }
  });
}
