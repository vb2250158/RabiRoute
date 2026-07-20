import crypto from "node:crypto";
import {
  roleKnowledgeSnapshot,
  type RequiredReadItem,
  type RoleKnowledgeSnapshot
} from "../roleKnowledge.js";

export const RABI_CONTEXT_TRIGGER_KINDS = [
  "session_start",
  "user_prompt",
  "reasoning_pre_tool",
  "reasoning_post_tool",
  "message_delivery",
  "preview"
] as const;

export type RabiContextTriggerKind = typeof RABI_CONTEXT_TRIGGER_KINDS[number];
export type RabiContextPresentation = "full" | "recall_delta";

export type RabiContextTrigger = {
  kind: RabiContextTriggerKind;
  source: "codex_hook" | "rabi_delivery" | "manager_api";
  roleId: string;
  roleDir: string;
  signalText?: string;
  sessionId?: string;
  turnId?: string;
  eventId?: string;
  toolName?: string;
  seenContextKeys?: readonly string[];
  includePendingConsolidation?: boolean;
  consolidationTrigger?: "auto" | "manual" | "api";
  forceConsolidation?: boolean;
};

export type RabiContextTriggerPolicy = {
  presentation: RabiContextPresentation;
  alwaysInject: boolean;
  archiveCompletedPlans: boolean;
  touchViewedAt: boolean;
};

export type RabiContextEntry = {
  key: string;
  item?: RequiredReadItem;
};

export type RabiContextResolution = {
  trigger: RabiContextTrigger;
  policy: RabiContextTriggerPolicy;
  knowledge: RoleKnowledgeSnapshot;
  shouldInject: boolean;
  reason: "entry_context" | "knowledge_match" | "explicit_rabi_context" | "no_match";
  entries: RabiContextEntry[];
};

const EXPLICIT_RABI_CONTEXT_PATTERN = /\[rabi:|\/api\/roles\/[^\s/]+\/(?:plans|memory|skills)|(?:data[\\/])?roles[\\/][^\\/\s]+[\\/](?:plans|memory|persona\.md|growth\.md|skills\.md)/i;

export const RABI_CONTEXT_TRIGGER_POLICIES: Readonly<Record<RabiContextTriggerKind, RabiContextTriggerPolicy>> = Object.freeze({
  session_start: {
    presentation: "full",
    alwaysInject: true,
    archiveCompletedPlans: true,
    touchViewedAt: true
  },
  user_prompt: {
    presentation: "full",
    alwaysInject: true,
    archiveCompletedPlans: true,
    touchViewedAt: true
  },
  reasoning_pre_tool: {
    presentation: "recall_delta",
    alwaysInject: false,
    archiveCompletedPlans: false,
    touchViewedAt: true
  },
  reasoning_post_tool: {
    presentation: "recall_delta",
    alwaysInject: false,
    archiveCompletedPlans: false,
    touchViewedAt: true
  },
  message_delivery: {
    presentation: "full",
    alwaysInject: true,
    archiveCompletedPlans: true,
    touchViewedAt: true
  },
  preview: {
    presentation: "full",
    alwaysInject: true,
    archiveCompletedPlans: false,
    touchViewedAt: false
  }
});

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshotRevision(knowledge: RoleKnowledgeSnapshot): string {
  return fingerprint({
    plans: knowledge.activePlans.map((item) => [item.id, item.status, item.updatedAt]),
    memories: knowledge.recentMemories.map((item) => [item.id, item.updatedAt]),
    skills: knowledge.activeSkills.map((item) => [item.id, item.status, item.updatedAt])
  });
}

export function requiredReadContextKey(item: RequiredReadItem): string {
  return `required:${item.type}:${item.id}:${item.revisionAt}`;
}

export class RabiContextManager {
  resolve(trigger: RabiContextTrigger): RabiContextResolution {
    const policy = RABI_CONTEXT_TRIGGER_POLICIES[trigger.kind];
    const signalText = String(trigger.signalText || "");
    const seenContextKeys = new Set(trigger.seenContextKeys ?? []);
    const knowledge = roleKnowledgeSnapshot(trigger.roleDir, signalText, {
      roleId: trigger.roleId,
      includePendingConsolidation: trigger.includePendingConsolidation,
      consolidationTrigger: trigger.consolidationTrigger,
      forceConsolidation: trigger.forceConsolidation,
      archiveCompletedPlans: policy.archiveCompletedPlans,
      touchViewedAt: policy.touchViewedAt,
      touchRequiredRead: (item) => !seenContextKeys.has(requiredReadContextKey(item))
    });
    const hasKnowledgeMatch = knowledge.requiredReadItems.length > 0;
    const hasExplicitRabiContext = EXPLICIT_RABI_CONTEXT_PATTERN.test(signalText);
    const shouldInject = policy.alwaysInject || hasKnowledgeMatch || hasExplicitRabiContext;
    const reason = policy.alwaysInject
      ? "entry_context"
      : hasKnowledgeMatch
        ? "knowledge_match"
        : hasExplicitRabiContext
          ? "explicit_rabi_context"
          : "no_match";
    const entries: RabiContextEntry[] = knowledge.requiredReadItems.map((item) => ({
      key: requiredReadContextKey(item),
      item
    }));

    if (policy.presentation === "full") {
      entries.unshift({ key: `snapshot:${snapshotRevision(knowledge)}` });
    } else if (hasExplicitRabiContext && entries.length === 0) {
      entries.push({ key: `signal:${fingerprint(signalText.slice(0, 12_000))}` });
    }

    return { trigger, policy, knowledge, shouldInject, reason, entries };
  }
}

export const rabiContextManager = new RabiContextManager();
