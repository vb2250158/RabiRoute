import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { notifyCodex, notifyCodexWhenIdle, type CodexIdleNotificationResult } from "./codexRuntime.js";
import { appendAdapterLog } from "./history.js";
import {
  readRabiLinkConversationTimeline,
  rabiLinkConversationArchiveDir,
  rabiLinkConversationArchiveIndexPath,
  rabiLinkConversationLedgerPath,
  type RabiLinkConversationEntry
} from "./rabilinkConversationLedger.js";

const DEFAULT_REVIEW_INTERVAL_MS = 5000;
const DEFAULT_REVIEW_SETTLE_MS = 4000;
const DEFAULT_REFLECTION_INTERVAL_MS = 30 * 60 * 1000;

type ReviewState = {
  schemaVersion: 1;
  lastScheduledUserEntryId?: string;
  lastHandledReviewRequestId?: string;
  lastScheduledAt?: string;
};

export type RabiLinkConversationReviewResult =
  | { status: "idle" | "settling" | "disabled" | "busy"; pendingUserCount: number; manual: boolean; reflection: boolean }
  | { status: "delivered"; pendingUserCount: number; manual: boolean; reflection: boolean; prompt: string };

export type RabiLinkConversationReviewerOptions = {
  dataDir: string;
  routeProfileId: string;
  gatewayManagerUrl: string;
  agentRolePath?: string;
  autoReviewEnabled?: boolean;
  continuousReflectionEnabled?: boolean;
  intervalMs?: number;
  settleMs?: number;
  reflectionIntervalMs?: number;
  now?: () => number;
  notifyWhenIdle?: (message: string) => Promise<CodexIdleNotificationResult>;
  notifyNow?: (message: string) => Promise<unknown>;
  onBackgroundError?: (error: unknown, trigger: string) => void;
};

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(text)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(text)) return false;
  return fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
}

function reviewStatePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), "rabilink-conversation-review-state.json");
}

function readReviewState(dataDir: string): ReviewState {
  const filePath = reviewStatePath(dataDir);
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ReviewState>;
    return {
      schemaVersion: 1,
      lastScheduledUserEntryId: typeof value.lastScheduledUserEntryId === "string"
        ? value.lastScheduledUserEntryId || undefined
        : undefined,
      lastHandledReviewRequestId: typeof value.lastHandledReviewRequestId === "string"
        ? value.lastHandledReviewRequestId || undefined
        : undefined,
      lastScheduledAt: typeof value.lastScheduledAt === "string" && Number.isFinite(Date.parse(value.lastScheduledAt))
        ? value.lastScheduledAt
        : undefined
    };
  } catch {
    return { schemaVersion: 1 };
  }
}

function writeReviewState(dataDir: string, state: ReviewState): void {
  const filePath = reviewStatePath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function entriesAfter(entries: RabiLinkConversationEntry[], entryId: string | undefined): RabiLinkConversationEntry[] {
  if (!entryId) return entries;
  const index = entries.findIndex((entry) => entry.entryId === entryId);
  return index >= 0 ? entries.slice(index + 1) : entries;
}

function latestEntry(entries: RabiLinkConversationEntry[]): RabiLinkConversationEntry | undefined {
  return entries.length ? entries[entries.length - 1] : undefined;
}

export function buildRabiLinkConversationReviewPrompt(input: {
  ledgerPath: string;
  archiveDir: string;
  archiveIndexPath: string;
  routeProfileId: string;
  gatewayManagerUrl: string;
  agentRolePath?: string;
  reviewPolicyPath?: string;
  pendingUserEntries: RabiLinkConversationEntry[];
  manual: boolean;
  reflection?: boolean;
}): string {
  const first = input.pendingUserEntries[0];
  const last = latestEntry(input.pendingUserEntries);
  const replyApiUrl = `${input.gatewayManagerUrl.replace(/\/+$/, "")}/api/agent/replies`;
  const proactiveReplyBody = JSON.stringify({
    routeProfileId: input.routeProfileId,
    targetType: "rabilink",
    proactive: true,
    source: "RabiLink active intelligence",
    text: "<给用户的一句简短自然文本>"
  });
  return [
    "[RabiLink 主动智能会话审阅]",
    input.manual
      ? "用户刚刚在眼镜连接会话模式单击触摸板，要求你现在查看会话账本。若当前 turn 正在执行，这是一条引导：不要丢弃当前任务，在本轮下一个安全点完成审阅。"
      : input.reflection
        ? "固定 Codex 线程当前空闲。这是一次主动智能连续反思：即使没有新语音，也要结合账本、计划、承诺和本地工作状态，重新判断用户正在做什么、接下来可能需要什么。"
        : "RabiRoute 检测到固定 Codex 线程空闲，并发现尚未审阅的眼镜观察记录。",
    "这不是一条可直接回答的转写正文。不要只根据本提示猜测用户说了什么。",
    "",
    `统一会话账本：${input.ledgerPath}`,
    `历史会话索引：${input.archiveIndexPath}`,
    `历史会话目录：${input.archiveDir}`,
    `本次新增用户记录：${input.pendingUserEntries.length}`,
    `新增范围：${first?.entryId || "无新增用户记录"} -> ${last?.entryId || "无新增用户记录"}`,
    `当前人格：${input.agentRolePath || "使用当前线程已绑定人格"}`,
    input.reviewPolicyPath ? `主动审阅策略：${input.reviewPolicyPath}` : "主动审阅策略：使用本提示中的默认策略",
    "",
    "必须执行：",
    "1. 用结构化方式读取当前 JSONL。每行是一条 JSON；用户观察、Agent 已投递消息和手动审阅请求都在同一条时间线上。新增范围可能跨分卷；当前文件找不到起始 entryId 时，必须读取历史索引并在归档中找到它。",
    input.reflection
      ? "2. 本次可能没有新增用户记录。回看当前账本中足够的用户与 Agent 消息，并检查当前人格目录内相关计划、任务、记忆或最近工具结果；需要跨会话恢复语境时，先读历史索引，再按文件名读取日期归档。"
      : "2. 阅读全部本次新增用户记录，并回看当前账本中足够的先前用户与 Agent 消息；需要跨会话恢复语境时，先读历史索引，再按文件名读取日期归档。归档只分割原始数据，没有摘要。",
    "3. 区分明确对你说的话、环境交谈、媒体声音、半句话和 ASR 噪声。不要把持续录音中的每句话都当成命令。",
    "4. 建立或更新用户意图工作假设：当前活动、真正目标、阻碍、下一步、可利用机会、情绪/认知负荷、时效和用户希望你怎样参与。不要停在表面关键词，也不要把猜测写成事实。",
    "5. 想尽可用办法减轻用户负担。可以主动读取相关本地文件、计划和项目状态，做低风险分析、检索、草稿或预备工作；有价值时给出结果或最小下一步，不要只问泛泛的“需要我帮忙吗”。",
    "6. 只有在能带来明确帮助时才主动打断：直接问题、时间敏感提醒、风险、重要遗漏、可立即推进的下一步，或用户明确要求你介入。普通闲聊、重复、背景音和低置信片段保持安静。",
    "7. 任何外发、删除、购买、设备控制或配置高风险动作仍需遵守 RabiRoute 安全门；不要因为旁听到一句话就擅自执行。",
    `8. 需要对眼镜说话时，以 Content-Type=application/json POST ${replyApiUrl}。请求体示例：${proactiveReplyBody}。下行不依赖上行 taskId，眼镜会按队列调用原生 TTS。`,
    "9. 只有接口返回 ok=true 且 status=sent 才视为已投递；成功下行会自动写回同一账本。不要复述内部路径、entryId、JSON 字段或审阅过程，也不要重复已经投递过的内容。",
    input.manual
      ? "10. 这是用户手动要求审阅：即使暂时没有要执行的动作，也应给眼镜一句很短的自然确认，说明你已经看过并给出最有用的一点结论。"
      : "10. 如果没有值得打断用户的内容，不调用下行接口；可以完成有用的静默准备，并在 Codex 线程内简短记录判断。"
  ].filter(Boolean).join("\n");
}

export class RabiLinkConversationReviewer {
  private readonly dataDir: string;
  private readonly routeProfileId: string;
  private readonly gatewayManagerUrl: string;
  private readonly agentRolePath: string;
  private readonly autoReviewEnabled: boolean;
  private readonly continuousReflectionEnabled: boolean;
  private readonly intervalMs: number;
  private readonly settleMs: number;
  private readonly reflectionIntervalMs: number;
  private readonly now: () => number;
  private readonly notifyWhenIdle: (message: string) => Promise<CodexIdleNotificationResult>;
  private readonly notifyNow: (message: string) => Promise<unknown>;
  private readonly onBackgroundError: (error: unknown, trigger: string) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<RabiLinkConversationReviewResult> | null = null;
  private wakeQueued = false;

  constructor(options: RabiLinkConversationReviewerOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.routeProfileId = options.routeProfileId;
    this.gatewayManagerUrl = options.gatewayManagerUrl.replace(/\/+$/, "");
    this.agentRolePath = options.agentRolePath ? path.resolve(options.agentRolePath) : "";
    this.autoReviewEnabled = options.autoReviewEnabled !== false;
    this.continuousReflectionEnabled = options.continuousReflectionEnabled !== false;
    this.intervalMs = boundedNumber(options.intervalMs, DEFAULT_REVIEW_INTERVAL_MS, 1000, 60000);
    this.settleMs = boundedNumber(options.settleMs, DEFAULT_REVIEW_SETTLE_MS, 0, 60000);
    this.reflectionIntervalMs = boundedNumber(
      options.reflectionIntervalMs,
      DEFAULT_REFLECTION_INTERVAL_MS,
      60 * 1000,
      24 * 60 * 60 * 1000
    );
    this.now = options.now ?? Date.now;
    this.notifyWhenIdle = options.notifyWhenIdle ?? notifyCodexWhenIdle;
    this.notifyNow = options.notifyNow ?? notifyCodex;
    this.onBackgroundError = options.onBackgroundError ?? ((error, trigger) => {
      appendAdapterLog("rabilink", {
        level: "warning",
        event: "conversation_review_deferred",
        message: "RabiLink conversation review was deferred because the Codex runtime is temporarily unavailable.",
        data: {
          trigger,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.checkInBackground("interval"); }, this.intervalMs);
    this.checkInBackground("startup");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.running) {
      this.wakeQueued = true;
      return;
    }
    this.checkInBackground("wake");
  }

  check(): Promise<RabiLinkConversationReviewResult> {
    if (this.running) return this.running;
    const run = this.checkInternal().finally(() => {
      if (this.running === run) this.running = null;
      if (this.wakeQueued) {
        this.wakeQueued = false;
        queueMicrotask(() => { this.checkInBackground("queued_wake"); });
      }
    });
    this.running = run;
    return run;
  }

  private checkInBackground(trigger: string): void {
    void this.check().catch((error) => {
      try {
        this.onBackgroundError(error, trigger);
      } catch (reportError) {
        console.error(
          `RabiLink conversation review error reporting failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`
        );
      }
    });
  }

  private async checkInternal(): Promise<RabiLinkConversationReviewResult> {
    const entries = readRabiLinkConversationTimeline(this.dataDir);
    const state = readReviewState(this.dataDir);
    const pendingUserEntries = entriesAfter(entries, state.lastScheduledUserEntryId)
      .filter((entry) => entry.direction === "user_to_agent" && entry.requiresReview === true);
    const pendingReviewRequests = entriesAfter(entries, state.lastHandledReviewRequestId)
      .filter((entry) => entry.kind === "review_request" && entry.reviewRequested === true);
    const manual = pendingReviewRequests.length > 0;
    const lastScheduledAt = Date.parse(state.lastScheduledAt || "");
    const latestLedgerAt = Date.parse(latestEntry(entries)?.recordedAt || "");
    const reflectionBaseline = Number.isFinite(lastScheduledAt) ? lastScheduledAt : latestLedgerAt;
    const reflectionDue = !manual
      && this.continuousReflectionEnabled
      && entries.length > 0
      && Number.isFinite(reflectionBaseline)
      && this.now() - reflectionBaseline >= this.reflectionIntervalMs;
    const reflection = reflectionDue
      && (pendingUserEntries.length === 0 || !this.autoReviewEnabled);

    if (!manual && pendingUserEntries.length === 0 && !reflection) {
      return { status: "idle", pendingUserCount: 0, manual: false, reflection: false };
    }
    if (!manual && pendingUserEntries.length > 0 && !this.autoReviewEnabled && !reflection) {
      return { status: "disabled", pendingUserCount: pendingUserEntries.length, manual: false, reflection };
    }
    const newestUser = latestEntry(pendingUserEntries);
    const newestUserTime = newestUser ? Date.parse(newestUser.recordedAt) : 0;
    if (!manual && newestUserTime > 0 && this.now() - newestUserTime < this.settleMs) {
      return { status: "settling", pendingUserCount: pendingUserEntries.length, manual: false, reflection: false };
    }

    const reviewPolicyPath = this.agentRolePath
      ? path.join(path.dirname(this.agentRolePath), "prompts", "rabilink-proactive-review.md")
      : "";
    const prompt = buildRabiLinkConversationReviewPrompt({
      ledgerPath: rabiLinkConversationLedgerPath(this.dataDir),
      archiveDir: rabiLinkConversationArchiveDir(this.dataDir),
      archiveIndexPath: rabiLinkConversationArchiveIndexPath(this.dataDir),
      routeProfileId: this.routeProfileId,
      gatewayManagerUrl: this.gatewayManagerUrl,
      agentRolePath: this.agentRolePath,
      reviewPolicyPath: reviewPolicyPath && fs.existsSync(reviewPolicyPath) ? reviewPolicyPath : undefined,
      pendingUserEntries,
      manual,
      reflection
    });

    if (manual) {
      await this.notifyNow(prompt);
    } else {
      const delivery = await this.notifyWhenIdle(prompt);
      if (delivery.status === "busy") {
        return { status: "busy", pendingUserCount: pendingUserEntries.length, manual: false, reflection };
      }
    }

    writeReviewState(this.dataDir, {
      schemaVersion: 1,
      lastScheduledUserEntryId: latestEntry(pendingUserEntries)?.entryId ?? state.lastScheduledUserEntryId,
      lastHandledReviewRequestId: latestEntry(pendingReviewRequests)?.entryId ?? state.lastHandledReviewRequestId,
      lastScheduledAt: new Date(this.now()).toISOString()
    });
    appendAdapterLog("rabilink", {
      event: manual
        ? "conversation_review_guided"
        : reflection
          ? "conversation_reflection_scheduled"
          : "conversation_review_scheduled",
      message: manual
        ? "Touchpad review request was delivered to the current Codex turn or started as a new turn."
        : reflection
          ? "A periodic active-intelligence reflection was delivered after the Codex thread became idle."
          : "Unreviewed RabiLink observations were delivered after the Codex thread became idle.",
      data: {
        ledgerPath: rabiLinkConversationLedgerPath(this.dataDir),
        pendingUserCount: pendingUserEntries.length,
        manual,
        reflection
      }
    });
    return { status: "delivered", pendingUserCount: pendingUserEntries.length, manual, reflection, prompt };
  }
}

let defaultReviewer: RabiLinkConversationReviewer | null = null;

export function startDefaultRabiLinkConversationReviewer(): RabiLinkConversationReviewer | null {
  if (!config.agentAdapters.includes("codex")) {
    appendAdapterLog("rabilink", {
      level: "warning",
      event: "conversation_reviewer_disabled",
      message: "RabiLink conversation review currently requires the Codex app-server adapter."
    });
    return null;
  }
  if (defaultReviewer) return defaultReviewer;
  const variables = config.routeVariables;
  const autoReviewEnabled = optionalBoolean(variables.rabilinkAutoReview, true);
  defaultReviewer = new RabiLinkConversationReviewer({
    dataDir: config.memoryDataDir,
    routeProfileId: process.env.GATEWAY_ID?.trim() || config.routeProfiles[0]?.id || "rabilink",
    gatewayManagerUrl: process.env.GATEWAY_MANAGER_URL?.trim() || "http://127.0.0.1:8790",
    agentRolePath: config.agentRolePath,
    autoReviewEnabled,
    continuousReflectionEnabled: optionalBoolean(variables.rabilinkContinuousReflection, autoReviewEnabled),
    intervalMs: boundedNumber(variables.rabilinkReviewIntervalMs, DEFAULT_REVIEW_INTERVAL_MS, 1000, 60000),
    settleMs: boundedNumber(variables.rabilinkReviewSettleMs, DEFAULT_REVIEW_SETTLE_MS, 0, 60000),
    reflectionIntervalMs: boundedNumber(
      variables.rabilinkReflectionIntervalMinutes == null
        ? DEFAULT_REFLECTION_INTERVAL_MS
        : Number(variables.rabilinkReflectionIntervalMinutes) * 60 * 1000,
      DEFAULT_REFLECTION_INTERVAL_MS,
      60 * 1000,
      24 * 60 * 60 * 1000
    )
  });
  defaultReviewer.start();
  return defaultReviewer;
}
