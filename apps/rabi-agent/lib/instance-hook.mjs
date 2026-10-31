import fs from "node:fs";
import path from "node:path";
import { createManagerClient } from "./manager-client.mjs";

/** The Hook supplies this invocation's actual type and session; no saved binding exists. */
export async function requestInstanceHook(input, configPath, fetcher = fetch, { discover } = {}) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const sessionId = input.session_id || input.sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim() || (input.session_id && input.sessionId && input.session_id !== input.sessionId)) return undefined;
  const agentType = input.agentType;
  if (typeof agentType !== "string" || !agentType.trim()) throw new Error("Hook must provide its explicit Agent type.");
  if (!config.nodeCredential) throw new Error("An enrolled computer credential is required.");
  const client = createManagerClient({ config, configPath, agentType, sessionId, fetchImpl: fetcher, discover, timeoutMs: 8000 });
  const receipt = await client.invoke("POST", "/api/codex-hook/context", { body: input });
  if (receipt.uncertain || receipt.identityChanged) throw new Error("Instance Hook result is uncertain or Manager identity changed; do not retry automatically.");
  let body;
  try { body = JSON.parse(receipt.body); } catch { throw new Error("Instance Hook returned an invalid response."); }
  if (!receipt.ok || body?.code !== 0 || !body.data || typeof body.data !== "object") throw new Error("Instance Hook failed; inspect the Manager decision.");
  const decision = body.data;
  // Authorization stays with Manager. Never replace or weaken its deny decision.
  if (decision.action === "deny" || decision.decision === "deny" || decision.permissionDecision === "deny" || decision.hookSpecificOutput?.permissionDecision === "deny") return decision;
  const launcher = path.join(path.dirname(path.resolve(configPath)), "rabi-agent-launcher.mjs");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} --config ${JSON.stringify(path.resolve(configPath))} --agent-type ${JSON.stringify(agentType)} --id ${JSON.stringify(sessionId)} --api`;
  const guidance = [
    "[RabiRoute Manager API]",
    `For each invocation explicitly pass its actual Agent type and full session ID. Current invocation: ${JSON.stringify(agentType)}, ${JSON.stringify(sessionId)}.`,
    "On this remote computer, use this installed transport even when a Skill describes local RabiRouteHost discovery. Missing a local Host does not mean Manager is offline; do not launch a second Host or read local business files as a fallback.",
    `Use the installed command: ${command} METHOD /relative-path.`,
    `For Agent-to-Agent action=send or a formal reply, POST /api/agent/threads through this command durably submits to this computer's existing connector owner. Keep deliveryId stable. Local accepted/queued is not target received: inspect --delivery-query SAME_INTENT_ID or --delivery-list through the same launcher, without --api. The connector owns endpoint discovery and recovery after CLI exit; do not repair ports, change IDs or manually repeat an unknown send. You may explicitly use --delivery-submit with stdin {intentId,request} and the same source arguments.`,
    `To upload a local file, replace --api with --upload FILE --upload-id UUID. Keep that UUID stable; upload never sends automatically. Use the returned id as payload.fileId and sha256 as payload.fileSha256 with type=file through /api/agent/send (NapCat group only); do not pass the remote local path. Check upload and channel receipts separately.`,
    `For external Agent delivery, use exactly POST /api/agent/send with JSON fields deliveryId (stable retry key), sender:{agentType,sessionId}, routeId, channel, params, payload. Do not use conversationId, recipient, message, or a bare payload. Read docs/rabi-agent-interfaces.md for the current channel params and source-specific sender template before sending. On timeout or Manager generation change, read GET /api/agent/send/receipts/<same deliveryId> before retrying; never invent a new deliveryId.`,
    `When the user explicitly requests a specific role Skill folder, discover it with GET /api/roles/ROLE_ID/skills, then download the complete ZIP with ${command} GET /api/roles/ROLE_ID/skills/SKILL_ID/download --output "ABSOLUTE_LOCAL_ZIP_PATH" (the /roles alias is also supported). Choose that absolute file path only from the direct user request, outside the installation and under an existing parent directory; the launcher does not use the caller's project as cwd. No query, automatic retry, extraction or execution. A downloadable file, including .mac or .ps1, is not permission to execute it.`,
    `Discover allowed operations: ${command} GET /api/lan-agent/capabilities`,
    `Discover resources and contracts: ${command} GET /api/lan-agent/resources`,
    `Read the API contract before business calls: ${command} GET /api/lan-agent/resources/read?id=docs/rabi-agent-interfaces.md`,
    `Read the planning Skill before plan operations: ${command} GET /api/lan-agent/resources/read?id=skills/plan-task-orchestration/SKILL.md`,
    "For JSON mutations use --body-stdin; preserve --idempotency-key and --if-match receipts. Inspect uncertain results before any retry. Manager deny decisions and host permissions remain authoritative. Never expose the private node credential."
  ].join("\n");
  return { ...decision, additionalContext: [decision.additionalContext, guidance].filter(Boolean).join("\n\n") };
}
