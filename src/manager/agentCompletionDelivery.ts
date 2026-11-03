import { getTimeoutMs } from "../shared/timeoutSettings.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "../vendor/marked.esm.js";
import { promisify } from "node:util";
import type { AgentCompletionDeliveryRule } from "../shared/gatewayConfigModel.js";
import type { CodexHookContextRequest } from "./codexHookContext.js";
import { handleAgentSend, inspectAgentSendDelivery, type AgentSendRequest } from "../agentSend.js";
import type { AgentReplyOptions } from "../outbox.js";
import type { PlanItem } from "../roleKnowledge.js";
import { AGENT_HOOK_EVENTS, agentHookRuleErrors } from "../shared/agentHookAutomation.js";
import { agentAdapterManifest, isAgentAdapterType, agentAdapterSupportsLifecycleHooks as supportsHooks } from "../shared/agentAdapterCapabilities.js";

import { mermaidDiagramSource } from "../markdownImage.js";

const execute = promisify(execFile);
export type CompletionDeliveryResult = { ruleId: string; status: "sent" | "failed"; reason?: string };
export type CompletionRuleOwner = { roleId: string; rule: AgentCompletionDeliveryRule };
export function planCompletionDeliveryRules(roleId: string, plans: readonly Pick<PlanItem, "id" | "taskBinding" | "messageChannels">[], sessionId: string): CompletionRuleOwner[] {
  return plans.filter(plan => plan.taskBinding?.sessionId === sessionId)
    .flatMap(plan => (plan.messageChannels ?? []).map((destination, index) => ({ roleId, rule: {
      id: `plan-${plan.id}-${index}`, enabled: true, event: "task_completed", conditions: [{ type: "bound_plan" }], destination
    } })));
}
export type CompletionTaskContext = { taskName?: string; plans: Array<{ id: string; title: string }>; images?: string[]; imageReadError?: boolean };

/** Only a complete control envelope is interpreted; quoted examples and other XML remain content. */
function completionNotification(text: string): { text: string; heartbeat: boolean } {
  const heartbeat = /^\s*<heartbeat>\s*<automation_id>[^<>]+<\/automation_id>\s*<decision>\s*(DONT_NOTIFY|NOTIFY)\s*<\/decision>\s*<message>([\s\S]*?)<\/message>\s*<\/heartbeat>\s*$/.exec(text);
  if (!heartbeat || /<\/?(?:heartbeat|automation_id|decision|message)>/.test(heartbeat[2])) return { text, heartbeat: false };
  return { text: heartbeat[1] === "DONT_NOTIFY" ? "" : heartbeat[2].trim(), heartbeat: true };
}

/** Preserve every character and Unicode code point across transport-sized messages. */
export function splitCompletionMessage(text: string, maxChars = 3000): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 2) throw new Error("Invalid message chunk size.");
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let end = remaining.lastIndexOf("\n", maxChars - 1) + 1;
    if (!end) end = maxChars;
    const last = remaining.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function completionTaskContextFromPlans(sessionId: string,
  plans: readonly Pick<PlanItem, "id" | "title" | "taskBinding">[], currentTitle?: string): CompletionTaskContext {
  const bound = plans.filter(plan => plan.taskBinding?.sessionId === sessionId);
  return {
    taskName: currentTitle?.trim() || undefined,
    plans: bound.map(plan => ({ id: plan.id, title: plan.title }))
  };
}

/** Parse actual Markdown links, excluding code examples, and retain local absolute file targets. */
export function completionLocalFiles(message: string): string[] {
  const markdown = new Marked();
  const files = new Map<string, string>();
  markdown.walkTokens(markdown.lexer(message), token => {
    if (token.type !== "link") return;
    let value = token.href;
    try {
      value = /^file:/i.test(value) ? fileURLToPath(value) : decodeURIComponent(value);
    } catch { return; }
    value = value.replace(/^\/([a-z]:[\\/])/i, "$1").replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
    if (!path.isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value)) return;
    const resolved = path.normalize(value);
    files.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
  });
  return [...files.values()];
}

type CompletionSegment = { type: "text" | "markdown"; text: string } | { type: "image"; path: string } | { type: "image"; url: string };
type RawToken = { type: string; raw: string; href?: string; tokens?: RawToken[]; items?: RawToken[] };

function imageSegment(href: string, cwd?: string): CompletionSegment | undefined {
  if (/^(?:https?:|base64:)\/\//i.test(href)) return { type: "image", url: href };
  try {
    const file = (/^file:/i.test(href) ? fileURLToPath(href) : decodeURIComponent(href)).replace(/^\/([a-z]:[\\/])/i, "$1");
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return;
    if (path.isAbsolute(file) || /^[a-z]:[\\/]/i.test(file)) return { type: "image", path: path.normalize(file) };
    if (cwd) return { type: "image", path: path.resolve(cwd, file) };
  } catch { /* Preserve the original text when the image reference cannot be resolved. */ }
}

export function completionMessagePayloads(text: string, renderDiagrams: boolean, cwd?: string, images: string[] = [], renderTables = true): Array<Record<string, unknown>> {
  const batches: Array<Record<string, unknown>> = [];
  let segments: CompletionSegment[] = [], chars = 0;
  const flush = () => {
    if (!segments.length) return;
    batches.push(segments.some(segment => segment.type !== "text") ? { type: "image", segments }
      : { type: "text", text: segments.map(segment => "text" in segment ? segment.text : "").join("") });
    segments = []; chars = 0;
  };
  let prose = "";
  const appendProse = () => {
    for (const chunk of splitCompletionMessage(prose)) {
      if (chars + chunk.length > 3000) flush();
      segments.push({ type: "text", text: chunk }); chars += chunk.length;
    }
    prose = "";
  };
  const visit = (token: RawToken) => {
    if (renderTables && token.type === "table") {
      appendProse(); segments.push({ type: "markdown", text: token.raw }); return;
    }
    if (renderDiagrams && token.type === "code" && mermaidDiagramSource(token.raw) !== undefined) {
      appendProse(); segments.push({ type: "markdown", text: token.raw }); return;
    }
    if (token.type === "image" && token.href) {
      const image = imageSegment(token.href, cwd);
      if (image) { appendProse(); segments.push(image); return; }
    }
    const children = token.tokens ?? token.items;
    if (!children?.length) { prose += token.raw; return; }
    let offset = 0;
    for (const child of children) {
      const at = token.raw.indexOf(child.raw, offset);
      if (at < 0) continue;
      prose += token.raw.slice(offset, at); visit(child); offset = at + child.raw.length;
    }
    prose += token.raw.slice(offset);
  };
  for (const token of new Marked().lexer(text)) visit(token as unknown as RawToken);
  appendProse();
  for (const source of images) {
    const image = imageSegment(source, cwd);
    if (image && !segments.some(segment => JSON.stringify(segment) === JSON.stringify(image))) segments.push(image);
  }
  flush(); return batches;
}

export async function deliverCompletionToEndpoint(rule: AgentCompletionDeliveryRule, hook: CodexHookContextRequest,
  deliveryId: string, routeId: string, options: AgentReplyOptions, context: CompletionTaskContext = { plans: [] }): Promise<void> {
  const taskName = context.taskName?.trim() || "未命名任务";
  const agent = isAgentAdapterType(hook.agentType) ? agentAdapterManifest(hook.agentType).label : "Codex";
  const heading = [`${agent} 本轮结果`, `任务：${taskName}`].join("\n");
  const { channel, params } = rule.destination;
  if (channel !== "napcat" && channel !== "speech") throw new Error("不支持的消息端。");
  const request: AgentSendRequest = {
    deliveryId, sender: { agentType: "codex_hook", sessionId: hook.sessionId }, routeId,
    channel, params: channel === "napcat"
      ? { target: params.target, ...(params.target === "group" ? { groupId: params.targetId } : { userId: params.targetId }), instanceId: params.instanceId, replyToMessageId: "" }
      : { sessionId: params.sessionId || "" },
    payload: { type: "text", text: `${heading}\n\n${hook.lastAssistantMessage!.trim()}` },
    styleValidation: 0
  };
  const text = `${heading}\n\n${hook.lastAssistantMessage!.trim()}`;
  let images = context.images ?? [];
  if (channel === "napcat" && images.length) {
    const linked = completionMessagePayloads(text, false, hook.cwd).flatMap(payload => Array.isArray(payload.segments) ? payload.segments : [])
      .filter((segment): segment is { type: "image"; path: string } => segment.type === "image" && typeof segment.path === "string");
    const embedded = new Set<string>();
    for (const segment of linked) {
      try { embedded.add(`base64://${(await fs.promises.readFile(segment.path)).toString("base64")}`); }
      catch { /* The regular send boundary reports missing or unreadable linked images. */ }
    }
    images = images.filter(image => !embedded.has(image));
  }
  const payloads = channel === "napcat" ? completionMessagePayloads(text, params.renderDiagrams !== "false", hook.cwd, images, params.renderTables !== "false") : [{ type: "text", text }];
  for (const [index, payload] of payloads.entries()) {
    const part: AgentSendRequest = { ...request,
      deliveryId: index === 0 ? deliveryId : `${deliveryId}-part-${index + 1}`,
      payload
    };
    const inspection = await inspectAgentSendDelivery(part, options);
    if (inspection.state === "uncertain") throw new Error(inspection.reason);
    const result = inspection.state === "completed" ? inspection.result : await handleAgentSend(part, options);
    if (result.status !== "sent" || (channel === "napcat" && !result.sentMessageId)) throw new Error(result.reason || "完成消息未取得发送回执。");
  }
  if (channel === "napcat" && params.includeFiles !== "false") {
    const failures: string[] = [];
    for (const file of completionLocalFiles(hook.lastAssistantMessage!)) {
      const part: AgentSendRequest = { ...request,
        deliveryId: `${deliveryId}-file-${createHash("sha256").update(process.platform === "win32" ? file.toLowerCase() : file).digest("hex")}`,
        payload: { type: "file", path: file, fileName: path.basename(file) }
      };
      try {
        const inspection = await inspectAgentSendDelivery(part, options);
        if (inspection.state === "uncertain") { failures.push(inspection.reason); continue; }
        const result = inspection.state === "completed" ? inspection.result : await handleAgentSend(part, options);
        if (result.status !== "sent" || !(result.sentFileId || result.sentMessageId)) {
          failures.push(`${path.basename(file)}: ${result.reason || "文件未取得发送回执。"}`);
        }
      } catch (error) { failures.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failures.length) throw new Error(`正文已发送，部分附件未确认：${failures.join("；")}`);
  }
  if (context.imageReadError) throw new Error("正文已发送，但部分原生图片读取失败。");
}

function canonicalPath(value: string): string {
  const result = path.resolve(value);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

/** Git's common directory identifies all worktrees of one project without prefix matching unrelated projects. */
export async function completionProjectIdentity(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("项目目录必须是绝对路径。");
  const real = await fs.promises.realpath(directory);
  try {
    const { stdout } = await execute("git", ["-C", real, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { windowsHide: true, timeout: getTimeoutMs("backend.manager.agentCompletionDelivery.completionProjectIdentity.execute.timeout", 5000), maxBuffer: 64 * 1024 });
    const [commonDirectory, topLevel] = stdout.trim().split(/\r?\n/);
    const relativeProject = path.relative(canonicalPath(await fs.promises.realpath(topLevel)), canonicalPath(real));
    return `git:${canonicalPath(await fs.promises.realpath(commonDirectory))}:${relativeProject}`;
  } catch {
    return `folder:${canonicalPath(real)}`;
  }
}

export class AgentCompletionDeliveryService {
  private readonly pending = new Map<string, Promise<CompletionDeliveryResult[]>>();
  constructor(private readonly options: {
    rules(request: CodexHookContextRequest, roleIds?: readonly string[]): CompletionRuleOwner[];
    projectIdentity?: typeof completionProjectIdentity;
    taskContext?(owner: CompletionRuleOwner, request: CodexHookContextRequest): CompletionTaskContext | Promise<CompletionTaskContext>;
    deliver(owner: CompletionRuleOwner, request: CodexHookContextRequest, deliveryId: string, context: CompletionTaskContext): Promise<void>;
  }) {}

  handle(request: CodexHookContextRequest, roleIds?: readonly string[]): Promise<CompletionDeliveryResult[]> {
    if (!AGENT_HOOK_EVENTS.some(event => event.hookEvent === request.eventName) || !supportsHooks(request.agentType)
      || !request.sessionId?.trim() || !request.turnId?.trim()
      || !request.lastAssistantMessage?.trim()) return Promise.resolve([]);
    const notification = completionNotification(request.lastAssistantMessage);
    if (!notification.text.trim()) return Promise.resolve([]);
    request = { ...request, lastAssistantMessage: notification.text };
    const key = JSON.stringify([request.sessionId, request.turnId]);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const operation = this.deliverMatches(request, roleIds, notification.heartbeat).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async deliverMatches(request: CodexHookContextRequest, roleIds?: readonly string[], heartbeat = false): Promise<CompletionDeliveryResult[]> {
    const owners = this.options.rules(request, roleIds).filter(({ rule }) => rule.enabled);
    if (!owners.length) return [];
    const identify = this.options.projectIdentity ?? completionProjectIdentity;
    const results: CompletionDeliveryResult[] = [];
    let project: string | undefined;
    const targets = new Set<string>();
    for (const owner of owners) {
      const { rule } = owner;
      try {
        const errors = agentHookRuleErrors(rule);
        if (errors.length) throw new Error(errors.join(" "));
        if (AGENT_HOOK_EVENTS.find(event => event.value === rule.event)?.hookEvent !== request.eventName) continue;
        if (heartbeat && rule.conditions.some(condition => condition.type === "exclude_heartbeat")) continue;
        if (rule.conditions.some(condition =>
          (condition.type === "include_sessions" && !condition.sessions?.some(session => session.id === request.sessionId))
          || (condition.type === "exclude_sessions" && condition.sessions?.some(session => session.id === request.sessionId)))) continue;
        const projectCondition = rule.conditions.find(condition => condition.type === "project");
        if (projectCondition) {
          if (!request.cwd?.trim()) continue;
          project ??= await identify(request.cwd);
          if (await identify(projectCondition.path!) !== project) continue;
        }
        const context = await this.options.taskContext?.(owner, request) ?? { plans: [] };
        if (rule.conditions.some(condition => condition.type === "bound_plan") && context.plans.length === 0) continue;
        const { channel, gatewayId, params } = rule.destination;
        // Preserve group delivery identities when migrating existing rules.
        const target = JSON.stringify(channel === "napcat" && params.target === "group"
          ? [gatewayId, params.instanceId, params.targetId]
          : [gatewayId, channel, params.target || "", params.instanceId || "", params.targetId || params.sessionId || ""]);
        if (targets.has(target)) continue;
        targets.add(target);
        const deliveryId = `agent-completion-${createHash("sha256").update(JSON.stringify([
          request.sessionId, request.turnId, target
        ])).digest("hex")}`;
        await this.options.deliver(owner, request, deliveryId, context);
        results.push({ ruleId: rule.id, status: "sent" });
      } catch (error) {
        results.push({ ruleId: rule.id, status: "failed", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }
}
