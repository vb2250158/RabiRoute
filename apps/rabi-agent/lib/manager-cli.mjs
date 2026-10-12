import fs from "node:fs";
import { createManagerClient, isSkillDownloadTarget } from "./manager-client.mjs";

/** Explicit CLI invocation uses the existing host shell, never a second Agent runtime. */
export async function runManagerCommand(args, configPath, { fetchImpl = fetch, discover, readInput = async () => "" } = {}) {
  const commandIndex = args.indexOf("--api");
  const uploading = args.includes("--upload");
  if (uploading && commandIndex >= 0) throw new Error("--upload and --api are mutually exclusive.");
  if (!uploading && commandIndex < 0) throw new Error("Missing --api or --upload command.");
  const method = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
  const target = commandIndex >= 0 ? args[commandIndex + 2] : undefined;
  if (!uploading && (!method || !target)) throw new Error("Usage: --api METHOD /relative-path --agent AGENT_ID [--body-stdin | --raw-stdin | --body-file FILE] [--header 'Name: value'] [--output FILE] [--stream --output FILE] [--timeout-ms N] [--no-replay]");
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
  if (args.includes("--stream") && !output) throw new Error("CLI event/stream consumption requires --stream --output FILE; live stdout callbacks and WebSocket are not supported.");
  if (downloading) {
    if (args.filter(item => item === "--output").length !== 1 || args.filter(item => item === "--api").length !== 1 || uploading || method !== "GET" || ["--body-stdin", "--raw-stdin", "--body-file", "--header", "--if-match", "--idempotency-key", "--upload-id", "--stream"].some(flag => args.includes(flag))) throw new Error("Skill --output requires GET without mutation, upload, body or header options.");
  } else if (downloadTarget) throw new Error("Skill download requires --output <local.zip>; binary output is never printed.");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.nodeCredential) throw new Error("This connector must be enrolled with an independent node credential; shared WebGUI credentials are not accepted.");
  const agentId = option("--agent");
  const agent = config.agents?.find(item => item.agentId === agentId);
  if (!agentId || !agent) throw new Error("Select a registered Agent with --agent; identities are never guessed.");
  if (agent.enabled === false) throw new Error("The selected Agent is disabled.");
  // Manager authenticates the exact registered ID and owns its current enabled state.
  const client = createManagerClient({ config, configPath, agentId, fetchImpl, discover });
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
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicReceipt(item)]));
    return value;
  }
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
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
    return publicReceipt(await client.request(method, target, options));
  } finally {
    if (stream) { try { await stream.return(); } catch { /* Preserve original request result. */ } }
    if (file !== undefined) fs.closeSync(file);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
