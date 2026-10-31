import { createTimeoutSettings } from "./timeout-settings.mjs";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

/** Submit to the existing launcher owner. No Manager URL or credential leaves config. */
export async function requestDeliveryControl(configPath, operation, params, { timeoutMs } = {}) {
  const canonical = fs.realpathSync(configPath);
  const config = JSON.parse(fs.readFileSync(canonical, "utf8"));
  timeoutMs ??= createTimeoutSettings(config.timeoutOverridesCache ?? config.timeoutOverrides).get("agent.client.localControl", 15_000);
  const configHash = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const diagnostic = JSON.parse(fs.readFileSync(path.join(path.dirname(canonical), `launcher-control-${configHash}.json`), "utf8"));
  if (diagnostic.configHash !== configHash || !/^[a-f0-9]{64}$/.test(diagnostic.token || "")) throw new Error("DELIVERY_OWNER_UNAVAILABLE: local acceptance was not confirmed.");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\rabi-agent-${configHash}`
    : { host: "127.0.0.1", port: 16384 + (Number.parseInt(configHash.slice(0, 8), 16) % 16384) };
  const requestId = randomUUID(), nonce = randomBytes(32).toString("hex");
  const body = JSON.stringify({ requestId, operation, params });
  if (Buffer.byteLength(body) > 3 * 1024 * 1024) throw new Error("Delivery control request exceeds the local size limit.");
  const proof = name => createHmac("sha256", diagnostic.token).update(`${configHash}:${name}:${nonce}`).digest("hex");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address); let buffer = "", authenticated = false, finished = false;
    const fail = () => { if (finished) return; finished = true; socket.destroy(); reject(new Error("DELIVERY_LOCAL_ACCEPTANCE_UNKNOWN: query the same intent ID; do not change it.")); };
    socket.setTimeout(timeoutMs, fail);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`hello ${nonce}\n`));
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { fail(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!authenticated) {
          if (line !== `owner ${proof("owner")}`) { fail(); return; }
          authenticated = true;
          socket.write(JSON.stringify({ type: "deliveryControl", body, proof: proof(`delivery:${createHash("sha256").update(body).digest("hex")}`) }) + "\n");
        } else {
          let response; try { response = JSON.parse(line); } catch { fail(); return; }
          if (response.requestId !== requestId) { fail(); return; }
          finished = true; socket.end(); resolve(response);
        }
      }
    });
    socket.on("error", fail); socket.once("close", () => { if (!finished) fail(); });
  });
}

export async function runDeliveryCommand(args, configPath, readInput) {
  const choices = ["--delivery-submit", "--delivery-query", "--delivery-list"].filter(value => args.includes(value));
  if (choices.length !== 1) throw new Error("Choose one delivery submit, query or list operation.");
  const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (choices[0] === "--delivery-submit") {
    const input = JSON.parse(await readInput());
    return submitDeliveryToOwner(configPath, { ...input, agentType: value("--agent-type") || input.agentType, sessionId: value("--id") || input.sessionId });
  }
  return requestDeliveryControl(configPath, "query", choices[0] === "--delivery-query"
    ? { action: "get", intentId: value("--delivery-query") }
    : { action: "list", ...(value("--cursor") ? { cursor: value("--cursor") } : {}), ...(value("--limit") ? { limit: Number(value("--limit")) } : {}),
      ...(value("--state") ? { state: value("--state") } : {}), ...(value("--query") ? { query: value("--query") } : {}) });
}

/** Generate before IPC, and return the same key even when its ACK is lost. */
export async function submitDeliveryToOwner(configPath, input) {
  const intentId = input.intentId || input.request?.deliveryId || randomUUID();
  if (typeof intentId !== "string" || !intentId.trim() || intentId !== intentId.trim() || intentId.length > 100 || /[\x00-\x1f\x7f]/.test(intentId)) throw new Error("Delivery ID must contain 1–100 printable characters without surrounding whitespace.");
  const request = { ...input.request, deliveryId: input.request?.deliveryId || intentId,
    sourceThreadId: input.request?.sourceThreadId || input.sessionId,
    sourceAgentType: input.request?.sourceAgentType || "agent",
    messageSource: input.request?.messageSource || { type: "agent", agentAdapter: input.agentType === "codex-desktop" ? "codex" : input.agentType,
      sessionId: input.sessionId, sessionName: input.sessionId } };
  if (request.deliveryId !== intentId) throw new Error("Intent and delivery ID must match.");
  try {
    const response = await requestDeliveryControl(configPath, "submit", { ...input, intentId, request });
    return { ...response, intentId, deliveryId: intentId };
  } catch {
    return { ok: false, accepted: null, intentId, deliveryId: intentId, error: "DELIVERY_LOCAL_ACCEPTANCE_UNKNOWN", guidance: "Query this same intent ID through the installed launcher; do not submit a replacement ID." };
  }
}

export function createReliableDeliveryClient({ configPath, agentType, sessionId }) {
  return Object.freeze({
    submit: (request, { intentId } = {}) => submitDeliveryToOwner(configPath, { intentId, agentType, sessionId, request }),
    get: intentId => requestDeliveryControl(configPath, "query", { action: "get", intentId }),
    list: options => requestDeliveryControl(configPath, "query", { ...options, action: "list" })
  });
}

function descriptorPath(configPath) {
  const canonical = fs.realpathSync(configPath);
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  return path.join(path.dirname(canonical), `delivery-descriptor-${key}.json`);
}

/** A verified descriptor cache, not an endpoint or authorization override. */
export function rememberDeliveryDescriptor(configPath, catalog, identity, expectedGuid) {
  if (!configPath) return;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.managerGuid || config.managerGuid !== expectedGuid || !identity || identity.applicationGenerationId !== catalog.applicationGenerationId || identity.managerInstanceId !== catalog.managerInstanceId) return;
  const entries = catalog.operations.filter(entry => entry.contract.method === "POST" && entry.contract.pathTemplate === "/api/agent/threads" && !entry.binding);
  if (entries.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(entries[0].contractDigest)) return;
  const { schemaVersion, applicationGenerationId, managerInstanceId, pluginGenerationId, catalogRevision, catalogDigest } = catalog;
  const data = { managerGuid: config.managerGuid, catalog: { schemaVersion, applicationGenerationId, managerInstanceId, pluginGenerationId, catalogRevision, catalogDigest, operations: entries, nextCursor: "" } };
  const text = JSON.stringify(data), filename = descriptorPath(configPath), temporary = filename + "." + randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ version: 1, sha256: createHash("sha256").update(text).digest("hex"), data })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function readDeliveryDescriptor(configPath, operationId) {
  if (!configPath) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")), cached = JSON.parse(fs.readFileSync(descriptorPath(configPath), "utf8"));
    if (!config.managerGuid || cached.version !== 1 || cached.data?.managerGuid !== config.managerGuid
      || cached.sha256 !== createHash("sha256").update(JSON.stringify(cached.data)).digest("hex")) return undefined;
    const catalog = cached.data.catalog, entry = catalog.operations?.find(item => item.id === operationId || item.contract?.aliases?.includes(operationId));
    if (!entry || entry.binding || entry.contract.method !== "POST" || entry.contract.pathTemplate !== "/api/agent/threads") return undefined;
    return catalog;
  } catch { return undefined; }
}
