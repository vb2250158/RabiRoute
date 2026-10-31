import { createTimeoutSettings } from "./timeout-settings.mjs";
import fs from "node:fs";
import { createManagerClient, isSkillDownloadTarget } from "./manager-client.mjs";
import { runManagerWebSocketCommand } from "./manager-websocket-cli.mjs";

/** Explicit CLI invocation uses the existing host shell, never a second Agent runtime. */
export async function runManagerCommand(args, configPath, { fetchImpl = fetch, discover, readInput = async () => "", inputStream = process.stdin } = {}) {
  const commandIndex = args.indexOf("--api");
  const operationIndex = args.indexOf("--operation");
  const operationId = operationIndex >= 0 ? args[operationIndex + 1] : undefined;
  const uploading = args.includes("--upload");
  if (Number(uploading) + Number(commandIndex >= 0) + Number(operationIndex >= 0) !== 1) throw new Error("Choose exactly one --api, --operation or --upload command.");
  if (operationIndex >= 0 && (!operationId || operationId.startsWith("--"))) throw new Error("--operation requires an operation ID from current discovery.");
  if (args.filter(item => item === "--operation").length > 1) throw new Error("Duplicate --operation command.");
  const method = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
  const target = commandIndex >= 0 ? args[commandIndex + 2] : undefined;
  if (!uploading && operationIndex < 0 && (!method || !target)) throw new Error("Usage: --api METHOD /relative-path --agent-type TYPE --id FULL_SESSION_ID [--body-stdin | --raw-stdin | --body-file FILE] [--header 'Name: value'] [--output FILE] [--stream --output FILE] [--timeout-ms N] [--no-replay]");
  if (args.filter(item => item === "--api").length > 1) throw new Error("Duplicate --api command.");
  function option(name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (args.indexOf(name, index + 1) >= 0) throw new Error(`Duplicate option ${name}.`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    return value;
  }
  const output = option("--output");
  const downloadTarget = isSkillDownloadTarget(target);
  const downloading = output !== undefined && downloadTarget;
  const bodyFlags = ["--body-stdin", "--raw-stdin", "--body-file"].filter(flag => args.includes(flag));
  if (bodyFlags.length > 1) throw new Error("Choose one API body input format.");
  const websocket = args.includes("--websocket");
  if (args.includes("--method") && (!operationId || websocket)) throw new Error("--method is an HTTP --operation option; --api already supplies its method.");
  const wsOptions = ["--frames-stdin", "--ws-protocols", "--ws-max-output-bytes", "--ws-max-message-bytes", "--ws-max-buffered-bytes"];
  if (!websocket && wsOptions.some(flag => args.includes(flag))) throw new Error("WebSocket frame options require --websocket.");
  if (websocket && (!operationId || !output || bodyFlags.length || uploading || args.includes("--stream"))) throw new Error("Use --operation ID --websocket --output FILE [--frames-stdin], without HTTP bodies, upload or --stream.");
  if (args.includes("--stream") && !output) throw new Error("CLI event/stream consumption requires --stream --output FILE.");
  if (downloading) {
    if (args.filter(item => item === "--output").length !== 1 || args.filter(item => item === "--api").length !== 1 || uploading || method !== "GET" || ["--body-stdin", "--raw-stdin", "--body-file", "--header", "--if-match", "--idempotency-key", "--upload-id", "--stream"].some(flag => args.includes(flag))) throw new Error("Skill --output requires GET without mutation, upload, body or header options.");
  } else if (downloadTarget) throw new Error("Skill download requires --output <local.zip>; binary output is never printed.");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.nodeCredential) throw new Error("This connector must be enrolled with an independent node credential; shared WebGUI credentials are not accepted.");
  if (args.includes("--agent")) throw new Error("--agent registration was removed. Use --agent-type TYPE --id FULL_SESSION_ID.");
  const agentType = option("--agent-type");
  const sessionId = option("--id");
  if (!agentType || !sessionId) throw new Error("Each call requires --agent-type TYPE and --id FULL_SESSION_ID; no registration or binding is required.");
  const client = createManagerClient({ config, configPath, agentType, sessionId, fetchImpl, discover });
  if (downloading) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try { return await client.download(target, option("--output"), { signal: controller.signal }); }
    finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
  if (uploading) {
    if (output || ["--body-stdin", "--raw-stdin", "--body-file", "--header", "--if-match", "--idempotency-key", "--stream"].some(flag => args.includes(flag))) throw new Error("--upload does not accept API body, output or header options; --upload-id is the stable idempotency key.");
    return client.upload(option("--upload"), option("--upload-id"));
  }
  if (args.includes("--upload-id")) throw new Error("--upload-id requires --upload.");
  const headers = Object.create(null);
  function header(name, value) {
    const key = name.toLowerCase();
    if (Object.hasOwn(headers, key)) throw new Error("Duplicate API header.");
    headers[key] = value;
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--header") continue;
    const match = /^([^:]+):[ \t]*(.*)$/.exec(args[++index] ?? "");
    if (!match) throw new Error("--header requires 'Name: value'.");
    header(match[1], match[2]);
  }
  const etag = option("--if-match");
  const key = option("--idempotency-key");
  if (etag !== undefined) header("If-Match", etag);
  if (key !== undefined) header("Idempotency-Key", key);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let file;
  let stream;
  const options = { headers, signal: controller.signal, ...(args.includes("--no-replay") ? { replaySafe: false } : {}), ...(output ? { outputPath: output } : {}) };
  const timeout = option("--timeout-ms");
  if (timeout !== undefined) {
    if (!/^[1-9][0-9]*$/.test(timeout) || !Number.isSafeInteger(Number(timeout)) || Number(timeout) > 0xffffffff) throw new Error("--timeout-ms must be a positive supported millisecond deadline.");
    options.timeoutMs = Number(timeout);
  }
  // Never print a transport credential, including unexpected server reflection.
  function publicReceipt(value) {
    if (typeof value === "string") return value.split(config.nodeCredential).join("[REDACTED]").split(encodeURIComponent(config.nodeCredential)).join("[REDACTED]");
    if (Array.isArray(value)) return value.map(publicReceipt);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [publicReceipt(key), publicReceipt(item)]));
    return value;
  }
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const objectOption = name => {
      const value = option(name);
      if (value === undefined) return {};
      let parsed;
      try { parsed = JSON.parse(value); } catch { throw new Error(`${name} requires a JSON object.`); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} requires a JSON object.`);
      return parsed;
    };
    if (websocket) {
      const integerOption = name => {
        const value = option(name); if (value === undefined) return undefined;
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} requires a positive safe integer.`);
        return Number(value);
      };
      let protocols;
      if (option("--ws-protocols") !== undefined) {
        try { protocols = JSON.parse(option("--ws-protocols")); } catch { throw new Error("--ws-protocols requires a JSON array."); }
        if (!Array.isArray(protocols)) throw new Error("--ws-protocols requires a JSON array.");
      }
      return publicReceipt(await runManagerWebSocketCommand(client, operationId, { outputPath: output,
        inputStream: args.includes("--frames-stdin") ? inputStream : undefined,
        headers, signal: controller.signal, timeoutMs: options.timeoutMs ?? createTimeoutSettings(config.timeoutOverridesCache).get("agent.client.websocket",30000),
        path: objectOption("--path-params"), query: objectOption("--query"), protocols,
        maxOutputBytes: integerOption("--ws-max-output-bytes"), maxMessageBytes: integerOption("--ws-max-message-bytes"), maxBufferedBytes: integerOption("--ws-max-buffered-bytes"),
        redact: publicReceipt, protectedCredential: config.nodeCredential }));
    }
    if (args.includes("--body-stdin")) {
      const input = await readInput();
      JSON.parse(input); // Validate without reserializing the stable mutation body.
      options.body = input;
    } else if (args.includes("--raw-stdin")) {
      const input = await readInput();
      if (typeof input !== "string") throw new Error("Raw stdin requires text; use --body-file for exact binary bytes.");
      options.bodyText = input;
    } else if (args.includes("--body-file")) {
      const filePath = option("--body-file");
      const initial = fs.lstatSync(filePath);
      if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("API body requires a regular file, not a symlink.");
      file = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const current = fs.fstatSync(file);
      if (!current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size) throw new Error("API body file changed before reading.");
      // Keep descriptor ownership here; iterator cancellation must not race a
      // Node ReadStream destroy() closing an externally owned descriptor.
      stream = (async function* () {
        let offset = 0;
        while (true) {
          controller.signal.throwIfAborted();
          const chunk = Buffer.alloc(256 * 1024);
          const bytesRead = fs.readSync(file, chunk, 0, chunk.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          yield chunk.subarray(0, bytesRead);
        }
      })();
      options.bodyStream = stream;
    }
    if (operationId) {
      const operationMethod = option("--method");
      return publicReceipt(await client.invokeOperation(operationId, { ...options, ...(operationMethod ? { method: operationMethod } : {}), path: objectOption("--path-params"), query: objectOption("--query") }));
    }
    return publicReceipt(await client.request(method, target, options));
  } finally {
    if (stream) { try { await stream.return(); } catch { /* Preserve original request result. */ } }
    if (file !== undefined) fs.closeSync(file);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
