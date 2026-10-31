import { parseApiPathTemplate, fillApiPathTemplate, validApiHttpMethod } from "./api-path-template.mjs";

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "*"]);

function parseCatalog(receipt) {
  if (!receipt.ok || receipt.uncertain || receipt.identityChanged) throw new Error("API discovery was not confirmed for the current Manager identity.");
  let envelope;
  try { envelope = JSON.parse(receipt.body); } catch { throw new Error("Manager returned invalid API discovery JSON."); }
  const catalog = envelope?.data;
  if (envelope.code !== 0 || catalog?.schemaVersion !== "2" || !catalog.applicationGenerationId || !catalog.managerInstanceId
    || !catalog.pluginGenerationId || !Number.isSafeInteger(catalog.catalogRevision) || !catalog.catalogDigest
    || !Array.isArray(catalog.operations) || catalog.nextCursor) throw new Error("Manager API discovery contract is incomplete or unsupported.");
  if (receipt.identity && (receipt.identity.applicationGenerationId !== catalog.applicationGenerationId
    || receipt.identity.managerInstanceId !== catalog.managerInstanceId)) throw new Error("API discovery and transport identities disagree.");
  const ids = new Set();
  for (const entry of catalog.operations) {
    const contract = entry?.contract;
    if (!contract || !entry.contractDigest || entry.id !== contract.operationId
      || !METHODS.has(contract.method) || contract.method === "*" && (!contract.httpProxy || contract.transport !== "http" || contract.request?.body?.kind !== "passthrough") || typeof contract.pathTemplate !== "string"
      || !contract.pathTemplate.startsWith("/") || contract.pathTemplate.startsWith("//")
      || /[?#\\\s]/.test(contract.pathTemplate) || !/^\d+\.\d+\.\d+$/.test(contract.contractVersion)) {
      throw new Error("Manager returned an invalid API operation declaration.");
    }
    parseApiPathTemplate(contract.pathTemplate, contract.request?.pathTails, contract.request?.pathRemainder);
    if (entry.binding !== undefined) {
      const binding = entry.binding, address = binding?.address;
      if (binding.kind !== "external-listener" || typeof binding.listenerId !== "string" || !binding.listenerId
        || typeof binding.leaseId !== "string" || !binding.leaseId || !["native", "discovery-only"].includes(binding.invocation)
        || !["none", "native"].includes(binding.authentication?.kind) || typeof binding.authentication.description !== "string"
        || !["http", "https"].includes(address?.protocol) || !Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65535) throw new Error("Manager returned an invalid external listener binding.");
      if (address.hostname !== undefined) {
        const url = new URL(`${address.protocol}://${address.hostname}:${address.port}`);
        if (url.hostname !== address.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash
          || ["0.0.0.0", "[::]"].includes(address.hostname)) throw new Error("Manager returned an invalid external listener address.");
      }
    }
    if (entry.access !== undefined && (!entry.binding || entry.access.kind !== "manager-native-http"
      || entry.access.pathPrefix !== "/api/native-listeners/" + entry.binding.leaseId
      || entry.access.contractHeader !== "x-rabiroute-native-proxy-contract"
      || !/^sha256:[a-f0-9]{64}$/.test(entry.access.contractDigest) || contract.transport !== "http")) throw new Error("Manager returned an invalid native HTTP owner mapping.");
    if (contract.request?.contractHeader !== undefined && !/^x-rabiroute-[a-z0-9-]+-contract$/.test(contract.request.contractHeader)) throw new Error("Manager returned an invalid operation contract header.");
    if (contract.aliases !== undefined && (!Array.isArray(contract.aliases) || contract.aliases.length > 100)) throw new Error("Manager returned invalid API operation aliases.");
    for (const id of [entry.id, ...(contract.aliases ?? [])]) {
      if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9._:/-]{0,4095}$/.test(id) || ids.has(id)) throw new Error("Manager returned ambiguous API operation identifiers.");
      ids.add(id);
    }
  }
  return catalog;
}

function freeze(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** A rebuildable contract cache, never an authorization allowlist or business-state owner. */
export function createApiCatalogClient({ request, openWebSocket, requestExternal, openExternalWebSocket, onVerifiedCatalog, cachedDelivery }) {
  let cached;
  let etag;
  let epoch = 0;
  let loading;
  function invalidate() { epoch++; cached = undefined; etag = undefined; }
  function handleEvent(event) {
    const type = event?.type ?? event?.event;
    if (["ready", "reconnected", "api.catalog.changed"].includes(type)) invalidate();
  }
  async function refresh({ force = false, signal } = {}) {
    if (force) invalidate();
    if (loading) { await loading; return refresh({ signal }); }
    const observed = epoch;
    const read = async () => {
      const receipt = await request("GET", "/api/agent/help", { headers: etag ? { "if-none-match": etag } : {}, signal, replaySafe: false });
      if (receipt.statusCode === 304) {
        if (!cached || observed !== epoch || receipt.identityChanged || receipt.uncertain
          || receipt.identity && (receipt.identity.applicationGenerationId !== cached.applicationGenerationId
            || receipt.identity.managerInstanceId !== cached.managerInstanceId)) {
          invalidate(); throw new Error("API catalog conditional read belongs to an expired Manager identity.");
        }
        return cached;
      }
      const catalog = freeze(parseCatalog(receipt));
      await onVerifiedCatalog?.(catalog, receipt.identity);
      if (observed !== epoch) throw new Error("API discovery changed while being read; refresh before preparing a call.");
      cached = catalog;
      etag = receipt.headers?.etag;
      return cached;
    };
    const pending = read();
    loading = pending;
    try { return await pending; } finally { if (loading === pending) loading = undefined; }
  }

  async function prepare(operationId, options) {
    // This is an on-demand conditional read, not background polling. It also covers owners without a live event subscription.
    let catalog, resolved = options;
    try { catalog = await refresh({ signal: options.signal }); }
    catch (error) {
      const cached = await cachedDelivery?.(operationId, options);
      if (!cached) throw error;
      catalog = cached.catalog; resolved = cached.options;
    }
    const { path: pathValues = {}, query = {}, method: requestedMethod, ...httpOptions } = resolved;
    const entry = catalog.operations.find(value => value.id === operationId || value.contract.aliases?.includes(operationId));
    if (!entry) throw new Error("Operation is absent from current discovery. This is not a remote permission decision.");
    const contract = entry.contract;
    if (options.nativeHeaders !== undefined && !entry.binding) throw new Error("Explicit native credential headers are only valid for a native listener operation.");
    if (entry.binding?.invocation === "discovery-only") throw new Error(`The ${entry.binding.protocol} listener is discoverable; invocation requires its native protocol connector and authentication.`);
    const method = requestedMethod === undefined ? contract.method : requestedMethod;
    if (!validApiHttpMethod(method)
      || contract.method !== "*" && method !== contract.method) throw new Error("Provide an explicit valid HTTP method for a native wildcard operation; fixed operation methods cannot be overridden.");
    const target = fillApiPathTemplate(contract.pathTemplate, pathValues, contract.request?.pathTails, contract.request?.pathRemainder);
    const parameters = new URLSearchParams();
    for (const [name, raw] of Object.entries(query)) {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("API query values must be scalar values or arrays of scalars.");
        parameters.append(name, String(value));
      }
    }
    const headers = { ...(httpOptions.headers ?? {}) };
    const contractHeader = contract.request?.contractHeader ?? "x-rabiroute-api-contract";
    if (Object.keys(headers).some(name => name.toLowerCase() === contractHeader)) throw new Error("The selected operation owns its API contract header.");
    headers[contractHeader] = entry.contractDigest;
    return { entry, catalog, method, target: target + (parameters.size ? "?" + parameters : ""), options: { ...httpOptions, headers, replaySafe: false } };
  }

  async function invokeOperation(operationId, options = {}) {
    const prepared = await prepare(operationId, options), contract = prepared.entry.contract, httpOptions = prepared.options;
    if (!["http", "sse"].includes(contract.transport ?? "http")) throw new Error("The selected API transport requires a compatible connector; this HTTP call was not executed.");
    if (contract.transport === "sse" && !httpOptions.outputPath) {
      if (typeof httpOptions.onChunk === "function" && httpOptions.responseMode === undefined) httpOptions.responseMode = "stream";
      if (httpOptions.responseMode !== "stream" || typeof httpOptions.onChunk !== "function") throw new Error("SSE operation requires an explicit output file or onChunk stream consumer before invocation.");
    }
    if (prepared.entry.binding && typeof requestExternal !== "function") throw new Error("The selected external listener requires a compatible native address connector; no call was executed.");
    const receipt = prepared.entry.binding
      ? await requestExternal(prepared.method, prepared.target, httpOptions, prepared.entry, prepared.catalog)
      : await request(prepared.method, prepared.target, httpOptions);
    let result;
    try { result = JSON.parse(receipt.body); } catch { /* Binary/stream responses retain the generic transport result. */ }
    if (receipt.identityChanged || receipt.bindingChanged || result?.errorCode === "API_CONTRACT_CHANGED" || result?.errorCode === "API_LISTENER_BINDING_CHANGED") invalidate();
    // Never replay a business call, including a GET that might persist viewed state.
    return receipt;
  }

  async function openOperation(operationId, options = {}) {
    if (typeof options.onMessage !== "function") throw new Error("WebSocket operation requires an explicit onMessage consumer.");
    if (["body", "bodyText", "bodyBytes", "bodyStream", "outputPath", "onChunk"].some(key => options[key] !== undefined)) throw new Error("WebSocket operation accepts frames through its session, not an HTTP body or output file.");
    const prepared = await prepare(operationId, options);
    if (prepared.entry.contract.transport !== "websocket") throw new Error("The selected operation is not a WebSocket transport.");
    const connector = prepared.entry.binding ? openExternalWebSocket : openWebSocket;
    if (typeof connector !== "function") throw new Error("The selected API transport requires a compatible connector; no WebSocket was opened.");
    try { return await connector(prepared.target, prepared.options, prepared.entry.contract, prepared.catalog, prepared.entry); }
    catch (error) { if (["API_CONTRACT_CHANGED", "IDENTITY_OR_OPEN_FAILED", "IDENTITY_CHANGED"].includes(error.code)) invalidate(); throw error; }
  }

  async function watch({ signal, timeoutMs } = {}) {
    invalidate();
    let line = "";
    let discarded = false;
    let afterCarriageReturn = false;
    let eventType;
    const decoder = new TextDecoder();
    const endLine = () => {
      if (!discarded && !line) {
        if (eventType) handleEvent({ type: eventType });
        eventType = undefined;
      } else if (!discarded && line.startsWith("event:")) eventType = line.slice(6).trim();
      line = ""; discarded = false;
    };
    try {
      return await request("GET", "/api/events", { responseMode: "stream", replaySafe: false, signal, timeoutMs,
        onChunk(bytes) {
          // Only event names invalidate this cache. Discard data/comment lines as
          // they arrive rather than buffering unrelated multi-megabyte payloads.
          for (const character of decoder.decode(bytes, { stream: true })) {
            if (afterCarriageReturn) { afterCarriageReturn = false; if (character === "\n") continue; }
            if (character === "\r" || character === "\n") { endLine(); afterCarriageReturn = character === "\r"; continue; }
            if (discarded) continue;
            line += character;
            if (line.length === 6 && !line.startsWith("event:")) { discarded = true; line = ""; }
            else if (line.length > 65_536) throw new Error("API discovery event name exceeds the bounded event buffer.");
          }
        }
      });
    } finally { invalidate(); }
  }

  return Object.freeze({ refresh, invokeOperation, openOperation, invalidate, handleEvent, watch });
}
