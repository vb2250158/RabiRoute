import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TYPE, handleHookInput, requestManager } from "./lib/rabi-manager-client.mjs";

const HOOK_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
const startedAt = Date.now();

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

// Only fixed status/event values and timing enter diagnostics, never hook data.
function diagnostic(event, outcome) {
  return { event, outcome, elapsedMs: Date.now() - startedAt };
}

function appendDiagnostic(record) {
  try {
    const base = process.env.RABI_WORKBUDDY_LOG_DIR?.trim()
      || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RabiRoute", "logs");
    fs.mkdirSync(base, { recursive: true });
    const file = path.join(base, "workbuddy-hook.jsonl");
    try {
      if (fs.statSync(file).size > 2 * 1024 * 1024) fs.rmSync(file, { force: true });
    } catch {
      // A missing file needs no rotation.
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Diagnostics must not affect a WorkBuddy turn.
  }
}

function isManagerFailure(output) {
  return [output?.hookSpecificOutput?.additionalContext, output?.systemMessage,
    output?.reason, output?.hookSpecificOutput?.permissionDecisionReason]
    .some((text) => typeof text === "string" && (text.includes("Rabi PC Manager 当前不可用")
      || text.includes("Rabi PC context service is unavailable")));
}

// The shared client still embeds request error text in fail-open diagnostics.
// Replace the entire diagnostic (including multiline errors), not token patterns.
function safeHookOutput(output, event) {
  if (isManagerFailure(output)
    || (event === "Stop" && /未送达|未完成|failed/i.test(String(output?.systemMessage || "")))) {
    const detail = "Rabi Hook 诊断不可用；原有控制决定保持不变。";
    const specific = output.hookSpecificOutput;
    const safe = { systemMessage: detail };
    // Copy only protocol controls, never raw diagnostic text or arbitrary fields.
    // In particular, sanitizing a deny/block must not turn it into fail-open.
    if (Object.hasOwn(output, "continue")) safe.continue = output.continue;
    if (Object.hasOwn(output, "decision")) safe.decision = output.decision;
    if (Object.hasOwn(output, "reason")) safe.reason = detail;
    if (specific) {
      safe.hookSpecificOutput = { hookEventName: event };
      if (Object.hasOwn(specific, "additionalContext")) {
        safe.hookSpecificOutput.additionalContext = "[Rabi WorkBuddy]\nRabi PC Manager 当前不可用。\n本轮没有注入人格、计划、记忆或角色技能；不得使用插件本地缓存补造上下文。";
      }
      if (Object.hasOwn(specific, "permissionDecision")) {
        safe.hookSpecificOutput.permissionDecision = specific.permissionDecision;
      }
      if (Object.hasOwn(specific, "permissionDecisionReason")) {
        safe.hookSpecificOutput.permissionDecisionReason = detail;
      }
      // updatedInput is a business payload, not diagnostics: preserve it only
      // in protocol output and never include it in local logs.
      if (Object.hasOwn(specific, "updatedInput")) {
        safe.hookSpecificOutput.updatedInput = specific.updatedInput;
      }
    }
    return safe;
  }
  return output;
}

if (process.argv.includes("--self-check")) {
  const verdict = { ok: false, script: "rabi-workbuddy-hook.mjs", event: "SessionStart" };
  try {
    // handleHookInput folds empty responses and some failures into null. The
    // session helper can also synthesize empty context for a disabled agent.
    // Require nonempty context evidence; an empty result is unconfirmed, not
    // proof that Manager is either healthy or offline.
    const data = await requestManager("/api/codex-hook/context", {
      method: "POST",
      body: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "rabi-self-check",
        transcript_path: "",
        cwd: process.cwd(),
        agentType: AGENT_TYPE
      })
    });
    if (!data || typeof data.additionalContext !== "string" || !data.additionalContext.trim()
      || isManagerFailure({ hookSpecificOutput: data })) {
      verdict.error = "manager-response-unconfirmed";
      verdict.detail = "未取得可验证上下文；尚未确认可用";
    } else {
      verdict.ok = true;
      verdict.injected = true;
      verdict.detail = "已取得可验证上下文";
    }
  } catch {
    verdict.error = "manager-request-failed";
    verdict.detail = "未连通：自检请求失败";
  }
  verdict.elapsedMs = Date.now() - startedAt;
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  process.exitCode = verdict.ok ? 0 : 1;
} else {
  let event = "unknown";
  try {
    const input = await readStdin();
    event = HOOK_EVENTS.has(input?.hook_event_name) ? input.hook_event_name : "unknown";
    // Manager owns context, binding and permission decisions. Preserve ordinary
    // protocol output, but never forward raw exception text as diagnostics.
    const output = await handleHookInput(input);
    const safeOutput = safeHookOutput(output, event);
    if (safeOutput) process.stdout.write(`${JSON.stringify(safeOutput)}\n`);
    appendDiagnostic(diagnostic(event, safeOutput !== output ? "failed" : output ? "delivered" : "noop"));
  } catch {
    const record = diagnostic(event, "failed");
    process.stderr.write(`${JSON.stringify(record)}\n`);
    appendDiagnostic(record);
  }
}
