import fs from "node:fs";
import { createManagerClient } from "./manager-client.mjs";

/** Explicit CLI invocation uses the existing host shell, never a second Agent runtime. */
export async function runManagerCommand(args, configPath, { fetchImpl = fetch, readInput = async () => "" } = {}) {
  const commandIndex = args.indexOf("--api");
  const uploading = args.includes("--upload");
  if (uploading && commandIndex >= 0) throw new Error("--upload and --api are mutually exclusive.");
  if (!uploading && commandIndex < 0) throw new Error("Missing --api or --upload command.");
  const method = commandIndex >= 0 ? args[commandIndex + 1] : undefined;
  const target = commandIndex >= 0 ? args[commandIndex + 2] : undefined;
  if (!uploading && (!method || !target)) throw new Error("Usage: --api METHOD /relative-path --agent AGENT_ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]");
  function option(name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
    return value;
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.nodeCredential) throw new Error("This connector must be enrolled with an independent node credential; shared WebGUI credentials are not accepted.");
  const agentId = option("--agent");
  const agent = config.agents?.find(item => item.agentId === agentId);
  if (!agentId || !agent) throw new Error("Select a registered Agent with --agent; identities are never guessed.");
  if (agent.enabled === false) throw new Error("The selected Agent is disabled.");
  const client = createManagerClient({ managerUrl: config.managerUrl, credential: config.nodeCredential, agentId, fetchImpl });
  if (uploading) {
    if (["--body-stdin", "--if-match", "--idempotency-key"].some(flag => args.includes(flag))) throw new Error("--upload does not accept API body or header options; --upload-id is the stable idempotency key.");
    return client.upload(option("--upload"), option("--upload-id"));
  }
  if (args.includes("--upload-id")) throw new Error("--upload-id requires --upload.");
  const headers = {};
  const etag = option("--if-match");
  const key = option("--idempotency-key");
  if (etag !== undefined) headers["If-Match"] = etag;
  if (key !== undefined) headers["Idempotency-Key"] = key;
  let body;
  if (args.includes("--body-stdin")) {
    const input = await readInput();
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("Manager request body exceeds 1 MiB.");
    JSON.parse(input); // Validate without reserializing the caller's stable mutation body.
    body = input;
  }
  return client.invoke(method, target, { body, headers });
}
