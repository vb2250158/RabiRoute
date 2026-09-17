import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Adapter tag the Manager uses to route this hook stream. Antigravity must send
 * it explicitly: the Manager treats an untagged Hook request as Codex, because
 * the older Hook packages predate adapter tagging.
 */
export const AGENT_TYPE = String(process.env.RABI_AGENT_TYPE || "antigravity").trim() || "antigravity";

/**
 * Antigravity event names mapped onto the Manager's hook vocabulary. The
 * Manager speaks Codex's five events; Antigravity has no `SessionStart` and no
 * `UserPromptSubmit`, so `PreInvocation` carries the per-turn prompt and
 * `PostToolUse` carries the tool-loop observation.
 */
const EVENT_MAP = {
  PreInvocation: "UserPromptSubmit",
  PostInvocation: "Stop",
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  Stop: "Stop"
};

function discoverManagerUrlFromHost(env) {
  const candidates = [
    env.RABIROUTE_HOST_EXE,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "RabiRoute", "RabiRouteHost.exe")
  ].filter(Boolean);
  for (const executable of candidates) {
    if (!fs.existsSync(executable)) continue;
    const result = spawnSync(executable, ["--command", "status", "--json"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000
    });
    if (result.status !== 0 || !result.stdout) continue;
    try {
      const descriptor = JSON.parse(result.stdout.trim());
      const baseUrl = String(descriptor.managerBaseUrl || descriptor.baseUrl || "").trim();
      if (/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) return baseUrl;
    } catch {
      // A stale or non-RabiRoute executable is not a discovery source.
    }
  }
  return "";
}

export function resolveManagerUrl(env = process.env) {
  const value = String(env.RABI_MANAGER_URL || env.RABI_CODEX_MANAGER_URL || discoverManagerUrlFromHost(env))
    .trim()
    .replace(/\/+$/, "");
  if (!value) throw new Error("RabiRoute Host is not running and no explicit Manager URL was supplied.");
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, message: text };
  }
}

export async function requestManager(pathname, init = {}, options = {}) {
  if (pathname === "/api/codex-hook/context" && !options.managerUrl && !options.env) {
    const directory = process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RabiAgent")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "RabiAgent")
        : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "RabiAgent");
    const helper = path.join(directory, "hook-client.mjs");
    if (fs.existsSync(helper)) {
      const { requestInstanceHook } = await import(new URL(`file://${helper.replace(/\\/g, "/")}`).href);
      const result = await requestInstanceHook(JSON.parse(init.body || "{}"), path.join(directory, "config.json"));
      if (result !== undefined) return result;
    }
  }
  const managerUrl = String(options.managerUrl || resolveManagerUrl(options.env)).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${managerUrl}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json; charset=utf-8" } : {}),
        ...init.headers
      },
      signal: controller.signal
    });
    const payload = await responseBody(response);
    if (!response.ok || payload?.code === -1) {
      throw new Error(String(payload?.message || `Rabi Manager request failed: HTTP ${response.status}`));
    }
    return payload?.data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Rabi Manager request timed out after ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the newest user turn from the transcript the payload already points at. */
export function readPromptFromTranscript(transcriptPath) {
  const file = String(transcriptPath || "").trim();
  if (!file || !fs.existsSync(file)) return "";
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(record?.type || "");
    if (type !== "USER_INPUT" && type !== "SYSTEM_MESSAGE") continue;
    const content = String(record?.content || "").trim();
    if (content) return content;
  }
  return "";
}

/**
 * Translate an Antigravity hook payload into the Manager's request shape.
 *
 * Antigravity identifies a conversation by `conversationId` and supplies the
 * transcript path directly, so the Manager can bind and recover receipts
 * without any extra discovery.
 */
export function toManagerRequest(input) {
  const eventName = String(input?.hook_event_name || input?.eventName || "").trim();
  const managerEvent = EVENT_MAP[eventName] || eventName;
  const conversationId = String(input?.conversationId || input?.conversation_id || "").trim();
  const transcriptPath = String(input?.transcriptPath || "").trim();
  const prompt = String(input?.prompt || "").trim() || readPromptFromTranscript(transcriptPath);
  const workspacePaths = Array.isArray(input?.workspacePaths) ? input.workspacePaths.filter(Boolean) : [];
  return {
    agentType: AGENT_TYPE,
    sessionId: conversationId,
    eventName: managerEvent,
    hook_event_name: eventName,
    prompt,
    cwd: workspacePaths[0] ? String(workspacePaths[0]) : undefined,
    toolName: input?.toolName || input?.tool_name,
    toolInput: input?.toolInput ?? input?.tool_input,
    toolResponse: input?.toolResponse ?? input?.tool_response,
    toolUseId: input?.toolUseId || input?.tool_use_id,
    stopHookActive: input?.stopHookActive === true || input?.stop_hook_active === true,
    lastAssistantMessage: input?.lastAssistantMessage || input?.last_assistant_message,
    // Carried through for receipts and diagnostics; the Manager ignores extras.
    transcriptPath,
    artifactDirectoryPath: input?.artifactDirectoryPath,
    initialNumSteps: input?.initialNumSteps,
    modelName: input?.modelName
  };
}

/**
 * Render Manager context as Antigravity's injection shape.
 *
 * Antigravity has no `additionalContext` field: context is injected as an extra
 * step with `injectSteps[].userMessage`, which the transcript records with
 * `source: SYSTEM_SDK` — distinct from `USER_EXPLICIT`, so an injected turn is
 * always identifiable after the fact.
 */
function injectStepOutput(step) {
  const userMessage = String(step || "");
  return userMessage ? { injectSteps: [{ userMessage }] } : null;
}

function allowOutput() {
  // `PreToolUse` treats an empty object as a DENY, so allowing must be explicit.
  return {};
}

function shouldExposeManagerFailure(input) {
  const eventName = String(input?.hook_event_name || input?.eventName || "");
  if (eventName === "PreInvocation") return true;
  return String(input?.prompt || "").toLowerCase().includes("[rabi:");
}

export async function handleAntigravityHookInput(input, options = {}) {
  const eventName = String(input?.hook_event_name || input?.eventName || "").trim();
  if (!Object.keys(EVENT_MAP).includes(eventName)) return null;

  const conversationId = String(input?.conversationId || "").trim();
  if (!conversationId) {
    // Without a conversation id the Manager cannot bind a session, and guessing
    // one risks writing into somebody else's conversation. Fail closed.
    process.stderr.write("[rabi-antigravity-context] hook payload carried no conversationId; skipping.\n");
    return eventName === "PreToolUse" ? allowOutput() : null;
  }

  try {
    const data = await requestManager("/api/codex-hook/context", {
      method: "POST",
      body: JSON.stringify(toManagerRequest(input))
    }, options);

    if (eventName === "PreToolUse") {
      if (data?.toolDecision?.permissionDecision === "deny") {
        const reason = String(data.toolDecision.reason || "RabiRoute blocked this direct Agent task delivery.");
        return { permissionDecision: "deny", permissionDecisionReason: reason };
      }
      return allowOutput();
    }

    if (eventName === "Stop") {
      const messages = [];
      if (data?.followup?.decision === "block" && data.followup.reason) {
        messages.push(String(data.followup.reason));
      }
      const completion = data?.planTaskCompletion;
      if (completion?.status === "failed") {
        messages.push(`Rabi plan-task completion reminder failed: ${completion.error || completion.reason || "unknown error"}`);
      }
      if (data?.projectFileChangeReminder?.status === "delivered") {
        messages.push("本轮已修改项目文件。请检查绑定计划的 status、currentStep、steps、证据和附件是否需要按实际进展更新；RabiRoute 没有自动修改计划。");
      }
      const context = String(data?.additionalContext || "").trim();
      const combined = [...messages, context].filter(Boolean).join("\n\n");
      return combined ? injectStepOutput(combined) : null;
    }

    return injectStepOutput(data?.additionalContext);
  } catch (error) {
    if (eventName === "PreToolUse") {
      // Never fail closed on a Manager outage for tool calls: that would block
      // every tool in the conversation because RabiRoute was briefly down.
      process.stderr.write(`[rabi-antigravity-context] Manager unavailable during PreToolUse: ${error instanceof Error ? error.message : String(error)}\n`);
      return allowOutput();
    }
    if (!shouldExposeManagerFailure(input)) return null;
    const message = error instanceof Error ? error.message : String(error);
    return injectStepOutput(
      `[Rabi Antigravity]\nRabi PC Manager 当前不可用：${message}\n本轮没有注入人格、计划、记忆或角色技能；不得使用插件本地缓存补造上下文。`
    );
  }
}
