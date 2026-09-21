import fs from "node:fs";
import path from "node:path";
import { createManagerClient } from "./manager-client.mjs";

/** Installed beside private config; Hook callers send only their own registered session. */
export async function requestInstanceHook(input, configPath, fetcher = fetch) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sessionId = input.session_id || input.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim() || (input.session_id && input.sessionId && input.session_id !== input.sessionId)) return undefined;
  const agents = config.agents || [{ agentId: "default", enabled: true, sessionId: config.agentType === "dsh" ? config.dsh?.sessionId : config.codexDesktop?.threadId }];
  const matches = agents.filter(agent => agent.sessionId === sessionId || agent.managedSessionIds?.includes(sessionId));
  if (matches.length !== 1) return undefined;
  const agent = matches[0];
  if (agent.enabled === false) return { action: "none", additionalContext: "" };
  if (!config.nodeCredential) throw new Error("Legacy shared credentials are not accepted; re-enroll this connector with a node credential.");
  const client = createManagerClient({ managerUrl: config.managerUrl, credential: config.nodeCredential, agentId: agent.agentId, fetchImpl: fetcher, timeoutMs: 8000 });
  const receipt = await client.invoke("POST", `/api/lan-agent/instances/${encodeURIComponent(config.nodeId)}/agents/${encodeURIComponent(agent.agentId)}/context`, { body: input });
  if (receipt.uncertain || receipt.identityChanged) throw new Error("Instance Hook result is uncertain or Manager identity changed; do not retry automatically.");
  let body;
  try { body = JSON.parse(receipt.body); } catch { throw new Error("Instance Hook returned an invalid response."); }
  if (!receipt.ok || body?.code !== 0 || !body.data || typeof body.data !== "object") throw new Error("Instance Hook failed; inspect the Manager decision.");
  const decision = body.data;
  // Authorization stays with Manager. Never replace or weaken its deny decision.
  if (decision.action === "deny" || decision.decision === "deny" || decision.permissionDecision === "deny" || decision.hookSpecificOutput?.permissionDecision === "deny") return decision;
  const launcher = path.join(path.dirname(path.resolve(configPath)), "rabi-agent-launcher.mjs");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} --config ${JSON.stringify(path.resolve(configPath))} --agent ${JSON.stringify(agent.agentId)} --api`;
  const guidance = [
    "[RabiRoute Manager API]",
    `This binding applies only to the current session ${JSON.stringify(sessionId)}; do not reuse it for another session.`,
    "On this remote computer, use this installed transport even when a Skill describes local RabiRouteHost discovery. Missing a local Host does not mean Manager is offline; do not launch a second Host or read local business files as a fallback.",
    `Use the installed command: ${command} METHOD /relative-path.`,
    `To upload a local file, replace --api with --upload FILE --upload-id UUID. Keep that UUID stable; upload never sends automatically. Use the returned id as payload.fileId and sha256 as payload.fileSha256 with type=file through /api/agent/send (NapCat group only); do not pass the remote local path. Check upload and channel receipts separately.`,
    `For external Agent delivery, use exactly POST /api/agent/send with JSON fields deliveryId (stable retry key), sender:{agentType,sessionId}, routeId, channel, params, payload. Do not use conversationId, recipient, message, or a bare payload. Read docs/rabi-agent-interfaces.md for the current channel params and source-specific sender template before sending. On timeout or Manager generation change, read GET /api/agent/send/receipts/<same deliveryId> before retrying; never invent a new deliveryId.`,
    `Discover allowed operations: ${command} GET /api/lan-agent/capabilities`,
    `Discover resources and contracts: ${command} GET /api/lan-agent/resources`,
    `Read the API contract before business calls: ${command} GET /api/lan-agent/resources/read?id=docs/rabi-agent-interfaces.md`,
    `Read the planning Skill before plan operations: ${command} GET /api/lan-agent/resources/read?id=skills/plan-task-orchestration/SKILL.md`,
    "For JSON mutations use --body-stdin; preserve --idempotency-key and --if-match receipts. Inspect uncertain results before any retry. Manager deny decisions and host permissions remain authoritative. Never expose the private node credential."
  ].join("\n");
  return { ...decision, additionalContext: [decision.additionalContext, guidance].filter(Boolean).join("\n\n") };
}
