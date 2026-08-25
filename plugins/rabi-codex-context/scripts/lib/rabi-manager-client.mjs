const DEFAULT_MANAGER_URL = "http://127.0.0.1:8790";
const DEFAULT_TIMEOUT_MS = 8000;

export function resolveManagerUrl(env = process.env) {
  return String(env.RABI_MANAGER_URL || env.RABI_CODEX_MANAGER_URL || DEFAULT_MANAGER_URL)
    .trim()
    .replace(/\/+$/, "");
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

function hookOutput(eventName, additionalContext, systemMessage) {
  if (!additionalContext) return null;
  return {
    ...(["SessionStart", "UserPromptSubmit"].includes(eventName) ? { continue: true } : {}),
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  };
}

function shouldExposeManagerFailure(input) {
  return String(input?.hook_event_name || "") === "SessionStart"
    || String(input?.prompt || "").toLowerCase().includes("[rabi:");
}

export async function handleHookInput(input, options = {}) {
  const eventName = String(input?.hook_event_name || "");
  if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(eventName)) return null;
  try {
    const data = await requestManager("/api/codex-hook/context", {
      method: "POST",
      body: JSON.stringify(input)
    }, options);
    if (eventName === "PreToolUse" && data?.toolDecision?.permissionDecision === "deny") {
      const reason = String(data.toolDecision.reason || "RabiRoute blocked this direct Agent task delivery.");
      return {
        systemMessage: reason,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      };
    }
    if (eventName === "Stop") {
      const completion = data?.planTaskCompletion;
      const progress = data?.pangHuProgressNotification;
      const agentRequestStop = data?.agentRequestStop;
      if (agentRequestStop?.status === "failed") {
        return {
          systemMessage: `Rabi Agent request Stop check failed: ${agentRequestStop.error || agentRequestStop.reason || "unknown error"}`
        };
      }
      if (progress?.status === "failed") {
        return {
          systemMessage: `PangHu 工作群进度同步未取得完整回执，当前任务保持进行中：${progress.error || progress.reason || "unknown error"}`
        };
      }
      if (completion?.status === "failed") {
        return {
          systemMessage: `Rabi plan-task completion reminder failed: ${completion.error || completion.reason || "unknown error"}`
        };
      }
      return null;
    }
    return hookOutput(eventName, String(data?.additionalContext || ""));
  } catch (error) {
    if (eventName === "Stop") {
      const message = error instanceof Error ? error.message : String(error);
      return { systemMessage: `Rabi plan-task completion reminder was not delivered: ${message}` };
    }
    if (!shouldExposeManagerFailure(input)) return null;
    const message = error instanceof Error ? error.message : String(error);
    return hookOutput(
      eventName,
      `[Rabi Codex]\nRabi PC Manager 当前不可用：${message}\n本轮没有注入人格、计划、记忆或角色技能；不得使用插件本地缓存补造上下文。`,
      "Rabi PC context service is unavailable; Codex continued without invented Rabi context."
    );
  }
}
