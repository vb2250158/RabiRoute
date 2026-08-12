import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { atomicWriteFileSync } from "./shared/filePersistence.js";
import {
  communicationModeForRouteKind,
  proactiveCommunicationPolicyLines,
  type AgentCommunicationMode
} from "./shared/agentCommunicationPolicy.js";
import { codexThreadTitleMaxLength, normalizeCodexThreadTitle } from "./shared/codexThreadTitle.js";
import type { CodexReasoningEffort } from "./shared/gatewayConfigModel.js";
import type { PendingMessageGroup } from "./messageGrouping.js";
import type { MessageAgentReferencedSender } from "./messageProcessing/referencedAgentSender.js";

export const MESSAGE_AGENT_POOL_SCHEMA_VERSION = 2;
export const MESSAGE_AGENT_AFFINITY_SCHEMA_VERSION = 1;

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

export type PersistedMessageAgentWorker = Omit<MessageAgentWorker, "affinities">;

export type MessageAgentPoolState = {
  schemaVersion: 2;
  updatedAt: string;
  workers: PersistedMessageAgentWorker[];
};

export type MessageAgentAffinityState = {
  schemaVersion: 1;
  updatedAt: string;
  workers: Array<{
    threadId: string;
    affinities: MessageAgentAffinity[];
  }>;
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
  maxAgents?: number;
};

export type MessageAgentPoolDependencies = {
  request?: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  now?: () => Date;
};

export type MessageAgentDeliveryRouting = {
  requirementId?: string;
  referencedSenders?: MessageAgentReferencedSender[];
  imagePaths?: string[];
};

const managerResponseLimitBytes = 1024 * 1024;
const REFERENCED_AGENT_SESSION_WEIGHT = 6_000;

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

function workerTitle(baseTitle: string, index: number, count = index, numberSingleWorker = false): string {
  const suffix = count === 1 && !numberSingleWorker ? " 协助处理消息" : ` 协助处理消息${index}`;
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

function readPoolState(statePath: string): { updatedAt: string; workers: MessageAgentWorker[] } {
  if (!fs.existsSync(statePath)) {
    return { updatedAt: new Date(0).toISOString(), workers: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
      updatedAt?: unknown;
      workers?: unknown;
    };
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      workers: Array.isArray(parsed.workers)
        ? mergeWorkersByThreadId(parsed.workers.flatMap((worker) => normalizeWorker(worker) ?? []))
        : []
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), workers: [] };
  }
}

function affinityStatePathForPoolState(statePath: string): string {
  return path.join(path.dirname(path.resolve(statePath)), "routing-affinity.json");
}

function readAffinityState(statePath: string): Map<string, MessageAgentAffinity[]> {
  const result = new Map<string, MessageAgentAffinity[]>();
  if (!fs.existsSync(statePath)) return result;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<MessageAgentAffinityState>;
    if (!Array.isArray(parsed.workers)) return result;
    for (const value of parsed.workers) {
      if (!value || typeof value !== "object") continue;
      const row = value as { threadId?: unknown; affinities?: unknown };
      const threadId = String(row.threadId || "").trim();
      if (!threadId) continue;
      const normalized = normalizeWorker({
        threadId,
        threadName: threadId,
        workspace: ".",
        index: 1,
        createdAt: new Date(0).toISOString(),
        affinities: row.affinities
      });
      result.set(threadId, normalized?.affinities ?? []);
    }
  } catch {
    // Missing or interrupted affinity history only reduces routing preference;
    // it must never invent task availability or prevent exact task recovery.
  }
  return result;
}

function mergeWorkerAffinities(worker: MessageAgentWorker, affinities: MessageAgentAffinity[]): void {
  const merged = new Map<string, MessageAgentAffinity>();
  for (const affinity of [...worker.affinities, ...affinities]) {
    const current = merged.get(affinity.groupId);
    if (!current || (Date.parse(affinity.lastUsedAt) || 0) >= (Date.parse(current.lastUsedAt) || 0)) {
      merged.set(affinity.groupId, affinity);
    }
  }
  worker.affinities = [...merged.values()]
    .sort((left, right) => (Date.parse(left.lastUsedAt) || 0) - (Date.parse(right.lastUsedAt) || 0))
    .slice(-100);
}

function affinityScore(
  worker: MessageAgentWorker,
  group: PendingMessageGroup,
  routing: MessageAgentDeliveryRouting = {}
): number {
  const affinityWeight = worker.affinities.reduce((best, affinity) => {
    if (group.replyToMessageId && affinity.messageIds?.includes(group.replyToMessageId)) return Math.max(best, 5_000);
    if (affinity.groupId === group.groupId) return Math.max(best, 4_000);
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey && affinity.sender === group.sender) {
      return Math.max(best, 3_000);
    }
    if (affinity.endpoint === group.endpoint && affinity.conversationKey === group.conversationKey) return Math.max(best, 2_000);
    if (affinity.endpoint === group.endpoint) return Math.max(best, 1_000);
    return best;
  }, 0);
  const referencedAgentWeight = routing.referencedSenders?.some((sender) => sender.sessionId === worker.threadId)
    ? REFERENCED_AGENT_SESSION_WEIGHT
    : 0;
  return affinityWeight + referencedAgentWeight;
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

function communicationModeForMessageGroup(group: PendingMessageGroup): AgentCommunicationMode {
  const modes = group.items.map((item) => communicationModeForRouteKind(item.payload.routeKind));
  if (modes.includes("explicit")) return "explicit";
  if (modes.includes("ambient")) return "ambient";
  if (modes.includes("heartbeat")) return "heartbeat";
  return "internal";
}

type ActiveContinuationCandidate = {
  worker: MessageAgentWorker;
  affinity?: MessageAgentAffinity;
};

type MessageAgentWorkerAvailability = "active" | "idle" | "notLoaded" | "unavailable" | "missing";

function continuationCheckPrompt(
  candidate: ActiveContinuationCandidate,
  currentWorker: MessageAgentWorker,
  managerBaseUrl: string,
  requirementId?: string
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
    `如果当前消息明显是上述内容的接续，不要重复处理。调用 POST ${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads，把 action=send、threadId=正在处理的任务 ID、cwd=当前工作目录、sourceThreadId=${currentWorker.threadId}、sourceAgentType=message_processing、responsePolicy=required、responseInstruction=完成接续处理后把处理结果和下一步返回当前消息处理任务${requirementId ? `、messageProcessing={"requirementId":"${requirementId}","outcome":"handoff","targetAgentType":"message_processing"}` : ""}，并重新编写一段“消息处理接续”交接：只包含当前消息组 ID、消息端/会话/说话人、引用消息 ID和本组新增原始消息。不得复制 [rabi:bind]、消息处理 Agent 初始化、当前消息处理归属、计划/记忆索引、角色路径、回传说明或整份当前输入。然后结束本轮并等待。`,
    "只有响应同时满足 code=0、status=delivered、delivery.status=delivered，才表示目标 Codex 任务已经接收。若响应为 code=-1 或 status=failed，按 error.field 和 error.message 补正；若 status=delivered_tracking_failed，目标已经接收，不得重复投递，只报告看板记录失败。",
    "如果不是同一话题，或者无法可靠确认是接续，则继续独立处理；不得为了少开一个 Agent 而强行合并。"
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function workerHandoffPrompt(
  worker: MessageAgentWorker,
  group: PendingMessageGroup,
  managerBaseUrl: string,
  options: MessageAgentPoolOptions,
  requirementId?: string
): string {
  const threadsApi = `${managerBaseUrl.replace(/\/+$/, "")}/api/agent/threads`;
  const communicationMode = communicationModeForMessageGroup(group);
  const criticalFactInstructions = [
    "",
    "[项目事实判断由 Agent 负责]",
    "RabiManager 不根据关键词猜测消息含义。你必须读取原消息、附件和必要的回复链，判断它是否包含需要长期保留的项目事实。",
    "RabiManager 会把本消息按计划和记忆的标题、ID、关键词召回，并把命中项写入消息处理需求。命中只是候选关联，不代表一定相关；但每个命中的计划或记忆都必须读取并逐项处理，不能看见后直接忽略。",
    "在 outcome 中为每个命中项提交 knowledgeMatchDispositions：knowledgeId、knowledgeType、relevance、判断证据和 actions。相关项至少选择一项实际动作：reply、discuss、update_plan、update_memory、create_plan、create_memory；不相关时只能使用 no_action 并说明为什么是误命中。",
    "update/create 动作必须写 recordType、recordId、包含原消息 ID 的写回证据和 verifiedAt；Manager 会读取目标计划或记忆核验。reply/discuss 必须实际进入回复发送流程并取得 Outbox 回执。需要秘书或原计划任务继续处理时先 handoff，不能伪写成已经更新。",
    "普通群消息也适用这套处理：它可能只是需要简短确认或参与讨论，也可能是既有计划的新证据、范围调整、反馈或新的可复用记忆。不要把“不是关键事实”误解成“无需处理”。",
    "如果 knowledgeMatches 为空，不能直接认为无关。请从消息和回复链提取具体对象、功能名、页面名、人物、版本和动作，至少换两组同义关键词查询计划与记忆；仍无命中时，由你判断应当回复/讨论、创建新计划、形成新记忆，还是确属结束语/重复/他人已完整回答。",
    "对图片、文件或短句，先结合被回复消息和同组上下文理解；不能因为正文缺少关键词而跳过。无法取得附件或回复链时明确 handoff/追问，不得当作无事项。",
    "消息要求“查一下”“核对”“定位”“谁写的”“是否实装”时，把它当作行动请求：先完成调查，再回复查到的事实。未完成调查不得发送猜测、调查步骤、验收模板或长篇说明；若消息直接 @ 且确需即时确认，最多一句“我去查具体位置和实现，查完回”。",
    "消息含图片或附件时，准备外发前必须实际查看附件内容；只看到 [CQ:image]、文件名或下载链接不算已查看。无法查看时不要推断图片内容，先内部取图或转交。",
    "需求 source.evidenceReviewRequired=true 时，关闭或准备回复前还必须提交 sourceEvidenceReview：reviewedMessageIds 要覆盖 source.messageIds 和 replyChainMessageIds；attachmentReviews 要逐个覆盖 source.attachments，并写明实际看到的内容。附件 status=unavailable 时只能重试取图或 handoff，Manager 不允许进入发送状态。",
    "引用 QQ 图片消息回复时，明确发送请求还必须在 params.replyImageDescriptions 中按原图顺序逐张写明图片内容和它想表达的意思。缺少任一张、描述为空或只写‘已查看’都会被发送接口拒绝；发送成功后说明会保存到图片旁的同名 .md。",
    "如果发起人和被询问者已经完成问答或确认，例如“我这边改 ok”后对方回复“ok”，该话题已闭合，本角色没有新增事实时必须保持安静，不得补总结、建议或验收要求。",
    "群内可见回复默认只写一到两句，直接回答对方的问题；内部计划、任务归类、调查过程、代码层级和测试步骤只留在任务内，除非对方明确追问技术细节。",
    "项目事实包括但不限于：上线/公测的内部目标或正式日期、版本范围、批准/否决、负责人变化、取消/延期、发布版本。必须区分候选目标、正式决定和公开公告，不能只看到日期就自行定性。",
    "在关闭或准备回复前，先 POST 消息处理 outcome，并提交 projectFactAssessment：status=none/critical、reviewedMessageIds、replyChainChecked=true、具体 evidence、assessedAt、assessedByThreadId；critical 时还要提交 facts(kind/evidence)。",
    "判断为 critical 时，先交原计划秘书更新计划、绑定记忆或项目文档；没有唯一计划时交计划秘书查重，跨计划或无法判断时交给主人格。完成后再提交 criticalFactDisposition 的记录类型、记录 ID、核对证据和核对时间。",
    "没有完成项目事实判断或召回项处理时只能 handoff，不能用 no_reply、准备回复或普通最终文本关闭需求。RabiManager 只召回、保存、核验证据和跟踪状态，不替你决定消息语义或业务动作。",
    "回答排期、上线日期、版本范围、负责人或审批状态前，必须先查本群最新消息与已登记的项目事实；公开公告和旧会议材料只能作为补充，不能覆盖更新的内部决定。"
  ];
  const heartbeatInstructions = group.endpoint === "heartbeat"
    ? [
        "",
        "[Heartbeat 专用职责]",
        "heartbeat 巡检由当前消息处理 Agent 自己执行，不先交给主人格，也不把定时巡检本身判断为“重要、跨计划事项”。",
        "按巡检游标增量读取群消息并与计划摘要、问题映射和发送回执对比；只在证据不足时按 messageId、planId 或 taskBinding 查询更早记录，不默认读取全部历史。",
        "增量消息中若出现上线/公测日期、版本范围、批准/否决、负责人变更、取消/延期或发布版本，必须逐条核对是否已经写入对应计划、绑定记忆或项目文档；未记录项优先于普通遗漏处理，并交秘书完成记录后回传证据。",
        "同时检查消息处理看板中尚无 projectFactAssessment，或已判断为 critical 但尚无 criticalFactDisposition 的需求；语义复核仍由 heartbeat Agent 完成，Manager 只列出缺失项。",
        "你只负责只读比对、遗漏识别、进展汇总和分诊：已有计划的新证据交原计划 Agent；漏建、漏关联、漏绑或需要维护计划的事项交计划秘书；不得自己修改计划或实施业务。",
        "不得把 heartbeat 任务本身投给主人格。先完成比对，并等待秘书或计划 Agent 把处理结果送回当前消息处理任务。",
        "把自上次群汇报后出现的真实工作进展整理成可直接发送的简短正文；没有状态变化时不得重复汇报。",
        "只有形成需要主人格用户决定的具体问题、跨计划冲突或已经准备好的群进展/提醒正文，才把精简结果投给主人格；投递内容必须写明引用消息、planId、变化证据和拟发送正文，不能再次转发整项巡检。",
        "没有遗漏、没有真实新进展且只完成内部控制面更新时保持安静，最终写“处理结果：仅更新控制面，无需外部通知”。"
      ]
    : [];
  return [
    "[当前消息处理归属]",
    `消息处理任务：${worker.threadName}`,
    `消息处理任务 ID：${worker.threadId}`,
    `消息组 ID：${group.groupId}`,
    requirementId ? `消息处理需求 ID：${requirementId}` : "",
    `工作目录：${worker.workspace}`,
    `当前主人格任务：${options.sourceThreadName}`,
    `当前主人格任务 ID：${options.sourceThreadId}`,
    `本任务向其它 Agent 投递时必须填写 sourceThreadId=${worker.threadId}、sourceAgentType=message_processing，并显式填写 responsePolicy=required 或 none；要求对方返回结果时还必须填写 responseInstruction。`,
    "把事项交给秘书、原计划 Agent 或主人格时，委托消息必须写明上述消息组 ID、消息处理任务 ID 和工作目录；本轮存在消息处理需求 ID 时也必须带上。",
    `要求对方完成后调用 POST ${threadsApi}，以 action=send、threadId=${worker.threadId}、cwd=${worker.workspace}、sourceThreadId=对方自己的完整任务 ID、sourceAgentType=plan_secretary 或 plan_agent 或 primary_persona、inReplyToRequestId=投递中给出的 requestId、result=结果、nextAction=下一步，并重新填写 responsePolicy=required 或 none，把计划 ID、进展或判断结果送回本消息处理任务。只有这次正式接口投递算回复，普通 Codex 最终输出不算。`,
    "Agent 间投递只认本次 HTTP 响应：code=0、status=delivered、delivery.status=delivered 表示目标 Codex 任务已接收；带消息处理需求时还应有 handoff.status=recorded。code=-1 或 status=failed 时按 error.field 和 error.message 修正后再请求；status=delivered_tracking_failed 表示目标已接收但看板记录失败，不得重复投递。",
    "对方的结果回到这里后，由你结合原消息、最新上下文和发送权限决定是否回复；不要让秘书、计划 Agent 或主人格绕过本消息组直接猜测发送对象。",
    ...heartbeatInstructions,
    ...criticalFactInstructions,
    "",
    "[主动协作要求]",
    ...proactiveCommunicationPolicyLines(communicationMode),
    "",
    "[本轮可见性与结束条件]",
    "当前消息处理任务的 Codex 最终输出只供内部查看；原群成员、私聊对象和主人格都不会自动看到。",
    "不得把“请用户确认”或待审批问题只写在当前任务的最终输出里，也不得把准备发送的群聊/私聊文案当成已经送达。",
    "如果当前人格允许直接使用注入的明确发送接口，必须按注入模板填写 channel、params 和 payload，实际调用并取得对应渠道的发送回执；如果人格规则要求主人格复核或使用专用发送 Skill，则必须把消息组 ID、原消息目标、引用消息 ID、计划 ID、拟发送正文和所需决定实际投递给主人格。Heartbeat 必须先满足上面的专用例外条件，不能因为巡检本身无法直接发群就提前唤醒主人格。",
    `投递给主人格时调用 POST ${threadsApi}，填写 action=send、threadId=${options.sourceThreadId}、cwd=${options.workspace}、sourceThreadId=${worker.threadId}、sourceAgentType=message_processing、responsePolicy=required、responseInstruction=执行外发或取得用户决定后把回执或决定返回消息处理任务${requirementId ? `、messageProcessing={"requirementId":"${requirementId}","outcome":"handoff","targetAgentType":"primary_persona"}` : ""}；prompt 必须是重新编写的“主人格交接”，只保留消息组 ID、原消息目标、引用消息 ID、计划 ID、变化证据、需要决定的问题或拟发送正文，本轮存在消息处理需求 ID 时一并保留，并明确写出“这不是让你只在 Codex 输出，请按原消息端发送规则执行或向当前主人格用户提问，并把发送回执或用户决定送回消息处理任务”。禁止复制消息处理 Agent 初始化、当前消息处理归属或整份注入上下文。投递给主人格并取得 Manager 接受回执后，才可以结束本轮。`,
    "如果不需要任何人看到或回答，最终输出必须明确写“处理结果：无需对外回复”，再写明命中了纯结束语/重复消息/机器人自身消息/他人已完整回答且无新增价值中的哪一种；不得只写“无需计划操作”或“暂无实施动作”。",
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
    ...proactiveCommunicationPolicyLines("internal"),
    "明确 @、直接回复、私聊和其它明确面向本角色的消息默认需要可见回应；是否需要计划操作与是否需要回复必须分开判断。",
    "Heartbeat 是例外：定时巡检本身不算需要主人格处理的“重要、跨计划事项”。收到 heartbeat 时由你完成增量群消息与计划的只读比对，并汇总自上次通知后的真实进展；具体遗漏交秘书或原计划 Agent，只有最终出现需要人决定或已经准备好对外发送的内容才找主人格。",
    "不要自己实施计划业务，不要把本消息处理任务写入计划 taskBinding，不要代替计划秘书维护计划，也不要为了速度猜测不确定的计划关联。信息不足时扩大查询或向原消息端澄清。",
    "你负责判断并准备沟通，但只有明确发送接口返回的目标渠道回执或 Manager 线程桥接受回执能证明消息已进入正确出口。语音合成成功不能证明 QQ 已发送，Codex 最终文本也不等于消息已经发出。",
    "Manager 线程桥的成功回执必须同时包含 code=0、status=delivered 和 delivery.status=delivered；缺参数或投递失败会在同一响应的 error.field、error.message、error.retryable 中说明。不要把 HTTP 请求已发起或 Codex 命令已执行当成投递成功。",
    "你向其它 Agent 任务投递消息时，必须填写 sourceThreadId=当前消息处理任务的完整 ID、sourceAgentType=message_processing 和 responsePolicy=required 或 none。要求对方回复时还必须填写 responseInstruction；回复已有请求时必须填写 inReplyToRequestId、result 和 nextAction。Manager 会按 ID 核对并显示真实的来源任务名和会话 ID。",
    "同一消息组的后续补充可能在当前轮次工作中到达；把它作为同一上下文的新增材料处理。若收到的消息组明显与当前事项无关，明确返回需要重新分配，不要混入原结论。"
  ].join("\n");
}

export class MessageAgentPool {
  private readonly workers: MessageAgentWorker[];
  private readonly affinityStatePath: string;
  private readonly request: (payload: Record<string, unknown>) => Promise<Record<string, any>>;
  private readonly now: () => Date;
  private readonly reservedWorkerIds = new Set<string>();
  private readonly initializingWorkerIds = new Set<string>();
  private allocationTail: Promise<void> = Promise.resolve();
  private workerTitlesNormalized = false;
  private sourceThreadName: string;
  private sourceThreadNameResolved = false;
  private sourceThreadAvailability: MessageAgentWorkerAvailability | undefined;
  private readonly maxAgents: number;

  constructor(private readonly options: MessageAgentPoolOptions, dependencies: MessageAgentPoolDependencies = {}) {
    const restored = readPoolState(options.statePath);
    this.affinityStatePath = affinityStatePathForPoolState(options.statePath);
    const affinityByThreadId = readAffinityState(this.affinityStatePath);
    this.maxAgents = Number.isFinite(options.maxAgents) && Number(options.maxAgents) > 0
      ? Math.max(1, Math.floor(Number(options.maxAgents)))
      : Number.POSITIVE_INFINITY;
    const restoredWorkers = restored.workers
      .filter((worker) => worker.threadId !== options.sourceThreadId)
      .sort((left, right) => left.index - right.index || (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
    for (const worker of restoredWorkers) mergeWorkerAffinities(worker, affinityByThreadId.get(worker.threadId) ?? []);
    this.workers = restoredWorkers.slice(0, this.maxAgents);
    if (this.workers.length === 1 && restoredWorkers.length > 1) {
      for (const detached of restoredWorkers.slice(1)) mergeWorkerAffinities(this.workers[0], detached.affinities);
    }
    this.now = dependencies.now ?? (() => new Date());
    this.request = dependencies.request ?? ((payload) => this.managerRequest(payload));
    this.sourceThreadName = options.sourceThreadName;
    // Persist the normalized state once so duplicate rows left by an older
    // concurrent allocator are repaired as soon as the Route starts.
    this.persist();
  }

  async deliver(
    group: PendingMessageGroup,
    prompt: string,
    routing: MessageAgentDeliveryRouting = {}
  ): Promise<MessageAgentWorker> {
    const allocation = await this.withAllocationLock(async () => {
      await this.ensureSourceThreadName();
      await this.ensureWorkerTitles();
      const selection = await this.selectWorker(group, routing);
      const worker = selection.worker;
      const currentOptions = { ...this.options, sourceThreadName: this.sourceThreadName };
      const ownership = workerHandoffPrompt(worker, group, this.options.managerBaseUrl, currentOptions, routing.requirementId);
      const promptWithContinuationCheck = selection.activeCandidate
        ? `${ownership}\n\n${continuationCheckPrompt(selection.activeCandidate, worker, this.options.managerBaseUrl, routing.requirementId)}\n\n${prompt}`
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
        reasoningEffort: this.options.reasoningEffort,
        imagePaths: routing.imagePaths
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
      workers: this.workers.map(({ affinities: _affinities, ...worker }) => structuredClone(worker))
    };
  }

  affinitySnapshot(): MessageAgentAffinityState {
    return {
      schemaVersion: MESSAGE_AGENT_AFFINITY_SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      workers: this.workers.map((worker) => ({
        threadId: worker.threadId,
        affinities: structuredClone(worker.affinities)
      }))
    };
  }

  private async selectWorker(group: PendingMessageGroup, routing: MessageAgentDeliveryRouting): Promise<{
    worker: MessageAgentWorker;
    activeCandidate?: ActiveContinuationCandidate;
  }> {
    const ranked = this.workers
      .map((worker) => ({ worker, score: affinityScore(worker, group, routing) }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || latestAffinityTime(right.worker) - latestAffinityTime(left.worker));
    // Heartbeat is one continuing control-plane responsibility, not a new
    // conversation every time the timer fires. Always steer the next tick to
    // the most familiar heartbeat worker, even while its current turn is
    // active, so a stale busy signal can never grow one task per schedule.
    if (group.endpoint === "heartbeat" && ranked[0]) {
      return { worker: ranked[0].worker };
    }
    const availability = await this.readWorkerAvailability(this.workers);
    for (const candidate of ranked) {
      if (candidate.score >= 4_000) return { worker: candidate.worker };
      if (availability.get(candidate.worker.threadId) === "idle") return { worker: candidate.worker };
    }
    const activeCandidateRow = ranked.find((candidate) => availability.get(candidate.worker.threadId) === "active");
    const activeCandidate = activeCandidateRow
      ? { worker: activeCandidateRow.worker, affinity: affinityForGroup(activeCandidateRow.worker, group) }
      : undefined;
    const idleFallbacks = [...this.workers]
      .sort((left, right) => latestAffinityTime(left) - latestAffinityTime(right) || left.index - right.index);
    for (const worker of idleFallbacks) {
      if (availability.get(worker.threadId) === "idle") return { worker, activeCandidate };
    }

    // A task that is not currently loaded is still an existing Codex task. It
    // can be loaded by the normal Desktop-owner delivery path, so reusing it is
    // safer than creating another task from an uncertain availability signal.
    for (const candidate of ranked) {
      if (availability.get(candidate.worker.threadId) === "notLoaded") return { worker: candidate.worker };
    }
    for (const worker of idleFallbacks) {
      if (availability.get(worker.threadId) === "notLoaded") return { worker, activeCandidate };
    }

    if (this.workers.length >= this.maxAgents && this.workers.length > 0) {
      const cappedWorker = ranked[0]?.worker ?? idleFallbacks[0] ?? this.workers[0];
      return {
        worker: cappedWorker,
        activeCandidate: activeCandidate?.worker.threadId === cappedWorker.threadId ? undefined : activeCandidate
      };
    }

    const desktopAvailable = await this.desktopAvailableForCreation(availability);
    if (!desktopAvailable) {
      throw new Error("Codex Desktop 当前不可用，消息组已保留等待恢复；RabiRoute 不会依据本地状态新建消息处理任务。");
    }
    return { worker: await this.createWorker(), activeCandidate };
  }

  private async ensureSourceThreadName(): Promise<void> {
    if (this.sourceThreadNameResolved) return;
    try {
      const response = await this.request({ action: "read", threadId: this.options.sourceThreadId });
      this.sourceThreadAvailability = this.availabilityFromResponse(response);
      const title = String(response.thread?.title || "").trim();
      if (title && !title.includes("\n") && title.length <= codexThreadTitleMaxLength) {
        this.sourceThreadName = title;
      }
    } catch {
      // Keep the saved Route display name when Manager cannot resolve the current Desktop title.
      this.sourceThreadAvailability = "unavailable";
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
    if (this.workers.length >= this.maxAgents) {
      throw new Error(`Message Agent pool reached its configured limit of ${this.maxAgents}.`);
    }
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
    const title = workerTitle(baseTitle, index, Math.max(1, this.workers.length + 1), this.maxAgents === 1);
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
      const title = workerTitle(baseTitle, worker.index, count, this.maxAgents === 1);
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

  private async readWorkerAvailability(workers: MessageAgentWorker[]): Promise<Map<string, MessageAgentWorkerAvailability>> {
    const rows = await Promise.all(workers.map(async (worker) => {
      if (this.reservedWorkerIds.has(worker.threadId)) {
        return [worker.threadId, "active"] as const;
      }
      try {
        const response = await this.request({ action: "read", threadId: worker.threadId });
        return [worker.threadId, this.availabilityFromResponse(response)] as const;
      } catch (error) {
        const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
        return [worker.threadId, message.includes("not found") ? "missing" : "unavailable"] as const;
      }
    }));
    return new Map(rows);
  }

  private async desktopAvailableForCreation(
    availability: Map<string, MessageAgentWorkerAvailability>
  ): Promise<boolean> {
    if ([...availability.values()].some((status) => status === "active" || status === "idle" || status === "notLoaded")) {
      return true;
    }
    return this.sourceThreadAvailability === "active"
      || this.sourceThreadAvailability === "idle"
      || this.sourceThreadAvailability === "notLoaded";
  }

  private availabilityFromResponse(response: Record<string, any>): MessageAgentWorkerAvailability {
    const type = String(response.thread?.status?.type || "").trim();
    if (type === "active" || type === "idle" || type === "notLoaded" || type === "unavailable") return type;
    // Compatibility with an older Manager during a rolling restart. The new
    // Manager always returns status.type; this boolean is never persisted.
    if (response.thread?.active === true) return "active";
    if (response.thread?.active === false) return "idle";
    return "unavailable";
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
    atomicWriteFileSync(this.affinityStatePath, `${JSON.stringify(this.affinitySnapshot(), null, 2)}\n`);
  }

  private async managerRequest(payload: Record<string, unknown>): Promise<Record<string, any>> {
    return requestMessageAgentManager(this.options.managerBaseUrl, payload);
  }
}

export function messageAgentPoolStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "agents.json");
}

export function messageAgentAffinityStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "message-groups", "routing-affinity.json");
}
