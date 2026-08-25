import path from "node:path";
import crypto from "node:crypto";
import type { PlanItem } from "../roleKnowledge.js";

export type PangHuProgressIssue = {
  groupId: string;
  sourceMessageId: string;
  module?: string;
  summary?: string;
};

export type PangHuProgressNotificationDelivery = {
  roleId: string;
  roleDir: string;
  plan: PlanItem;
  issue: PangHuProgressIssue;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceCwd?: string;
  finalMessage: string;
  gatewayId?: string;
};

export type PangHuProgressNotificationResult = {
  status: "ignored" | "duplicate" | "sent" | "failed";
  reason: string;
  planId?: string;
  turnId?: string;
  deliveryId?: string;
  sentMessageId?: string;
  platformReferenceReadback?: boolean;
  error?: string;
};

const DEFAULT_PANGHU_WORKSPACES = [
  "C:\\Data\\CottonProject\\PangHu",
  "C:\\Data\\CottonProject\\PangHu_Release",
  "C:\\Data\\CottonProject\\PangHu_Art"
];

function normalized(value: string | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const resolved = path.resolve(text).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPangHuWorkspace(value: string | undefined, workspaces = DEFAULT_PANGHU_WORKSPACES): boolean {
  const actual = normalized(value);
  if (!actual) return false;
  return workspaces.some((workspace) => {
    const root = normalized(workspace);
    return actual === root || actual.startsWith(`${root}/`);
  });
}

export function hasEffectiveProgress(finalMessage: string | undefined): boolean {
  const text = String(finalMessage || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (text.length < 8) return false;
  return !/(无变化|没有变化|继续轮询|重复轮询|unchanged|no\s+progress|heartbeat|keepalive|^ping$)/i.test(text);
}

export function stablePangHuProgressDeliveryId(planId: string, sourceSessionId: string, sourceTurnId: string): string {
  const digest = crypto.createHash("sha256")
    .update(`${String(planId || "").trim()}\0${String(sourceSessionId || "").trim()}\0${String(sourceTurnId || "").trim()}`, "utf8")
    .digest("hex");
  return `panghu-progress-${digest}`;
}

export function isCompletePangHuProgressReceipt(value: unknown): value is {
  status: "sent";
  sentMessageId: string;
  platformReferenceReadback: true;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.status === "sent"
    && Boolean(String(record.sentMessageId || "").trim())
    && record.platformReferenceReadback === true;
}

export function pangHuProgressMessage(delivery: PangHuProgressNotificationDelivery): string {
  const module = String(delivery.issue.module || "问题进展").trim();
  const summary = String(delivery.issue.summary || delivery.plan.title || "").trim();
  const firstLine = String(delivery.finalMessage || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "已产生新的有效进展。";
  const nextAction = String(delivery.plan.nextAction || "继续按当前计划推进并补齐下一项证据。").trim();
  return [
    `【${module}${summary ? `/${summary}` : ""}】`,
    `进度：${firstLine}`,
    `下一步：${nextAction}`
  ].join("\n");
}
