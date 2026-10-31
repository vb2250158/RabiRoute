import fs from "node:fs";
import path from "node:path";
import { discoverWindowsHostIdentity } from "./windows-host-discovery.mjs";
import os from "node:os";
import { pathToFileURL } from "node:url";

import { getTimeoutMs } from "./timeout-settings.mjs";
const DEFAULT_TIMEOUT_MS = 8000;

export async function resolveManagerUrl(env = process.env) {
  return (await discoverWindowsHostIdentity({ env })).managerBaseUrl;
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
    const directory = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "RabiAgent") : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "RabiAgent") : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "RabiAgent");
    const helper = path.join(directory, "hook-client.mjs");
    if (fs.existsSync(helper)) {
      const { requestInstanceHook } = await import(pathToFileURL(helper).href);
      const result = await requestInstanceHook({ ...JSON.parse(init.body || "{}"), agentType: "codex" }, path.join(directory, "config.json"));
      if (result !== undefined) return result;
    }
  }
  const managerUrl = String(options.managerUrl || await resolveManagerUrl(options.env)).replace(/\/+$/, "");
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs ?? getTimeoutMs("hooks.manager.request", DEFAULT_TIMEOUT_MS, options.env ?? process.env));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${managerUrl}${pathname}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json; charset=utf-8" } : {}),
        ...init.headers
      },
      signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
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

/**
 * Standalone Hook packages share this display contract. Receipt recovery stays
 * with the delivery owner; consuming a result never resends its message.
 */
function completionDeliveryMessages(deliveries) {
  if (!Array.isArray(deliveries)) return [];
  return deliveries.flatMap(delivery => {
    if (!delivery || typeof delivery !== "object") return [];
    const status = String(delivery.status || delivery.state || "unknown");
    if (["sent", "received", "ignored", "skipped"].includes(status)) return [];
    const outcome = status === "failed" ? "发送失败"
      : status === "blocked" ? "发送受阻"
      : status === "cancelled" ? "已取消" : "送达待确认";
    const deliveryId = typeof delivery.deliveryId === "string" && delivery.deliveryId.trim() ? delivery.deliveryId : "未返回";
    const recoveryState = typeof delivery.recoveryState === "string" && delivery.recoveryState.trim() ? delivery.recoveryState : "未返回";
    const rule = typeof delivery.ruleId === "string" && delivery.ruleId ? `规则 ${delivery.ruleId}；` : "";
    const reason = typeof delivery.reason === "string" ? delivery.reason : typeof delivery.error === "string" ? delivery.error : "";
    return [`Rabi 完成通知${outcome}：${rule}投递编号 ${deliveryId}；投递状态 ${status}；恢复状态 ${recoveryState}${reason ? `；${reason}` : ""}`];
  });
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
      if (!input.stop_hook_active && data?.followup?.decision === "block" && data.followup.reason) {
        return { decision: "block", reason: String(data.followup.reason) };
      }
      const completion = data?.planTaskCompletion;
      const projectFileChangeReminder = data?.projectFileChangeReminder;
      const agentRequestStop = data?.agentRequestStop;
      const messages = completionDeliveryMessages(data?.completionDeliveries);
      if (agentRequestStop?.status === "failed") {
        messages.push(`Rabi Agent request Stop check failed: ${agentRequestStop.error || agentRequestStop.reason || "unknown error"}`);
      }
      if (projectFileChangeReminder?.status === "failed") {
        messages.push(`Rabi 项目文件改动后的计划检查提醒未完成：${projectFileChangeReminder.error || projectFileChangeReminder.reason || "unknown error"}`);
      }
      if (projectFileChangeReminder?.status === "delivered") {
        messages.push("本轮已修改项目文件。请检查绑定计划的 status、currentStep、steps、证据和附件是否需要按实际进展更新；RabiRoute 没有自动修改计划。");
      }
      if (completion?.status === "failed") {
        messages.push(`Rabi plan-task completion reminder failed: ${completion.error || completion.reason || "unknown error"}`);
      }
      return messages.length > 0 ? { systemMessage: messages.join("\n") } : null;
    }
    return hookOutput(eventName, String(data?.additionalContext || ""));
  } catch (error) {
    if (eventName === "Stop") {
      const message = error instanceof Error ? error.message : String(error);
      return { systemMessage: `Rabi 计划完成提醒或项目文件改动检查提醒未送达：${message}` };
    }
    if (!shouldExposeManagerFailure(input)) return null;
    const message = error instanceof Error ? error.message : String(error);
    return hookOutput(
      eventName,
      `[Rabi Codex]\nRabi PC Manager 当前不可用：${message}\n本轮没有注入角色、计划、记忆或角色技能；不得使用插件本地缓存补造上下文。`,
      "Rabi PC context service is unavailable; Codex continued without invented Rabi context."
    );
  }
}
