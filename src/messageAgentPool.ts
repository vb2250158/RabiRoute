import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import type { CodexReasoningEffort } from "./shared/gatewayConfigModel.js";
import type { PendingMessageGroup } from "./messageGrouping.js";

export const MESSAGE_AGENT_POOL_SCHEMA_VERSION = 1;

export type MessageAgentAffinity = {
  groupId: string;
  endpoint: string;
  conversationKey: string;
  sender: string;
  preview?: string;
  messageIds?: string[];
  lastUsedAt: string;
};

export type MessageAgentWorker = {
  threadId: string;
  threadName: string;
  workspace: string;
  index: number;
  createdAt: string;
  initializedAt?: string;
  affinities: MessageAgentAffinity[];
};

export type MessageAgentPoolState = {
  schemaVersion: 1;
  updatedAt: string;
  workers: MessageAgentWorker[];
};

export type MessageAgentPoolOptions = {
  statePath: string;
  managerBaseUrl: string;
  sourceThreadName: string;
  sourceThreadId: string;
  workspace: string;
  roleId: string;
  roleDisplayName?: string;
  rolePath?: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
};

export type MessageAgentPoolDependencies = {
  request?: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  now?: () => Date;
};

const managerResponseLimitBytes = 1024 * 1024;

export function requestMessageAgentManager(
  managerBaseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<Record<string, any>> {
  const target = new URL("/api/agent/threads", `${managerBaseUrl.replace(/\/+$/, "")}/`);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return Promise.reject(new Error(`Unsupported Manager protocol: ${target.protocol}`));
  }
  const requestBody = JSON.stringify(payload);
  const transport = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let responseEnded = false;
    let socketClosed = false;
    let responseStatus = 0;
    let responseBody: Record<string, any> = {};

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const finish = (): void => {
      if (settled || !responseEnded || !socketClosed) return;
      settled = true;
      if (responseStatus < 200 || responseStatus >= 300 || responseBody.code === -1) {
        reject(new Error(String(responseBody.message || `Manager returned HTTP ${responseStatus}.`)));
        return;
      }
      resolve(responseBody);
    };

    const request = transport.request(target, {
      method: "POST",
      agent: false,
      headers: {
        "connection": "close",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(requestBody)
      }
    }, (response) => {
      responseStatus = response.statusCode ?? 0;
      const chunks: Buffer[] = [];
      let responseBytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        responseBytes += buffer.length;
        if (responseBytes > managerResponseLimitBytes) {
          request.destroy(new Error(`Manager response exceeded ${managerResponseLimitBytes} bytes.`));
          return;
        }
        chunks.push(buffer);
      });
      response.once("aborted", () => fail(new Error("Manager response was aborted.")));
      response.once("error", fail);
      response.once("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          responseBody = text ? JSON.parse(text) as Record<string, any> : {};
        } catch {
          responseBody = {};
        }
        responseEnded = true;
        finish();
      });
    });
    request.once("error", fail);
    request.once("socket", (socket) => {
      socket.once("close", () => {
        socketClosed = true;
        finish();
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Manager request timed out after ${timeoutMs} ms.`));
    });
    request.end(requestBody);
  });
}

function workerTitle(baseTitle: string, index: number, count = index): string {
  const suffix = count === 1 ? " 协助处理消息" : ` 协助处理消息${index}`;
  const fallback = "RabiRoute";
  const base = String(baseTitle || fallback).trim() || fallback;
  return normalizeCodexThreadTitle(`${base.slice(0, Math.max(1, codexThreadTitleMaxLength - suffix.length))}${suffix}`);
}

function roleDisplayNameFromFile(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    const content = fs.readFileSync(filePath, "utf8").slice(0, 8192);
    for (const line of content.split(/\r?\n/)) {
      const text = line.trim().replace(/^\uFEFF/, "");
      if (text.startsWith("# ")) return text.slice(2).trim();
      if (text) return "";
    }
  } catch {
    // The configured task name remains the fallback when persona metadata is unavailable.
  }
  return "";
}

function workerBaseTitle(options: MessageAgentPoolOptions): string {
  return String(options.roleDisplayName || roleDisplayNameFromFile(options.rolePath) || options.sourceThreadName).trim();
}

function normalizeWorker(value: unknown): MessageAgentWorker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const worker = value as Partial<MessageAgentWorker>;
  if (!worker.threadId || !worker.threadName || !worker.workspace) return undefined;
  return {
    threadId: String(worker.threadId),
    threadName: normalizeCodexThreadTitle(String(worker.threadName)),
    workspace: String(worker.workspace),
    index: Math.max(1, Math.floor(Number(worker.index) || 1)),
    createdAt: typeof worker.createdAt === "string" ? worker.createdAt : new Date(0).toISOString(),
    initializedAt: typeof worker.initializedAt === "string" && worker.initializedAt ? worker.initializedAt : undefined,
    affinities: Array.isArray(worker.affinities)
      ? worker.affinities.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const affinity = item as Partial<MessageAgentAffinity>;
          return affinity.groupId && affinity.endpoint && affinity.conversationKey
            ? [{
                groupId: String(affinity.groupId),
                endpoint: String(affinity.endpoint),
                conversationKey: String(affinity.conversationKey),
                sender: String(affinity.sender || "unknown"),
                preview: typeof affinity.preview === "string" ? affinity.preview.slice(0, 2_000) : undefined,
                messageIds: Array.isArray(affinity.messageIds)
                  ? affinity.messageIds.map(String).filter(Boolean).slice(-50)
                  : undefined,
                lastUsedAt: String(affinity.lastUsedAt || new Date(0).toISOString())
              }]
            : [];
        }).slice(-100)
      : []
  };
}

function mergeWorkersByThreadId(workers: MessageAgentWorker[]): MessageAgentWorker[] {
  const merged = new Map<string, MessageAgentWorker>();
  for (const worker of workers) {
    const current = merged.get(worker.threadId);
    if (!current) {
      merged.set(worker.threadId, structuredClone(worker));
      continue;
    }
    current.index = Math.min(current.index, worker.index);
    if ((Date.parse(worker.createdAt) || 0) < (Date.parse(current.createdAt) || 0)) {
      current.createdAt = worker.createdAt;
    }
    current.initializedAt ||= worker.initializedAt;
    const affinities = new Map<string, MessageAgentAffinity>();
    for (const affinity of [...current.affinities, ...worker.affinities]) {
      const existing = affinities.get(affinity.groupId);
      if (!existing || (Date.parse(affinity.lastUsedAt) || 0) >= (Date.parse(existing.lastUsedAt) || 0)) {
        affinities.set(affinity.groupId, affinity);
      }
    }
    current.affinities = [...affinities.values()]
      .sort((left, right) => (Date.parse(left.lastUsedAt) || 0) - (Date.parse(right.lastUsedAt) || 0))
      .slice(-100);
  }
  return [...merged.values()].sort((left, right) => left.index - right.index);
}

function readPoolState(statePath: string): MessageAgentPoolState {
  if (!fs.existsSync(statePath)) {
    return { schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), workers: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MessageAgentPoolState>;
    return {
      schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      workers: Array.isArray(parsed.workers)
        ? mergeWorkersByThreadId(parsed.workers.flatMap((worker) => normalizeWorker(worker) ?? []))
        : []
    };
  } catch {
    return { schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), workers: [] };
  }
}

function affinityScore(worker: MessageAgentWorker, group: PendingMessageGroup): number {
  return worker.affinities.reduce((best, affinity) => {
    if (group.replyToMessageId && affinity.messageIds?.includes(group.replyToMessageId)) return Math.max(best, 5_000);
    if (affinity.groupId === group.groupId) return Math.max(best, 4_000);
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey && affinity.sender === group.sender) {
      return Math.max(best, 3_000);
    }
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey) return Math.max(best, 2_000);
    if (affinity.endpoint === group.endpoint) return Math.max(best, 1_000);
    return best;
  }, 0);
}

function latestAffinityTime(worker: MessageAgentWorker): number {
  return worker.affinities.reduce((latest, affinity) => Math.max(latest, Date.parse(affinity.lastUsedAt) || 0), 0);
}

function affinityForGroup(worker: MessageAgentWorker, group: PendingMessageGroup): MessageAgentAffinity | undefined {
  return [...worker.affinities]
    .reverse()
    .sort((left, right) => {
      const leftScore = affinityScore({ ...worker, affinities: [left] }, group);
      const rightScore = affinityScore({ ...worker, affinities: [right] }, group);
      return rightScore - leftScore || (Date.parse(right.lastUsedAt) || 0) - (Date.parse(left.lastUsedAt) || 0);
    })[0];
}

function groupPreview(group: PendingMessageGroup): string {
  return group.items
    .map((item) => String(item.payload.record.rawMessage ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 2_000);
}

function groupMessageIds(group: PendingMessageGroup): string[] {
  return group.items
    .map((item) => String(item.payload.record.messageId ?? "").trim())
    .filter(Boolean)
    .slice(-50);
}

type ActiveContinuationCandidate = {
  worker: MessageAgentWorker;
  affinity?: MessageAgentAffinity;
};

function continuationCheckPrompt(
  candidate: ActiveContinuationCandidate,
  currentWorker: MessageAgentWorker,
  managerBaseUrl: string
): string {
  const affinity = candidate.affinity;
  return [
    "[接续判断]",
    "另一个消息处理 Agent 正在处理同一消息端或同一会话中的消息。先比较当前消息组与下方正在处理的内容。",
    `正在处理的任务：${candidate.worker.threadName}`,
    `正在处理的任务 ID：${candidate.worker.threadId}`,
    affinity?.groupId ? `正在处理的消息组：${affinity.groupId}` : undefined,
    affinity ? `消息端 / 会话 / 说话人：${affinity.endpoint} / ${affinity.conversationKey} / ${affinity.sender}` : undefined,
    affinity?.messageIds?.length ? `原始消息编号：${affinity.messageIds.join(", ")}` : undefined,
    affinity?.preview ? `正在处理的内容：\n${affinity.preview}` : undefined,
    `如果当前消息明显是上述内容的接续，不要重复处理。调用 POST ${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads，把 action=send、threadId=正在处理的任务 ID、cwd=当前工作目录、sourceThreadId=${currentWorker.threadId}、sourceAgentType=message_processing，并重新编写一段“消息处理接续”交接：只包含当前消息组 ID、消息端/会话/说话人、引用消息 ID和本组新增原始消息。不得复制 [rabi:bind]、消息处理 Agent 初始化、当前消息处理归属、计划/记忆索引、角色路径、回传说明或整份当前输入。然后结束本轮并等待。`,
    "如果不是同一话题，或者无法可靠确认是接续，则继续独立处理；不得为了少开一个 Agent 而强行合并。"
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function workerHandoffPrompt(
  worker: MessageAgentWorker,
  group: PendingMessageGroup,
  managerBaseUrl: string,
  options: MessageAgentPoolOptions
): string {
  const threadsApi = `${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads`;
  const heartbeatInstructions = group.endpoint === "heartbeat"
    ? [
        "",
        "[Heartbeat 专用职责]",
        "heartbeat 巡检由当前消息处理 Agent 自己执行，不先交给主人格，也不把定时巡检本身判断为“重要、跨计划事项”。",
        "按巡检游标增量读取群消息并与计划摘要、问题映射和发送回执对比；只在证据不足时按 messageId、planId 或 taskBinding 查询更早记录，不默认读取全部历史。",
        "你只负责只读比对、遗漏识别、进展汇总和分诊：已有计划的新证据交原计划 Agent；漏建、漏关联、漏绑或需要维护计划的事项交计划秘书；不得自己修改计划或实施业务。",
        "不得把 heartbeat 任务本身投给主人格。先完成比对，并等待秘书或计划 Agent 把处理结果送回当前消息处理任务。",
        "把自上次群汇报后出现的真实工作进展整理成可直接发送的简短正文；没有状态变化时不得重复汇报。",
        "只有形成需要秋雨决定的具体问题、跨计划冲突或已经准备好的群进展/提醒正文，才把精简结果投给主人格；投递内容必须写明引用消息、planId、变化证据和拟发送正文，不能再次转发整项巡检。",
        "没有遗漏、没有真实新进展且只完成内部控制面更新时保持安静，最终写“处理结果：仅更新控制面，无需外部通知”。"
      ]
    : [];
  return [
    "[当前消息处理归属]",
    `消息处理任务：${worker.threadName}`,
    `消息处理任务 ID：${worker.threadId}`,
    `消息组 ID：${group.groupId}`,
    `工作目录：${worker.workspace}`,
    `当前主人格任务：${options.sourceThreadName}`,
    `当前主人格任务 ID：${options.sourceThreadId}`,
    `本任务向其它 Agent 投递时必须填写 sourceThreadId=${worker.threadId}、sourceAgentType=message_processing。`,
    "把事项交给秘书、原计划 Agent 或主人格时，委托消息必须同时写明上述消息组 ID、消息处理任务 ID 和工作目录。",
    `要求对方完成后调用 POST ${threadsApi}，以 action=send、threadId=${worker.threadId}、cwd=${worker.workspace}、sourceThreadId=对方自己的完整任务 ID、sourceAgentType=plan_secretary 或 plan_agent 或 primary_persona，把计划 ID、进展或判断结果送回本消息处理任务。`,
    "对方的结果回到这里后，由你结合原消息、最新上下文和发送权限决定是否回复；不要让秘书、计划 Agent 或主人格绕过本消息组直接猜测发送对象。",
    ...heartbeatInstructions,
    "",
    "[本轮可见性与结束条件]",
    "当前消息处理任务的 Codex 最终输出只供内部查看；原群成员、私聊对象和主人格都不会自动看到。",
    "不得把“请用户确认”或待审批问题只写在当前任务的最终输出里，也不得把准备发送的群聊/私聊文案当成已经送达。",
    "如果当前人格允许直接使用注入的回复接口，必须实际调用并取得 Outbox 回执；如果人格规则要求主人格复核或使用专用发送 Skill，则必须把消息组 ID、原消息目标、引用消息 ID、计划 ID、拟发送正文和所需决定实际投递给主人格。Heartbeat 必须先满足上面的专用例外条件，不能因为巡检本身无法直接发群就提前唤醒主人格。",
    `投递给主人格时调用 POST ${threadsApi}，填写 action=send、threadId=${options.sourceThreadId}、cwd=${options.workspace}、sourceThreadId=${worker.threadId}、sourceAgentType=message_processing；prompt 必须是重新编写的“主人格交接”，只保留消息组 ID、原消息目标、引用消息 ID、计划 ID、变化证据、需要决定的问题或拟发送正文，并明确写出“这不是让你只在 Codex 输出，请按原消息端发送规则执行或向当前主人格用户提问，并把发送回执或用户决定送回消息处理任务”。禁止复制消息处理 Agent 初始化、当前消息处理归属或整份注入上下文。投递给主人格并取得 Manager 接受回执后，才可以结束本轮。`,
    "如果不需要任何人看到或回答，最终输出必须明确写“处理结果：无需对外回复”，再附一行内部原因。",
    "秘书、计划 Agent 或主人格返回的新结果也必须重新经过本段判断；不能把它改写成一段面向用户的话后只留在当前 Codex 最终输出。"
  ].join("\n");
}

export function messageAgentInitializationPrompt(options: MessageAgentPoolOptions): string {
  return [
    `[rabi:bind ${options.roleId}]`,
    "[消息处理 Agent 初始化]",
    `主人格任务：${options.sourceThreadName}`,
    `主人格任务 ID：${options.sourceThreadId}`,
    `工作目录：${options.workspace}`,
    "",
    "你是专职消息处理 Agent，不是主人格、计划秘书或计划执行 Agent。你处理 RabiRoute 已合并好的消息组，并保留该消息端、会话、说话人和回复链的有限相关上下文。",
    "先判断消息组是否需要回复、是否属于已有计划、是否形成新需求，以及是否重要、跨计划或仍然不确定。普通对话和必要澄清由你处理；已有计划的增量交给原 taskBinding 对应的计划 Agent；新需求或计划维护交给计划秘书；重要、跨计划或无法可靠判断的事项交给主人格任务。",
    "Heartbeat 是例外：定时巡检本身不算需要主人格处理的“重要、跨计划事项”。收到 heartbeat 时由你完成增量群消息与计划的只读比对，并汇总自上次通知后的真实进展；具体遗漏交秘书或原计划 Agent，只有最终出现需要人决定或已经准备好对外发送的内容才找主人格。",
    "不要自己实施计划业务，不要把本消息处理任务写入计划 taskBinding，不要代替计划秘书维护计划，也不要为了速度猜测不确定的计划关联。信息不足时扩大查询或向原消息端澄清。",
    "你负责判断并准备沟通，但只有回复接口的 Outbox 回执或 Manager 线程桥接受回执能证明消息已进入正确出口。Codex 最终文本不等于消息已经发出。",
    "你向其它 Agent 任务投递消息时，必须填写 sourceThreadId=当前消息处理任务的完整 ID、sourceAgentType=message_processing。Manager 会按 ID 核对并显示真实的来源任务名和会话 ID。",
    "同一消息组的后续补充可能在当前轮次工作中到达；把它作为同一上下文的新增材料处理。若收到的消息组明显与当前事项无关，明确返回需要重新分配，不要混入原结论。"
  ].join("\n");
}

export class MessageAgentPool {
  private readonly workers: MessageAgentWorker[];
  private readonly request: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  private readonly now: () => Date;
  private readonly reservedWorkerIds = new Set<string>();
  private readonly initializingWorkerIds = new Set<string>();
  private allocationTail: Promise<void> = Promise.resolve();
  private workerTitlesNormalized = false;
  private sourceThreadName: string;
  private sourceThreadNameResolved = false;

  constructor(private readonly options: MessageAgentPoolOptions, dependencies: MessageAgentPoolDependencies = {}) {
    this.workers = readPoolState(options.statePath).workers.filter((worker) => worker.threadId !== options.sourceThreadId);
    this.now = dependencies.now ?? (() => new Date());
    this.request = dependencies.request ?? ((payload) => this.managerRequest(payload));
    this.sourceThreadName = options.sourceThreadName;
    // Persist the normalized state once so duplicate rows left by an older
    // concurrent allocator are repaired as soon as the Route starts.
    this.persist();
  }

  async deliver(group: PendingMessageGroup, prompt: string): Promise<MessageAgentWorker> {
    const allocation = await this.withAllocationLock(async () => {
      await this.ensureSourceThreadName();
      await this.ensureWorkerTitles();
      const selection = await this.selectWorker(group);
      const worker = selection.worker;
      const currentOptions = { ...this.options, sourceThreadName: this.sourceThreadName };
      const ownership = workerHandoffPrompt(worker, group, this.options.managerBaseUrl, currentOptions);
      const promptWithContinuationCheck = selection.activeCandidate
        ? `${ownership}\n\n${continuationCheckPrompt(selection.activeCandidate, worker, this.options.managerBaseUrl)}\n\n${prompt}`
        : `${ownership}\n\n${prompt}`;
      const shouldInitialize = !worker.initializedAt && !this.initializingWorkerIds.has(worker.threadId);
      if (shouldInitialize) this.initializingWorkerIds.add(worker.threadId);
      this.reservedWorkerIds.add(worker.threadId);
      this.remember(worker, group);
      this.persist();
      return {
        worker,
        shouldInitialize,
        prompt: shouldInitialize
          ? `${messageAgentInitializationPrompt(currentOptions)}\n\n${promptWithContinuationCheck}`
          : promptWithContinuationCheck
      };
    });
    try {
      await this.request({
        action: "send",
        threadId: allocation.worker.threadId,
        cwd: allocation.worker.workspace,
        sandbox: "workspace-write",
        prompt: allocation.prompt,
        model: this.options.model,
        reasoningEffort: this.options.reasoningEffort
      });
      if (allocation.shouldInitialize) allocation.worker.initializedAt = this.now().toISOString();
      this.persist();
      return structuredClone(allocation.worker);
    } finally {
      this.reservedWorkerIds.delete(allocation.worker.threadId);
      if (allocation.shouldInitialize) this.initializingWorkerIds.delete(allocation.worker.threadId);
    }
  }

  snapshot(): MessageAgentPoolState {
    return {
      schemaVersion: MESSAGE_AGENT_POOL_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      workers: this.workers.map((worker) => structuredClone(worker))
    };
  }

  private async selectWorker(group: PendingMessageGroup): Promise<{
    worker: MessageAgentWorker;
    activeCandidate?: ActiveContinuationCandidate;
  }> {
    const ranked = this.workers
      .map((worker) => ({ worker, score: affinityScore(worker, group) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || latestAffinityTime(right.worker) - latestAffinityTime(left.worker));
    // Heartbeat is one continuing control-plane responsibility, not a new
    // conversation every time the timer fires. Always steer the next tick to
    // the most familiar heartbeat worker, even while its current turn is
    // active, so a stale busy signal can never grow one task per schedule.
    if (group.endpoint === "heartbeat" && ranked[0]) {
      return { worker: ranked[0].worker };
    }
    for (const candidate of ranked) {
      if (candidate.score >= 4_000 || !await this.isUnavailable(candidate.worker)) return { worker: candidate.worker };
    }
    const activeCandidate = ranked[0]
      ? { worker: ranked[0].worker, affinity: affinityForGroup(ranked[0].worker, group) }
      : undefined;
    const idleFallbacks = [...this.workers]
      .sort((left, right) => latestAffinityTime(left) - latestAffinityTime(right) || left.index - right.index);
    for (const worker of idleFallbacks) {
      if (!await this.isUnavailable(worker)) return { worker, activeCandidate };
    }
    return { worker: await this.createWorker(), activeCandidate };
  }

  private async ensureSourceThreadName(): Promise<void> {
    if (this.sourceThreadNameResolved) return;
    try {
      const response = await this.request({ action: "read", threadId: this.options.sourceThreadId });
      const title = String(response.thread?.title || "").trim();
      if (title && !title.includes("\n") && title.length <= codexThreadTitleMaxLength) {
        this.sourceThreadName = title;
      }
    } catch {
      // Keep the saved Route display name when Manager cannot resolve the current Desktop title.
    }
    this.sourceThreadNameResolved = true;
  }

  private async withAllocationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.allocationTail;
    let release = (): void => undefined;
    this.allocationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async createWorker(): Promise<MessageAgentWorker> {
    const index = this.workers.reduce((maximum, worker) => Math.max(maximum, worker.index), 0) + 1;
    const baseTitle = workerBaseTitle(this.options);
    if (this.workers.length === 1 && index === 2) {
      const first = this.workers[0];
      const firstTitle = workerTitle(baseTitle, 1, 2);
      await this.request({
        action: "rename",
        threadId: first.threadId,
        title: firstTitle,
        cwd: first.workspace
      });
      first.threadName = firstTitle;
      this.persist();
    }
    const title = workerTitle(baseTitle, index, Math.max(1, this.workers.length + 1));
    const response = await this.request({
      action: "resolve",
      title,
      cwd: this.options.workspace,
      createIfMissing: true,
      lookupMode: "state_db"
    });
    const thread = response.thread as { id?: unknown; title?: unknown; cwd?: unknown } | undefined;
    if (!thread?.id) throw new Error(`Message Agent task resolution did not return a task id for ${title}.`);
    if (String(thread.id) === this.options.sourceThreadId) {
      throw new Error("Message Agent task resolution returned the Primary Persona task id; refusing role crossover.");
    }
    const worker: MessageAgentWorker = {
      threadId: String(thread.id),
      threadName: String(thread.title || title),
      workspace: String(thread.cwd || this.options.workspace),
      index,
      createdAt: this.now().toISOString(),
      affinities: []
    };
    this.workers.push(worker);
    this.persist();
    return worker;
  }

  private async ensureWorkerTitles(): Promise<void> {
    if (this.workerTitlesNormalized) return;
    const count = this.workers.length;
    const baseTitle = workerBaseTitle(this.options);
    let changed = false;
    let allNormalized = true;
    for (const worker of this.workers) {
      const title = workerTitle(baseTitle, worker.index, count);
      if (worker.threadName === title) continue;
      try {
        await this.request({
          action: "rename",
          threadId: worker.threadId,
          title,
          cwd: worker.workspace
        });
        worker.threadName = title;
        changed = true;
      } catch {
        allNormalized = false;
      }
    }
    if (changed) this.persist();
    this.workerTitlesNormalized = allNormalized;
  }

  private async isActive(worker: MessageAgentWorker): Promise<boolean> {
    try {
      const response = await this.request({ action: "read", threadId: worker.threadId });
      return response.thread?.active === true;
    } catch {
      return true;
    }
  }

  private async isUnavailable(worker: MessageAgentWorker): Promise<boolean> {
    return this.reservedWorkerIds.has(worker.threadId) || await this.isActive(worker);
  }

  private remember(worker: MessageAgentWorker, group: PendingMessageGroup): void {
    const now = this.now().toISOString();
    worker.affinities = worker.affinities.filter((affinity) => affinity.groupId !== group.groupId);
    worker.affinities.push({
      groupId: group.groupId,
      endpoint: group.endpoint,
      conversationKey: group.conversationKey,
      sender: group.sender,
      preview: groupPreview(group),
      messageIds: groupMessageIds(group),
      lastUsedAt: now
    });
    worker.affinities = worker.affinities.slice(-100);
  }

  private persist(): void {
    atomicWriteFileSync(this.options.statePath, `${JSON.stringify(this.snapshot(), null, 2)}\n`);
  }

  private async managerRequest(payload: Record<string, unknown>): Promise<Record<string, any>> {
    return requestMessageAgentManager(this.options.managerBaseUrl, payload);
  }
}

export function messageAgentPoolStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "agents.json");
}
