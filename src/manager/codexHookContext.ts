import crypto, { randomUUID } from "node:crypto";
import { planCanAutoAdvance } from "../planState.js";
import fs from "node:fs";
import path from "node:path";
import { type RabiContextTriggerKind } from "../context/rabiContextManager.js";
import { readCodexHookContextInput, type CodexHookContextReadRequest, type CodexHookContextReadReply, type CodexHookRoleSource } from "./codexHookContextRead.js";
import { ensurePlanStorageLayout, listPlans, RoleKnowledgeCacheUnavailableError, type PlanItem } from "../roleKnowledge.js";
import { ensurePersonaPlanWorkflow, planStatusDefinition } from "../personaPlanWorkflow.js";
import { buildRoleKnowledgeContextView } from "../routing/roleKnowledgeContext.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { appendPersonaChatReply } from "../personaChatHistory.js";
import { readPersonaConfigFragment } from "./configMigration.js";
import { decidePlanFollowup, type PlanFollowupReceipt } from "./planFollowup.js";
import { agentHookSettingsFor } from "../shared/gatewayConfigModel.js";
import { planBindingDeliveryIdentity, planBindingMatchesSource, planBindingSourceKey, type PlanBindingSourceInstance } from "../shared/planBindingOwner.js";
import type { AgentThreadRemoteSource } from "../agentThreads.js";

const STORE_VERSION = 9;
const MAX_CONTEXT_CHARS = 6200;
const CONTROL_PATTERN = /\[rabi:(use|bind)\s+([^\]\r\n]{1,80})\]|\[rabi:(status|refresh|off)\]/i;
// Only the delivery's explicit runId line may select a consolidation run.
const CONSOLIDATION_RUN_LINE = /^runId：([^\s\r\n]{1,240})\s*$/gm;

/** Role dirs already reported as having no published plan catalog, so a cold role logs once. */
const coldPlanCatalogRoles = new Set<string>();

export type CodexHookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export type PlanTaskCompletionDelivery = {
  roleId: string;
  roleDir: string;
  plan: PlanItem;
  sourceSessionId: string;
  sourceAgentType?: string;
  sourceInstance?: PlanBindingSourceInstance;
  /** Current ingress attribution for this callback only; never persisted in Hook state. */
  trustedRemoteSource?: AgentThreadRemoteSource;
  sourceTurnId: string;
  sourceCwd?: string;
  finalMessage: string;
  gatewayId?: string;
};

export type PlanTaskCompletionResult = {
  status: "ignored" | "duplicate" | "delivered" | "failed";
  reason: string;
  planId?: string;
  turnId?: string;
  gatewayId?: string;
  error?: string;
};

export type AgentRequestStopResult = {
  status: "ignored" | "recorded" | "pending" | "failed";
  reason: string;
  requestIds?: string[];
  /** Complete pending IDs for this exact session across all its workspaces. */
  pendingSessionRequestIds?: string[];
  snapshotComplete?: boolean;
  turnId?: string;
  error?: string;
};

export type ProjectFileChangeReminderResult = {
  status: "ignored" | "delivered" | "failed";
  reason: string;
  planId?: string;
  planIds?: string[];
  turnId?: string;
  files?: string[];
  error?: string;
};

export type CodexHookSessionBinding = {
  sessionId: string;
  agentType?: string;
  sourceInstance?: PlanBindingSourceInstance;
  roleId: string;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
  lastEventName?: CodexHookEventName;
  cwd?: string;
  baseFingerprint?: string;
  lastTurnId?: string;
  turnContextKeys?: string[];
  /** Manager-validated run scope for this turn; never inferred from outstanding runs. */
  activeRunId?: string;
  consolidationTurnId?: string;
  consolidationInputMemoryIds?: string[];
  lastPlanCompletionPlanId?: string;
  lastPlanCompletionTurnId?: string;
  lastPlanCompletionAt?: string;
  lastPlanCompletionStatus?: PlanTaskCompletionResult["status"];
  lastPlanCompletionError?: string;
};

export type PlanTaskCompletionState = {
  sessionId: string;
  agentType?: string;
  sourceInstance?: PlanBindingSourceInstance;
  roleId?: string;
  planId?: string;
  turnId?: string;
  updatedAt: string;
  status: PlanTaskCompletionResult["status"];
  gatewayId?: string;
  error?: string;
};

export type ProjectFileChangeState = {
  files: string[];
  workspaces: string[];
};

type CodexHookSessionStoreFile = {
  planFollowups?: Record<string, PlanFollowupReceipt>;
  /** Original entries whose old key lacks enough recorded owner metadata; never a replay source. */
  unattributedSessionState?: Record<string, Record<string, unknown>>;
  /** Presentation-only attempts; never Agent delivery or response receipts. */
  agentRequestStopReminders?: Record<string, string[]>;
  /** One current continuation barrier per native session, not a reply receipt. */
  agentRequestStopFollowupTurns?: Record<string, string>;
  version: number;
  sessions: Record<string, CodexHookSessionBinding>;
  planTaskCompletions: Record<string, PlanTaskCompletionState>;
  projectFileChanges: Record<string, Record<string, ProjectFileChangeState>>;
  projectFileChangeReminders: Record<string, Record<string, string>>;
};

export type CodexHookContextRequest = {
  agentType?: string;
  /** Assigned by authenticated ingress, not accepted from the request body. */
  sourceInstance?: PlanBindingSourceInstance;
  /** Current authenticated ingress attribution; never accepted from request JSON. */
  trustedRemoteSource?: AgentThreadRemoteSource;
  sessionId: string;
  eventName: CodexHookEventName;
  prompt?: string;
  source?: string;
  cwd?: string;
  managerBaseUrl?: string;
  turnId?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  stopHookActive?: boolean;
  lastAssistantMessage?: string;
};

export type CodexHookContextResult = {
  /** Monotonic milliseconds relative to Hook entry; labels contain no request content. */
  timings?: { name: string; startMs: number; durationMs: number }[];
  followup?: { decision: "block"; reason: string };
  completionDeliveries?: import("./agentCompletionDelivery.js").CompletionDeliveryResult[];
  /** Repeated initial Stop must not publish a preliminary final while this turn continues. */
  completionDeferred?: boolean;
  action: "none" | "bind" | "status" | "refresh" | "off";
  binding: CodexHookSessionBinding | null;
  additionalContext: string;
  planTaskCompletion?: PlanTaskCompletionResult;
  projectFileChangeReminder?: ProjectFileChangeReminderResult;
  agentRequestStop?: AgentRequestStopResult;
  toolDecision?: { permissionDecision: "deny"; reason: string };
};

export type CodexHookControl =
  | { action: "bind"; roleId: string }
  | { action: "status" | "refresh" | "off" };

export type CodexHookContextServiceOptions = {
  /** Reports Stop progress before awaiting each stage, including failed stages. Observers cannot change Hook results. */
  onHookStage?: (request: CodexHookContextRequest, stage: {
    name: string; phase: "started" | "completed" | "failed"; startMs: number; durationMs?: number;
  }) => void;
  readContext?: (input: CodexHookContextReadRequest) => Promise<CodexHookContextReadReply>;
  deliverAgentCompletion?: (request: CodexHookContextRequest, roleIds?: readonly string[]) => Promise<import("./agentCompletionDelivery.js").CompletionDeliveryResult[]>;
  rolesRoot: () => string;
  storePath: string;
  deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  hookEnabled?: (request: CodexHookContextRequest) => boolean;
  recordAgentRequestStop?: (request: CodexHookContextRequest) => Promise<AgentRequestStopResult> | AgentRequestStopResult;
  chatHistoryRoleIds?: (request: CodexHookContextRequest) => readonly string[];
  /** Undefined means an ordinary session; an empty input list means dedicated but not yet verified. */
  memoryConsolidationInputIds?: (
    request: CodexHookContextRequest, roleId: string, runId?: string
  ) => { runId?: string; inputMemoryIds: readonly string[] } | undefined;
  onChatHistoryChanged?: (roleId: string) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

function section(title: string, content: string | string[]): string {
  const text = (Array.isArray(content) ? content.join("\n") : content).trim();
  return text ? `[${title}]\n${text}` : "";
}

function excerpt(value: string, limit: number, tail = 0): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  if (tail > 0 && limit > tail + 80) {
    const headLength = limit - tail - 45;
    return `${text.slice(0, headLength).trimEnd()}\n\n[...Rabi context clipped...]\n\n${text.slice(-tail).trimStart()}`;
  }
  return `${text.slice(0, Math.max(0, limit - 35)).trimEnd()}\n[...Rabi context clipped...]`;
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temporaryPath, content, "utf8");
    fs.renameSync(temporaryPath, filePath);
    recordDataMutationAudit({
      group: "agent-session",
      event: "codex_hook_context_written",
      owner: "codex-hook-context",
      action: "persist-state",
      target: { type: "hook-context-store", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `runtime/${path.basename(filePath)}` },
      outcome: "committed",
      after: { digest: crypto.createHash("sha256").update(content).digest("hex") }
    });
  } catch (error) {
    recordDataMutationAudit({
      level: "error",
      group: "agent-session",
      event: "codex_hook_context_write_failed",
      owner: "codex-hook-context",
      action: "persist-state",
      target: { type: "hook-context-store", id: path.basename(filePath) },
      dataSource: { kind: "file", id: `runtime/${path.basename(filePath)}` },
      outcome: "failed",
      error
    });
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizeManagerBaseUrl(value: string | undefined): string {
  const resolved = String(value || process.env.GATEWAY_MANAGER_URL || "").trim().replace(/\/+$/, "");
  if (!resolved) throw new Error("Manager base URL is required for Codex hook context.");
  return resolved;
}

function normalizedWorkspace(value: string | undefined): string {
  const text = String(value || "").trim();
  if (!text) return "";
  const resolved = path.resolve(text).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fingerprint(values: string[]): string {
  return crypto.createHash("sha256").update(values.join("\0")).digest("hex");
}

function planTaskCompletionKey(sourceIdentity: string | readonly string[], planId: string | undefined, turnId: string | undefined): string {
  return typeof sourceIdentity === "string"
    ? fingerprint(["plan_task_completion", sourceIdentity, planId || "", turnId || ""])
    : crypto.createHash("sha256").update(JSON.stringify(["plan_task_completion", sourceIdentity, planId || "", turnId || ""])).digest("hex");
}

function boundedJson(value: unknown, limit: number): string {
  if (value == null) return "";
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return excerpt(text, limit, Math.min(800, Math.floor(limit / 4)));
}

function triggerKind(eventName: CodexHookEventName): RabiContextTriggerKind {
  if (eventName === "SessionStart") return "session_start";
  if (eventName === "UserPromptSubmit") return "user_prompt";
  if (eventName === "PreToolUse") return "reasoning_pre_tool";
  return "reasoning_post_tool";
}

function explicitConsolidationRunId(prompt: string): string | undefined {
  const matches = [...prompt.matchAll(CONSOLIDATION_RUN_LINE)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function triggerSignal(request: CodexHookContextRequest): string {
  if (request.eventName === "UserPromptSubmit") return String(request.prompt || "");
  if (request.eventName === "SessionStart") return "";
  return [
    request.toolName ? `tool_name: ${request.toolName}` : "",
    request.toolInput == null ? "" : `tool_input:\n${boundedJson(request.toolInput, 12_000)}`,
    request.eventName === "PostToolUse" && request.toolResponse != null
      ? `tool_response:\n${boundedJson(request.toolResponse, 18_000)}`
      : ""
  ].filter(Boolean).join("\n\n");
}

function toolText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function filePathsFromPatch(value: unknown): string[] {
  const patch = value && typeof value === "object" && typeof (value as Record<string, unknown>).patch === "string"
    ? (value as Record<string, unknown>).patch as string
    : toolText(value);
  return patch.split(/\r?\n/)
    .map((line) => line.match(/^(?:\*\*\*|\+\+\+)\s+(?:Add|Update|Delete) File:\s+(.+)$/)?.[1]?.trim() || "")
    .filter(Boolean);
}

function filePathsFromToolInput(toolName: string | undefined, input: unknown): string[] {
  const name = String(toolName || "").toLowerCase();
  const text = toolText(input);
  if (name.includes("apply_patch") || name.includes("applypatch")) return filePathsFromPatch(input);
  if (/(^|[._-])(edit|write|create|delete|move|copy)([._-]|$)/.test(name)) {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    return [record.path, record.filePath, record.file_path, record.destination, record.destinationPath]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim());
  }
  if (!/(bash|shell|command|terminal|exec)/.test(name)) return [];
  const command = input && typeof input === "object"
    ? String((input as Record<string, unknown>).command || (input as Record<string, unknown>).cmd || "")
    : text;
  if (!/(?:>|>>|\b(?:set-content|add-content|out-file|copy-item|move-item|remove-item|new-item|touch)\b)/i.test(command)) return [];
  const powerShellPath = (verb: string, option: string) => [...command.matchAll(new RegExp(`\\b${verb}\\b[^\\r\\n;|&]*?-${option}\\s+['\"]?([^\\s'\";|&]+)`, "gi"))];
  const directPathMatches = [
    ...powerShellPath("set-content", "(?:path|literalpath)"),
    ...powerShellPath("add-content", "(?:path|literalpath)"),
    ...powerShellPath("out-file", "(?:filepath|literalpath)"),
    ...powerShellPath("new-item", "(?:path|literalpath)"),
    ...powerShellPath("remove-item", "(?:path|literalpath)"),
    ...powerShellPath("copy-item", "destination"),
    ...powerShellPath("move-item", "destination")
  ];
  const redirectMatches = [...command.matchAll(/(?:^|\s)>>?\s*['\"]?([^\s'\";|&]+)/g)];
  const touchMatches = [...command.matchAll(/\btouch\b\s+['\"]?([^\s'\";|&]+)/gi)];
  return [...directPathMatches, ...redirectMatches, ...touchMatches].map((match) => match[1]).filter(Boolean);
}

function successfulWriteResponse(value: unknown): boolean {
  const text = toolText(value).trim();
  if (!text) return false;
  return !/(?:\bfailed\b|\berror\b|\bno changes?\b|\bunchanged\b|exit code\s*[1-9])/i.test(text);
}

function projectRelativePaths(workspaces: string[], cwd: string | undefined, candidates: string[]): string[] {
  if (!cwd || workspaces.length === 0) return [];
  return [...new Set(candidates.flatMap((candidate) => {
    const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    const root = workspaces.find((workspace) => {
      const normalizedRoot = normalizedWorkspace(workspace);
      const resolved = normalizedWorkspace(absolutePath);
      return normalizedRoot && (resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`));
    });
    if (!root) return [];
    const relative = path.relative(root, absolutePath).replace(/\\/g, "/");
    return relative && !relative.startsWith("../") ? [relative] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

function matchedProjectWorkspaces(workspaces: string[], cwd: string | undefined, candidates: string[]): string[] {
  if (!cwd) return [];
  return [...new Set(candidates.flatMap((candidate) => {
    const resolved = normalizedWorkspace(path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate));
    return workspaces.filter((workspace) => {
      const root = normalizedWorkspace(workspace);
      return root && (resolved === root || resolved.startsWith(`${root}/`));
    }).map(normalizedWorkspace);
  }))];
}

function retainNewest<T>(record: Record<string, T>, maximumEntries: number): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-maximumEntries));
}

export function parseCodexHookControl(prompt: string): CodexHookControl | null {
  const match = String(prompt || "").match(CONTROL_PATTERN);
  if (!match) return null;
  if (match[1]) {
    const roleId = sanitizeRoleId(match[2]);
    if (!roleId) throw new Error("Rabi role ID is invalid.");
    return { action: "bind", roleId };
  }
  return { action: match[3].toLowerCase() as "status" | "refresh" | "off" };
}

/** Upgrade storage coordinates in memory only; the existing write boundary owns publication. */
function migrateHookSessionKeys(store: CodexHookSessionStoreFile): CodexHookSessionStoreFile {
  if (store.version >= STORE_VERSION) return store;
  const localIds = new Set<string>(), remoteKeys = new Set<string>();
  const noteOwner = (value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as CodexHookSessionBinding).sessionId !== "string") return;
    const row = value as CodexHookSessionBinding;
    if (!row.sourceInstance) localIds.add(row.sessionId);
    else if (typeof row.sourceInstance.instanceId === "string") remoteKeys.add(planBindingSourceKey(row));
  };
  Object.values(store.sessions).forEach(noteOwner);
  Object.values(store.planTaskCompletions).forEach(noteOwner);
  const unattributed = { ...store.unattributedSessionState };
  const retainUnattributed = (key: string, field: string, value: unknown) => {
    unattributed[key] = { ...unattributed[key], [field]: value };
  };
  const looksRemote = (key: string): boolean => {
    try {
      const tuple: unknown = JSON.parse(key);
      return Array.isArray(tuple) && (tuple.length === 5 || tuple.length === 6)
        && tuple[0] === "remote" && tuple.every(value => typeof value === "string");
    } catch { return false; }
  };
  const move = (field: string, source: Record<string, unknown>, identityRows = false): Record<string, unknown> => {
    const output: Record<string, unknown> = Object.create(null);
    const origin = new Map<string, string>(), collisions = new Set<string>();
    for (const [key, value] of Object.entries(source)) {
      let target = key;
      if (identityRows) {
        const row = value as CodexHookSessionBinding | undefined;
        if (!row || typeof row !== "object" || typeof row.sessionId !== "string") {
          retainUnattributed(key, field, value); continue;
        }
        target = planBindingSourceKey(row);
      } else if (key.startsWith("[")) {
        const local = localIds.has(key), remote = remoteKeys.has(key);
        if ((local && remote) || (!local && !remote && looksRemote(key))) {
          retainUnattributed(key, field, value); continue;
        }
        if (!remote) target = planBindingSourceKey({ sessionId: key });
      }
      if (collisions.has(target)) { retainUnattributed(key, field, value); continue; }
      if (Object.hasOwn(output, target)) {
        retainUnattributed(origin.get(target)!, field, output[target]);
        retainUnattributed(key, field, value); delete output[target]; collisions.add(target);
      } else { output[target] = value; origin.set(target, key); }
    }
    return output;
  };
  const migrated = { ...store, version: STORE_VERSION,
    sessions: move("sessions", store.sessions, true) as Record<string, CodexHookSessionBinding> };
  for (const field of ["projectFileChanges", "projectFileChangeReminders", "agentRequestStopReminders", "agentRequestStopFollowupTurns"] as const) {
    if (store[field]) Object.assign(migrated, { [field]: move(field, store[field]!) });
  }
  if (Object.keys(unattributed).length) migrated.unattributedSessionState = unattributed;
  return migrated;
}

/** Same file-revision identity used by the existing plan read cache, scoped to this owner. */
function hookStoreRevision(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function freezeHookStore<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeHookStore(child);
    Object.freeze(value);
  }
  return value;
}

export class CodexHookContextService {
  private readonly onHookStage?: CodexHookContextServiceOptions["onHookStage"];
  private readonly readContext?: CodexHookContextServiceOptions["readContext"];
  private readonly contextQueues = new Map<string, { tail: Promise<void>; pending: number }>();
  private storeSnapshot?: { revision: string; value: CodexHookSessionStoreFile; legacyRaw?: Buffer };
  private readonly rolesRoot: () => string;
  private readonly storePath: string;
  private readonly deliverPlanTaskCompletion?: (delivery: PlanTaskCompletionDelivery) => Promise<void>;
  private readonly hookEnabled?: (request: CodexHookContextRequest) => boolean;
  private readonly recordAgentRequestStop?: (request: CodexHookContextRequest) => Promise<AgentRequestStopResult> | AgentRequestStopResult;
  private readonly chatHistoryRoleIds?: CodexHookContextServiceOptions["chatHistoryRoleIds"];
  private readonly memoryConsolidationInputIds?: CodexHookContextServiceOptions["memoryConsolidationInputIds"];
  private readonly onChatHistoryChanged?: CodexHookContextServiceOptions["onChatHistoryChanged"];

  private readonly deliverAgentCompletion?: CodexHookContextServiceOptions["deliverAgentCompletion"];

  constructor(options: CodexHookContextServiceOptions) {
    this.onHookStage = options.onHookStage;
    this.readContext = options.readContext;
    this.deliverAgentCompletion = options.deliverAgentCompletion;
    this.rolesRoot = options.rolesRoot;
    this.storePath = path.resolve(options.storePath);
    this.deliverPlanTaskCompletion = options.deliverPlanTaskCompletion;
    this.hookEnabled = options.hookEnabled;
    this.recordAgentRequestStop = options.recordAgentRequestStop;
    this.chatHistoryRoleIds = options.chatHistoryRoleIds;
    this.memoryConsolidationInputIds = options.memoryConsolidationInputIds;
    this.onChatHistoryChanged = options.onChatHistoryChanged;
  }

  listRoles(): string[] {
    const root = path.resolve(this.rolesRoot());
    if (!fs.existsSync(root)) return [];
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && Boolean(sanitizeRoleId(entry.name)))
      .filter((entry) => fs.existsSync(path.join(root, entry.name, "persona.md")))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  /**
   * A role without a published plan catalog is a legitimate cold state, not a
   * failure: one unprepared role must never abort the whole role traversal.
   * The storage layout is created on demand so the first real write lands in
   * the canonical buckets, and the cold state is reported once per role so a
   * missing catalog stays diagnosable without failing a normal delivery.
   */
  private listPlansOrCold(roleDir: string): PlanItem[] {
    try {
      return listPlans(roleDir);
    } catch (error) {
      if (!(error instanceof RoleKnowledgeCacheUnavailableError)) throw error;
      try {
        ensurePlanStorageLayout(roleDir);
      } catch {
        // A read-only or unresolved role dir must still degrade to an empty catalog.
      }
      if (!coldPlanCatalogRoles.has(roleDir)) {
        coldPlanCatalogRoles.add(roleDir);
        console.warn(`[rabi] role plan catalog is cold; skipping this role: ${roleDir}`);
      }
      return [];
    }
  }

  listBindings(): CodexHookSessionBinding[] {
    return Object.values(this.readStore().sessions).map(binding => structuredClone(binding))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getBinding(sessionId: string, sourceInstance?: PlanBindingSourceInstance, agentType?: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    const sessions = this.readStore().sessions, key = planBindingSourceKey({ sessionId: id, agentType, sourceInstance });
    return Object.hasOwn(sessions, key) ? structuredClone(sessions[key]!) : null;
  }

  private sessionPlanRoleIds(sessionId: string, sourceInstance?: PlanBindingSourceInstance, agentType?: string): readonly string[] | undefined {
    // Looking up an absent store must not create it before the recovery check.
    const binding = fs.existsSync(this.storePath) ? this.getBinding(sessionId, sourceInstance, agentType) : null;
    return binding ? [binding.roleId] : undefined;
  }

  bindSession(sessionId: string, roleId: string, sourceInstance?: PlanBindingSourceInstance, agentType?: string): CodexHookSessionBinding {
    const id = this.requireSessionId(sessionId);
    const role = this.requireRole(roleId);
    return this.bindValidatedSession(id, role.roleId, sourceInstance, agentType);
  }

  private bindValidatedSession(id: string, roleId: string, sourceInstance?: PlanBindingSourceInstance, agentType?: string): CodexHookSessionBinding {
    const store = this.readStore();
    const key = planBindingSourceKey({ sessionId: id, agentType, sourceInstance });
    const previous = store.sessions[key];
    const timestamp = nowIso();
    const binding: CodexHookSessionBinding = {
      sessionId: id,
      ...(sourceInstance ? { sourceInstance, agentType: agentType || "codex" } : {}),
      roleId,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    store.sessions = { ...store.sessions, [key]: binding };
    this.writeStore(store);
    return structuredClone(binding);
  }

  unbindSession(sessionId: string, sourceInstance?: PlanBindingSourceInstance, agentType?: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    const key = planBindingSourceKey({ sessionId: id, agentType, sourceInstance });
    const store = this.readStore();
    const previous = store.sessions[key] ?? null;
    if (previous) {
      store.sessions = { ...store.sessions };
      delete store.sessions[key];
      this.writeStore(store);
    }
    return previous ? structuredClone(previous) : null;
  }

  async handleHook(request: CodexHookContextRequest): Promise<CodexHookContextResult> {
    const started = performance.now();
    const timings: NonNullable<CodexHookContextResult["timings"]> = [];
    const measure = async <T>(name: string, task: () => T | Promise<T>): Promise<T> => {
      const start = performance.now();
      const report = (phase: "started" | "completed" | "failed", durationMs?: number): void => {
        if (request.eventName !== "Stop" || !this.onHookStage) return;
        try { this.onHookStage(request, { name, phase, startMs: start - started, ...(durationMs === undefined ? {} : { durationMs }) }); }
        catch (error) { console.warn("[rabi] Stop stage diagnostic observer failed; Hook execution continues."); }
      };
      let phase: "completed" | "failed" = "completed";
      report("started");
      try { return await task(); }
      catch (error) { phase = "failed"; throw error; }
      finally {
        const durationMs = performance.now() - start;
        timings.push({ name, startMs: start - started, durationMs });
        report(phase, durationMs);
      }
    };
    const result = await this.handleMeasuredHook(request, measure);
    return { ...result, timings };
  }

  private async handleMeasuredHook(
    request: CodexHookContextRequest,
    measure: <T>(name: string, task: () => T | Promise<T>) => Promise<T>
  ): Promise<CodexHookContextResult> {
    const planRoleIds = request.eventName === "Stop" ? this.sessionPlanRoleIds(request.sessionId, request.sourceInstance, request.agentType) : undefined;
    const enabled = !this.hookEnabled || this.hookEnabled(request);
    if (request.eventName === "Stop") {
      const followup = await measure("plan-followup", () => this.planFollowup(request, planRoleIds));
      const result = await this.handleStop(request, enabled, planRoleIds, measure, followup);
      if (!result.followup && !result.completionDeferred && !result.additionalContext.trim() && result.planTaskCompletion?.status !== "failed"
        && result.agentRequestStop?.status !== "failed" && result.projectFileChangeReminder?.status !== "failed"
        && this.deliverAgentCompletion) {
        result.completionDeliveries = await measure("completion-delivery", () => this.deliverAgentCompletion!(request, planRoleIds));
      }
      return result;
    }
    if (!enabled) {
      const binding = this.getBinding(request.sessionId, request.sourceInstance, request.agentType);
      return {
        action: "none",
        binding,
        additionalContext: ""
      };
    }
    return measure("context-build", () => this.readContext ? this.queueContext(request) : this.handleContext(request));
  }

  handleContext(request: CodexHookContextRequest): CodexHookContextResult {
    const steps = this.contextSteps(request);
    let step = steps.next();
    while (!step.done) step = steps.next(readCodexHookContextInput(step.value));
    return step.value;
  }

  private queueContext(request: CodexHookContextRequest): Promise<CodexHookContextResult> {
    const sessionId = planBindingSourceKey(request);
    this.requireSessionId(request.sessionId);
    const queue = this.contextQueues.get(sessionId) ?? { tail: Promise.resolve(), pending: 0 };
    if (queue.pending >= 8 || (!queue.pending && this.contextQueues.size >= 32)) {
      return Promise.reject(new Error("Codex hook context queue is full; retry."));
    }
    queue.pending++;
    this.contextQueues.set(sessionId, queue);
    const result = queue.tail.then(() => this.handleContextAsync(request));
    queue.tail = result.then(() => undefined, () => undefined).finally(() => {
      if (--queue.pending === 0) this.contextQueues.delete(sessionId);
    });
    return result;
  }

  private async handleContextAsync(request: CodexHookContextRequest): Promise<CodexHookContextResult> {
    const steps = this.contextSteps(request);
    let step = steps.next();
    while (!step.done) {
      const bindingBefore = JSON.stringify(this.getBinding(request.sessionId, request.sourceInstance, request.agentType));
      const reply = await this.readContext!(step.value);
      if (JSON.stringify(this.getBinding(request.sessionId, request.sourceInstance, request.agentType)) !== bindingBefore) {
        throw new Error("Codex hook binding changed while context was loading; retry.");
      }
      step = steps.next(reply);
    }
    return step.value;
  }

  private *readRoleContext(roleId: string): Generator<CodexHookContextReadRequest, CodexHookRoleSource, CodexHookContextReadReply> {
    const reply = yield { kind: "role_source", rolesRoot: this.rolesRoot(), roleId };
    if (reply.kind !== "role_source") throw new Error("Invalid Codex hook role source reply.");
    return reply.source;
  }

  private *contextSteps(request: CodexHookContextRequest): Generator<CodexHookContextReadRequest, CodexHookContextResult, CodexHookContextReadReply> {
    const sessionId = this.requireSessionId(request.sessionId);
    if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(request.eventName)) {
      throw new Error(`Unsupported Codex hook event: ${request.eventName}`);
    }
    const prompt = request.eventName === "UserPromptSubmit" ? String(request.prompt || "") : "";
    const control = request.eventName === "UserPromptSubmit" ? parseCodexHookControl(prompt) : null;
    let binding = this.getBinding(sessionId, request.sourceInstance, request.agentType);
    let action: CodexHookContextResult["action"] = control?.action ?? "none";
    let forceBase = request.eventName === "SessionStart";
    let roleSource: CodexHookRoleSource | undefined;

    if (control?.action === "off") {
      this.unbindSession(sessionId, request.sourceInstance, request.agentType);
      return {
        action,
        binding: null,
        additionalContext: "[Rabi]\nRabi PC 已解除当前 Agent 会话的角色绑定。后续不得继续沿用此前注入的角色、计划、记忆或角色技能。"
      };
    }

    if (control?.action === "bind") {
      roleSource = yield* this.readRoleContext(control.roleId);
      binding = this.bindValidatedSession(sessionId, roleSource.roleId, request.sourceInstance, request.agentType);
      forceBase = true;
    }

    if (control?.action === "status") {
      return {
        action,
        binding,
        additionalContext: binding
          ? `[Rabi 绑定状态]\n当前会话角色：${binding.roleId}\n绑定由 Rabi PC Manager 管理。`
          : "[Rabi 绑定状态]\n当前会话没有绑定 Rabi 角色。"
      };
    }

    if (control?.action === "refresh") {
      if (!binding) {
        return {
          action,
          binding: null,
          additionalContext: "[Rabi]\n当前会话没有绑定 Rabi 角色，无法刷新。"
        };
      }
      roleSource = yield* this.readRoleContext(binding.roleId);
      forceBase = true;
    }

    if (request.eventName === "PostToolUse") {
      this.recordProjectFileChange(sessionId, request);
    }

    if (!binding) return { action, binding: null, additionalContext: "" };

    const role = roleSource ?? (yield* this.readRoleContext(binding.roleId));
    const { persona, growth, skills } = role;
    const baseFingerprint = fingerprint([persona, growth, skills]);
    const managerBaseUrl = normalizeManagerBaseUrl(request.managerBaseUrl);
    const turnId = String(request.turnId || "").trim() || undefined;
    const explicitRunId = request.eventName === "UserPromptSubmit" ? explicitConsolidationRunId(prompt) : undefined;
    const checkpointRunId = request.eventName !== "SessionStart" && request.eventName !== "UserPromptSubmit"
      && turnId && binding.consolidationTurnId === turnId ? binding.activeRunId : undefined;
    // A new prompt or session start never inherits a previous run. Checkpoints must
    // match both the saved turn and a freshly Manager-validated run projection.
    const resolvedScope = this.memoryConsolidationInputIds?.(
      request, role.roleId, explicitRunId ?? checkpointRunId
    );
    const dedicated = resolvedScope !== undefined || binding.consolidationInputMemoryIds !== undefined;
    // Checkpoint delivery may lag behind a newer prompt in the same reused session.
    // Never let that late event clear or overwrite the new run's scope.
    if (dedicated && request.eventName !== "SessionStart" && request.eventName !== "UserPromptSubmit"
      && (!turnId || binding.consolidationTurnId !== turnId)) {
      return { action, binding, additionalContext: "" };
    }
    const requestedRunId = explicitRunId ?? checkpointRunId;
    const verifiedRunId = requestedRunId && resolvedScope?.runId === requestedRunId
      ? requestedRunId : undefined;
    const scopedRunId = request.eventName === "SessionStart" || (request.eventName !== "UserPromptSubmit" && !turnId)
      ? undefined : verifiedRunId;
    const consolidationInputMemoryIds = dedicated
      ? scopedRunId ? [...new Set(resolvedScope?.inputMemoryIds ?? [])] : []
      : undefined;
    const includeBase = !dedicated && (forceBase || binding.baseFingerprint !== baseFingerprint);
    const sameTurn = Boolean(turnId && binding.lastTurnId === turnId && (!dedicated || binding.activeRunId === scopedRunId));
    const seenContextKeys = new Set(sameTurn ? binding.turnContextKeys ?? [] : []);
    const contextReply = yield { kind: "knowledge", trigger: {
      kind: triggerKind(request.eventName),
      source: "codex_hook",
      roleId: role.roleId,
      roleDir: role.roleDir,
      signalText: triggerSignal(request),
      sessionId,
      turnId: request.turnId,
      eventId: request.toolUseId,
      toolName: request.toolName,
      seenContextKeys: [...seenContextKeys],
      consolidationInputMemoryIds
    } };
    if (contextReply.kind !== "knowledge") throw new Error("Invalid Codex hook knowledge reply.");
    const contextResolution = contextReply.resolution;
    const isReasoningCheckpoint = contextResolution.policy.presentation === "recall_delta";
    const unseenEntries = contextResolution.entries.filter((entry) => !seenContextKeys.has(entry.key));
    const shouldRender = includeBase
      || (contextResolution.shouldInject && (!isReasoningCheckpoint || unseenEntries.length > 0));
    const visibleRequiredItems = isReasoningCheckpoint
      ? unseenEntries.flatMap((entry) => entry.item ? [entry.item] : [])
      : contextResolution.knowledge.requiredReadItems;
    const visibleItemIds = new Set(visibleRequiredItems.map((item) => `${item.type}:${item.id}`));
    const visibleKnowledge = isReasoningCheckpoint
      ? {
          ...contextResolution.knowledge,
          requiredReadItems: visibleRequiredItems,
          matchedItems: contextResolution.knowledge.matchedItems.filter((item) => visibleItemIds.has(`${item.type}:${item.id}`)),
          matchedSkills: contextResolution.knowledge.matchedSkills.filter((item) => visibleItemIds.has(`role_skill:${item.id}`))
        }
      : contextResolution.knowledge;
    const view = buildRoleKnowledgeContextView(role.roleId, visibleKnowledge);
    const focusedContext = view.mode === "focused";
    const blocks: string[] = [];

    if (dedicated) {
      const matches = visibleRequiredItems.filter((item) => item.type === "recent_memory");
      if (matches.length > 0) {
        blocks.push(section("本轮整理候选记忆", [
          `Rabi Manager API 基址：${managerBaseUrl}`,
          ...matches.map((item) => `- ${item.id}：${item.title} GET ${item.endpoint}`)
        ]));
      }
    }
    if (!dedicated && includeBase) {
      blocks.push(section("Rabi 会话角色", [
        "当前 Codex 会话已由 Rabi PC Manager 显式绑定角色。绑定只对当前 session_id 生效。",
        `角色 ID：${role.roleId}`,
        "角色、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理；Codex Hook 只是触发器和注入器。"
      ]));
      blocks.push(section(focusedContext ? "角色核心指令" : "角色工作集", [
        focusedContext
          ? `这是精简角色工作集；完整真源位于 ${path.join(role.roleDir, "persona.md")}，只有当前任务明确涉及更深边界时才按需读取。`
          : "",
        excerpt(
          persona,
          visibleKnowledge.contextInjection.personaMaxChars,
          focusedContext ? 500 : 700
        )
      ]));
      if (!focusedContext && growth) blocks.push(section("成长规则摘要", excerpt(growth, 350)));
      if (!focusedContext && skills) blocks.push(section("角色技能摘要", excerpt(skills, 350)));
      if (focusedContext && (growth || skills)) {
        blocks.push(section("角色扩展按需读取", [
          growth ? `成长规则：${path.join(role.roleDir, "growth.md")}` : "",
          skills ? `技能索引：${path.join(role.roleDir, "skills.md")}` : ""
        ]));
      }
    }

    if (!dedicated && shouldRender && (!isReasoningCheckpoint || includeBase)) {
      blocks.push(section("记忆与计划", [
        `Rabi Manager API 基址：${managerBaseUrl}`,
        ...view.apiHintLines,
        "",
        ...(focusedContext ? [] : [
          "可用技能：",
          view.activeSkillIndex,
          "",
          "当前计划：",
          view.activePlanIndex,
          "",
          "近期记忆：",
          view.recentMemoryIndex,
          "",
          "命中技能：",
          view.matchedSkillIndex,
          "",
          "命中召回：",
          view.matchedIndex
        ])
      ]));
      blocks.push(section("处理前上下文确认", [
        "下列 GET 路径均相对于上方 Rabi Manager API 基址。",
        ...view.requiredReadLines
      ]));
    } else if (!dedicated && shouldRender) {
      blocks.push(section("Rabi 推理期上下文刷新", [
        `触发点：${request.eventName}`,
        request.toolName ? `工具：${request.toolName}` : "",
        `Rabi Manager API 基址：${managerBaseUrl}`,
        "本次只注入本轮新命中的增量；角色、计划、记忆、技能及 viewedAt 仍由同一 Rabi PC Manager 管理。"
      ]));
      if (!focusedContext) blocks.push(section("推理期命中召回", [
        "命中技能：",
        view.matchedSkillIndex,
        "",
        "命中计划或记忆：",
        view.matchedIndex
      ]));
      blocks.push(section("处理前上下文确认", [
        "下列 GET 路径均相对于上方 Rabi Manager API 基址。",
        ...view.requiredReadLines
      ]));
    }

    const deliveredKeys = shouldRender
      ? [...seenContextKeys, ...contextResolution.entries.map((entry) => entry.key)].slice(-80)
      : [...seenContextKeys].slice(-80);
    const timestamp = nowIso();
    const nextBinding: CodexHookSessionBinding = {
      ...binding,
      updatedAt: timestamp,
      lastEventAt: timestamp,
      lastEventName: request.eventName,
      cwd: request.cwd || binding.cwd,
      baseFingerprint: dedicated ? binding.baseFingerprint : baseFingerprint,
      activeRunId: dedicated ? scopedRunId : undefined,
      consolidationTurnId: dedicated && scopedRunId ? turnId : undefined,
      consolidationInputMemoryIds: dedicated ? consolidationInputMemoryIds : undefined,
      lastTurnId: request.eventName === "SessionStart" ? undefined : turnId ?? binding.lastTurnId,
      turnContextKeys: request.eventName === "SessionStart" ? [] : deliveredKeys
    };
    this.replaceBinding(nextBinding);
    return {
      action,
      binding: structuredClone(nextBinding),
      additionalContext: shouldRender
        ? excerpt(blocks.filter(Boolean).join("\n\n"), MAX_CONTEXT_CHARS, 1400)
        : ""
    };
  }

  private async handleStop(request: CodexHookContextRequest, planCompletionEnabled: boolean, planRoleIds: readonly string[] | undefined,
    measure: <T>(name: string, task: () => T | Promise<T>) => Promise<T>,
    planFollowup?: CodexHookContextResult["followup"]): Promise<CodexHookContextResult> {
    let agentRequestStop = await measure("agent-request-stop", () => this.recordAgentRequestStopResult(request));
    let requestFollowup: CodexHookContextResult["followup"];
    let requestCompletionDeferred = false;
    try {
      const reminder = this.agentRequestStopFollowup(request, agentRequestStop);
      requestFollowup = reminder?.followup;
      requestCompletionDeferred = reminder?.deferCompletion === true;
    } catch (error) {
      // A failed presentation checkpoint must not loop or manufacture a reply.
      agentRequestStop = { ...agentRequestStop, status: "failed", reason: "agent_request_hook_checkpoint_failed",
        error: error instanceof Error ? error.message : String(error) };
    }
    const reasons = [planFollowup?.reason, requestFollowup?.reason].filter(Boolean);
    if (reasons.length || requestCompletionDeferred) {
      return { action: "none", binding: this.getBinding(request.sessionId, request.sourceInstance, request.agentType), additionalContext: "", completionDeferred: true,
        ...(reasons.length ? { followup: { decision: "block" as const, reason: reasons.join("\n\n") } } : {}), agentRequestStop,
        planTaskCompletion: { status: "ignored", reason: reasons.length ? "deferred_after_stop_followup" : "deferred_until_stop_continuation", turnId: request.turnId } };
    }
    // Only the final Stop may publish chat history or configured completion messages.
    await measure("chat-history", () => this.recordChatReply(request));
    const projectFileChangeReminder = await measure("file-change-reminder", () => this.handleProjectFileChangeStop(request, planRoleIds));
    if (projectFileChangeReminder.result.status === "delivered") {
      if (planCompletionEnabled) void this.handlePlanStop(request, planRoleIds).catch(() => undefined);
      return {
        action: "none",
        binding: this.getBinding(request.sessionId, request.sourceInstance, request.agentType),
        additionalContext: projectFileChangeReminder.message,
        planTaskCompletion: {
          status: "ignored",
          reason: planCompletionEnabled ? "deferred_after_project_file_change_reminder" : "hook_disabled_by_codex_endpoint",
          turnId: request.turnId
        },
        agentRequestStop,
        projectFileChangeReminder: projectFileChangeReminder.result
      };
    }
    const planResult = planCompletionEnabled
      ? await measure("plan-completion", () => this.handlePlanStop(request, planRoleIds))
      : {
          action: "none" as const,
          binding: this.getBinding(request.sessionId, request.sourceInstance, request.agentType),
          additionalContext: "",
          planTaskCompletion: {
            status: "ignored" as const,
            reason: "hook_disabled_by_codex_endpoint",
            turnId: request.turnId
          }
        };
    const additionalContext = [planResult.additionalContext, projectFileChangeReminder.message].filter(Boolean).join("\n\n");
    return {
      ...planResult,
      additionalContext,
      agentRequestStop,
      projectFileChangeReminder: projectFileChangeReminder.result
    };
  }

  private async recordChatReply(request: CodexHookContextRequest): Promise<void> {
    if (!request.turnId?.trim() || !request.lastAssistantMessage?.trim()) return;
    const sessionId = this.requireSessionId(request.sessionId);
    const binding = this.getBinding(sessionId, request.sourceInstance, request.agentType);
    if (binding?.cwd && request.cwd && normalizedWorkspace(binding.cwd) !== normalizedWorkspace(request.cwd)) return;
    const roleIds = new Set(this.chatHistoryRoleIds?.(request) ?? []);
    if (binding) roleIds.add(binding.roleId);
    // No guessed persona and no cross-persona fanout for ambiguous task ownership.
    if (roleIds.size !== 1) return;
    const role = this.requireRole([...roleIds][0]);
    const record = await appendPersonaChatReply(role.roleDir, {
      sessionId, turnId: request.turnId.trim(), text: request.lastAssistantMessage
    });
    if (record) this.onChatHistoryChanged?.(role.roleId);
  }

  private recordProjectFileChange(sessionId: string, request: CodexHookContextRequest): void {
    const turnId = String(request.turnId || "").trim();
    const candidates = filePathsFromToolInput(request.toolName, request.toolInput);
    if (!turnId || candidates.length === 0 || !successfulWriteResponse(request.toolResponse)) return;
    const workspaces = this.taskBindingWorkspaces(request);
    const files = projectRelativePaths(workspaces, request.cwd, candidates);
    const changedWorkspaces = files.length > 0 ? matchedProjectWorkspaces(workspaces, request.cwd, candidates) : [];
    if (files.length === 0) return;
    const store = this.readStore();
    const sessionKey = planBindingSourceKey(request);
    const current = store.projectFileChanges[sessionKey]?.[turnId];
    const changed = new Set(current?.files ?? []);
    const workspaceSet = new Set(current?.workspaces ?? []);
    files.forEach((file) => changed.add(file));
    changedWorkspaces.forEach((workspace) => workspaceSet.add(workspace));
    store.projectFileChanges = { ...store.projectFileChanges, [sessionKey]: retainNewest({
      ...store.projectFileChanges[sessionKey],
      [turnId]: { files: [...changed].sort((left, right) => left.localeCompare(right)), workspaces: [...workspaceSet].sort((left, right) => left.localeCompare(right)) }
    }, 64) };
    this.writeStore(store);
  }

  private async handleProjectFileChangeStop(request: CodexHookContextRequest, planRoleIds?: readonly string[]): Promise<{ result: ProjectFileChangeReminderResult; message: string }> {
    const sessionId = this.requireSessionId(request.sessionId);
    const turnId = String(request.turnId || "").trim();
    const store = this.readStore();
    const sessionKey = planBindingSourceKey(request);
    const state = turnId ? store.projectFileChanges[sessionKey]?.[turnId] : undefined;
    const files = [...(state?.files ?? [])];
    const changedWorkspaces = state?.workspaces ?? [];
    if (!turnId) return { result: { status: "failed", reason: "missing_turn_id", error: "Project file changes cannot be associated with a Stop turn." }, message: "" };
    if (store.projectFileChangeReminders[sessionKey]?.[turnId]) {
      return { result: { status: "ignored", reason: "turn_already_reminded", turnId, files }, message: "" };
    }
    if (files.length === 0) return { result: { status: "ignored", reason: "no_confirmed_project_file_change", turnId }, message: "" };
    const matches = (planRoleIds ?? this.listRoles()).flatMap((roleId) => {
      const role = this.requireRole(roleId);
      return this.listPlansOrCold(role.roleDir)
        .filter((plan) => planBindingMatchesSource(plan.taskBinding, request)
          && changedWorkspaces.includes(normalizedWorkspace(plan.taskBinding?.workspace)))
        .map((plan) => ({ ...role, plan }));
    });
    if (matches.length === 0) return { result: { status: "ignored", reason: "no_matching_plan_task_binding", turnId, files }, message: "" };
    const plans = matches.map((match) => match.plan);
    const reminders = retainNewest({ ...store.projectFileChangeReminders[sessionKey], [turnId]: nowIso() }, 64);
    store.projectFileChangeReminders = { ...store.projectFileChangeReminders, [sessionKey]: reminders };
    const remainingChanges = { ...store.projectFileChanges[sessionKey] };
    delete remainingChanges[turnId];
    store.projectFileChanges = { ...store.projectFileChanges, [sessionKey]: remainingChanges };
    this.writeStore(store);
    return {
      result: { status: "delivered", reason: "project_file_changes_detected", planId: plans[0]?.id, planIds: plans.map((plan) => plan.id), turnId, files },
      message: [
        "[Rabi 计划检查提醒]",
        `本轮已修改项目文件：${files.join("、")}。`,
        `请检查绑定计划${plans.map((plan) => `“${plan.title}”`).join("、")}的 status、currentStep、steps、证据和附件是否需要按实际进展更新。`,
        "本提醒不会自动修改计划。"
      ].join("\n")
    };
  }

  private taskBindingWorkspaces(request: CodexHookContextRequest): string[] {
    return [...new Set((this.sessionPlanRoleIds(request.sessionId, request.sourceInstance, request.agentType) ?? this.listRoles()).flatMap((roleId) => {
      const role = this.requireRole(roleId);
      return this.listPlansOrCold(role.roleDir)
        .filter((plan) => planBindingMatchesSource(plan.taskBinding, request))
        .map((plan) => String(plan.taskBinding?.workspace || "").trim())
        .filter(Boolean);
    }))];
  }

  private agentRequestStopFollowup(request: CodexHookContextRequest, result: AgentRequestStopResult): { followup?: CodexHookContextResult["followup"]; deferCompletion: boolean } | undefined {
    if (!request.turnId) return undefined;
    this.requireSessionId(request.sessionId);
    const sessionId = planBindingSourceKey(request);
    const store = this.readStore();
    const deferCompletion = !request.stopHookActive && store.agentRequestStopFollowupTurns?.[sessionId] === request.turnId;
    // A failed/partial current read cannot erase this turn's already-published continuation boundary.
    if (result.turnId !== request.turnId || result.status === "failed") return { deferCompletion };
    const complete = result.snapshotComplete === true && Array.isArray(result.pendingSessionRequestIds);
    if (result.status !== "recorded" && result.status !== "pending" && !complete) return { deferCompletion };
    const requestIds = [...new Set(result.requestIds ?? [])];
    const pending = new Set(complete ? result.pendingSessionRequestIds : requestIds);
    const previous = store.agentRequestStopReminders?.[sessionId];
    const oldIds: string[] = Array.isArray(previous) ? previous : [];
    // Prune display facts only with a complete owner snapshot, never on a failed or partial read.
    const retained = complete ? oldIds.filter(id => pending.has(id)) : oldIds;
    const shown = new Set(retained);
    const fresh = request.stopHookActive ? [] : requestIds.filter(id => !shown.has(id));
    if (fresh.length || retained.length !== oldIds.length) {
      const reminders = { ...store.agentRequestStopReminders };
      const next = [...shown, ...fresh];
      if (next.length) reminders[sessionId] = next;
      else delete reminders[sessionId];
      store.agentRequestStopReminders = reminders;
      if (fresh.length) store.agentRequestStopFollowupTurns = { ...store.agentRequestStopFollowupTurns, [sessionId]: request.turnId };
      // At-most-once presentation attempt, not evidence of delivery or response.
      this.writeStore(store);
    }
    if (!fresh.length) return { deferCompletion: !request.stopHookActive
      && store.agentRequestStopFollowupTurns?.[sessionId] === request.turnId };
    const listed = fresh.slice(0, 8).map(id => "GET /api/agent/requests/" + encodeURIComponent(id));
    return { deferCompletion: true, followup: { decision: "block", reason: [
      "[Rabi 待回复请求检查]",
      "当前会话有" + fresh.length + "个尚未正式回传的原请求；本次列出前" + listed.length + "项：",
      ...listed,
      "其余项仍在原待回复请求列表中，按当前完整会话 ID 筛选读取。",
      "结束前核对原请求，按原回传参数报告实际结果和下一步。已回传但结果待确认时，只核对原回执，不重发正文或换编号。",
      "本提示只在当前 Stop 钩子中对每个原请求出现一次，不发送提醒消息，不定时唤醒会话，也不代写已回复或已接收状态。"
    ].join("\n") } };
  }

  private async recordAgentRequestStopResult(request: CodexHookContextRequest): Promise<AgentRequestStopResult> {
    if (!this.recordAgentRequestStop) {
      return { status: "ignored", reason: "agent_request_stop_not_configured", turnId: request.turnId };
    }
    try {
      return await this.recordAgentRequestStop(request);
    } catch (error) {
      return {
        status: "failed",
        reason: "agent_request_stop_failed",
        turnId: request.turnId,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private planFollowup(request: CodexHookContextRequest, planRoleIds?: readonly string[]): CodexHookContextResult["followup"] {
    if (request.stopHookActive || !request.turnId) return undefined;
    const matches = (planRoleIds ?? this.listRoles()).flatMap(roleId => {
      const role = this.requireRole(roleId);
      return this.listPlansOrCold(role.roleDir).filter(plan => planBindingMatchesSource(plan.taskBinding, request)
        && plan.archiveStatus !== "已归档")
        .map(plan => ({ ...role, plan }));
    });
    if (matches.length !== 1) return undefined;
    const { roleId, roleDir, plan } = matches[0];
    const config = agentHookSettingsFor(readPersonaConfigFragment(path.join(roleDir, "personaConfig.json")).codexHooks, request.agentType).planFollowup;
    if (!config?.enabled) return undefined;
    const workflow = ensurePersonaPlanWorkflow(roleDir).workflow;
    const store = this.readStore();
    const sourceIdentity = planBindingDeliveryIdentity(request);
    const key = typeof sourceIdentity === "string" ? fingerprint([roleId, plan.id, sourceIdentity])
      : crypto.createHash("sha256").update(JSON.stringify([roleId, plan.id, sourceIdentity])).digest("hex");
    const result = decidePlanFollowup({ config, workflow, plan, sessionId: request.sessionId,
      turnId: request.turnId, stopHookActive: request.stopHookActive,
      previous: store.planFollowups?.[key], now: Date.now() });
    if (!result) return undefined;
    store.planFollowups = { ...store.planFollowups, [key]: result.receipt };
    this.writeStore(store);
    return { decision: "block", reason: result.reason };
  }

  private async handlePlanStop(request: CodexHookContextRequest, planRoleIds?: readonly string[]): Promise<CodexHookContextResult> {
    const sessionId = this.requireSessionId(request.sessionId);
    const binding = this.getBinding(sessionId, request.sourceInstance, request.agentType);
    const matches = (planRoleIds ?? this.listRoles()).flatMap((roleId) => {
      const role = this.requireRole(roleId);
      const plans = this.listPlansOrCold(role.roleDir).filter(plan => (
        planBindingMatchesSource(plan.taskBinding, request) && plan.taskBinding?.completionHook?.enabled === true
      ));
      if (plans.length === 0) return [];
      const workflow = ensurePersonaPlanWorkflow(role.roleDir).workflow;
      return plans
        .filter((plan) => (
          planCanAutoAdvance(plan, workflow)
          && (planStatusDefinition(workflow, plan.status)?.views.includes("current") === true)
        ))
        .map((plan) => ({ ...role, plan }));
    });
    if (matches.length === 0) {
      return {
        action: "none",
        binding,
        additionalContext: "",
        planTaskCompletion: { status: "ignored", reason: "no_enabled_plan_task_binding", turnId: request.turnId }
      };
    }
    if (matches.length > 1) {
      return this.recordPlanCompletion(binding, undefined, request, {
        status: "failed",
        reason: "multiple_plan_task_bindings",
        turnId: request.turnId,
        error: `Codex session ${sessionId} is bound to multiple plans: ${matches.map((match) => `${match.roleId}/${match.plan.id}`).join(", ")}`
      });
    }

    const { roleId, roleDir, plan } = matches[0];
    const turnId = String(request.turnId || "").trim();
    const finalMessage = String(request.lastAssistantMessage || "").trim();
    const gatewayId = plan.taskBinding?.completionHook?.gatewayId;
    if (binding && binding.roleId !== roleId) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "role_binding_mismatch",
        planId: plan.id,
        turnId,
        gatewayId,
        error: `Codex session ${sessionId} is context-bound to role ${binding.roleId}, but its plan task belongs to role ${roleId}.`
      });
    }
    if (!turnId) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "missing_turn_id",
        planId: plan.id,
        gatewayId,
        error: "Codex Stop hook did not provide turn_id; completion delivery was not attempted."
      });
    }
    const completionState = Object.values(this.readStore().planTaskCompletions)
      .find((state) => (
        planBindingSourceKey(state) === planBindingSourceKey(request)
        && state.planId === plan.id
        && state.turnId === turnId
        && state.status !== "ignored"
      ));
    if (completionState) {
      return {
        action: "none",
        binding,
        additionalContext: "",
        planTaskCompletion: {
          status: "duplicate",
          reason: "turn_already_processed",
          planId: plan.id,
          turnId,
          gatewayId
        }
      };
    }
    if (!finalMessage) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "ignored",
        reason: "missing_final_message",
        planId: plan.id,
        turnId,
        gatewayId
      });
    }

    const expectedWorkspace = normalizedWorkspace(plan.taskBinding?.workspace);
    const actualWorkspace = normalizedWorkspace(request.cwd);
    if (expectedWorkspace && actualWorkspace && expectedWorkspace !== actualWorkspace) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "workspace_mismatch",
        planId: plan.id,
        turnId,
        gatewayId,
        error: `Plan task workspace does not match the Stop hook cwd: ${plan.taskBinding?.workspace} != ${request.cwd}`
      });
    }
    if (!this.deliverPlanTaskCompletion) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "delivery_unavailable",
        planId: plan.id,
        turnId,
        gatewayId,
        error: "Rabi plan task completion delivery is not configured."
      });
    }

    try {
      await this.deliverPlanTaskCompletion({
        roleId,
        roleDir,
        plan,
        sourceSessionId: sessionId,
        sourceAgentType: request.agentType,
        ...(request.sourceInstance ? { sourceInstance: request.sourceInstance } : {}),
        ...(request.trustedRemoteSource ? { trustedRemoteSource: request.trustedRemoteSource } : {}),
        sourceTurnId: turnId,
        sourceCwd: request.cwd,
        finalMessage: excerpt(finalMessage, 12_000, 4_000),
        gatewayId
      });
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "delivered",
        reason: request.stopHookActive ? "stop_continuation_completed" : "stop_completed",
        planId: plan.id,
        turnId,
        gatewayId
      });
    } catch (error) {
      return this.recordPlanCompletion(binding, roleId, request, {
        status: "failed",
        reason: "delivery_failed",
        planId: plan.id,
        turnId,
        gatewayId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private recordPlanCompletion(
    binding: CodexHookSessionBinding | null,
    roleId: string | undefined,
    request: CodexHookContextRequest,
    result: PlanTaskCompletionResult
  ): CodexHookContextResult {
    const timestamp = nowIso();
    const sessionId = this.requireSessionId(request.sessionId);
    const store = this.readStore();
    const nextBinding: CodexHookSessionBinding | null = binding
      ? {
          ...binding,
          updatedAt: timestamp,
          lastEventAt: timestamp,
          lastEventName: "Stop",
          cwd: request.cwd || binding.cwd,
          lastPlanCompletionPlanId: result.planId ?? binding.lastPlanCompletionPlanId,
          lastPlanCompletionTurnId: result.turnId ?? binding.lastPlanCompletionTurnId,
          lastPlanCompletionAt: timestamp,
          lastPlanCompletionStatus: result.status,
          lastPlanCompletionError: result.error
        }
      : null;
    if (nextBinding) store.sessions = { ...store.sessions, [planBindingSourceKey(nextBinding)]: nextBinding };
    const completionKey = planTaskCompletionKey(planBindingDeliveryIdentity(request), result.planId, result.turnId);
    store.planTaskCompletions = { ...store.planTaskCompletions, [completionKey]: {
      sessionId,
      ...(request.sourceInstance ? { sourceInstance: request.sourceInstance, agentType: request.agentType || "codex" } : {}),
      roleId,
      planId: result.planId,
      turnId: result.turnId,
      updatedAt: timestamp,
      status: result.status,
      gatewayId: result.gatewayId,
      error: result.error
    } };
    this.writeStore(store);
    return { action: "none", binding: nextBinding ? structuredClone(nextBinding) : null, additionalContext: "", planTaskCompletion: result };
  }

  doctor(): Record<string, unknown> {
    const rolesRoot = path.resolve(this.rolesRoot());
    return {
      ok: true,
      rolesRoot,
      rolesRootAvailable: fs.existsSync(rolesRoot),
      roleIds: fs.existsSync(rolesRoot) ? this.listRoles() : [],
      storePath: this.storePath,
      bindings: this.listBindings().map(({ sessionId, roleId, updatedAt }) => ({ sessionId, roleId, updatedAt })),
      planTaskCompletions: Object.values(this.readStore().planTaskCompletions).map(state => structuredClone(state))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    };
  }

  private requireSessionId(sessionId: string): string {
    const id = String(sessionId || "").trim();
    if (!id || id.length > 240) throw new Error("A real Codex session ID is required.");
    return id;
  }

  private requireRole(roleId: string): { roleId: string; roleDir: string } {
    const safeRoleId = sanitizeRoleId(roleId);
    if (!safeRoleId) throw new Error("Rabi role ID is invalid.");
    const roleDir = roleFolderPath(this.rolesRoot(), safeRoleId);
    if (!fs.existsSync(path.join(roleDir, "persona.md"))) {
      throw new Error(`Rabi role not found: ${safeRoleId}`);
    }
    return { roleId: safeRoleId, roleDir };
  }

  private readStore(): CodexHookSessionStoreFile {
    let revision: string;
    try { revision = hookStoreRevision(fs.statSync(this.storePath)); }
    catch (error) {
      this.storeSnapshot = undefined;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const empty: CodexHookSessionStoreFile = { version: STORE_VERSION, sessions: {}, planTaskCompletions: {}, projectFileChanges: {}, projectFileChangeReminders: {} };
      this.writeStore(empty);
      return { ...empty };
    }
    if (this.storeSnapshot?.revision === revision) return { ...this.storeSnapshot.value };
    this.storeSnapshot = undefined;
    const original = fs.readFileSync(this.storePath);
    const raw = JSON.parse(original.toString("utf8")) as Partial<CodexHookSessionStoreFile>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Hook state is not an object; the original file is preserved.");
    const value = migrateHookSessionKeys({
      ...raw,
      version: Number.isInteger(raw.version) ? raw.version! : 8,
      planFollowups: raw.planFollowups ?? {},
      agentRequestStopReminders: raw.agentRequestStopReminders ?? {},
      agentRequestStopFollowupTurns: raw.agentRequestStopFollowupTurns ?? {},
      sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
      planTaskCompletions: raw.planTaskCompletions && typeof raw.planTaskCompletions === "object" ? raw.planTaskCompletions : {},
      projectFileChanges: raw.projectFileChanges && typeof raw.projectFileChanges === "object" ? raw.projectFileChanges : {},
      projectFileChangeReminders: raw.projectFileChangeReminders && typeof raw.projectFileChangeReminders === "object" ? raw.projectFileChangeReminders : {}
    });
    if (hookStoreRevision(fs.statSync(this.storePath)) === revision) {
      freezeHookStore(value);
      this.storeSnapshot = { revision, value, ...(!Number.isInteger(raw.version) || raw.version! < STORE_VERSION ? { legacyRaw: original } : {}) };
    }
    return { ...value };
  }

  private writeStore(store: CodexHookSessionStoreFile): void {
    if (fs.existsSync(this.storePath)) {
      const revision = hookStoreRevision(fs.statSync(this.storePath));
      // A draft never becomes the cache before the existing atomic publication succeeds.
      if (this.storeSnapshot?.revision !== revision) this.readStore();
      const original = this.storeSnapshot?.legacyRaw;
      if (original) {
        const directory = this.storePath + ".recovery";
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const hash = crypto.createHash("sha256").update(original).digest("hex");
        const destination = path.join(directory, `layout-9-${hash}-${crypto.randomUUID()}.raw`);
        const staging = destination + ".tmp";
        try {
          const fd = fs.openSync(staging, "wx", 0o600);
          try { fs.writeFileSync(fd, original); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          if (!fs.readFileSync(staging).equals(original)) throw new Error("Hook migration recovery snapshot verification failed.");
          fs.renameSync(staging, destination);
        } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
      }
    }
    const published = {
      ...store,
      version: Math.max(store.version || STORE_VERSION, STORE_VERSION),
      planFollowups: store.planFollowups ?? {},
      agentRequestStopReminders: store.agentRequestStopReminders ?? {},
      agentRequestStopFollowupTurns: store.agentRequestStopFollowupTurns ?? {},
      sessions: store.sessions,
      planTaskCompletions: store.planTaskCompletions,
      projectFileChanges: store.projectFileChanges,
      projectFileChangeReminders: store.projectFileChangeReminders
    };
    try {
      writeJsonAtomic(this.storePath, published);
      freezeHookStore(published);
      this.storeSnapshot = { revision: hookStoreRevision(fs.statSync(this.storePath)), value: published };
    } catch (error) {
      this.storeSnapshot = undefined;
      throw error;
    }
  }

  private replaceBinding(binding: CodexHookSessionBinding): void {
    const store = this.readStore();
    store.sessions = { ...store.sessions, [planBindingSourceKey(binding)]: binding };
    this.writeStore(store);
  }
}
