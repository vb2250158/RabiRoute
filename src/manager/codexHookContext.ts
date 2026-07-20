import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rabiContextManager, type RabiContextTriggerKind } from "../context/rabiContextManager.js";
import { buildRoleKnowledgeContextView } from "../routing/roleKnowledgeContext.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";

const STORE_VERSION = 2;
const MAX_CONTEXT_CHARS = 6200;
const CONTROL_PATTERN = /\[rabi:(use|bind)\s+([^\]\r\n]{1,80})\]|\[rabi:(status|refresh|off)\]/i;

export type CodexHookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

export type CodexHookSessionBinding = {
  sessionId: string;
  roleId: string;
  createdAt: string;
  updatedAt: string;
  lastEventAt?: string;
  lastEventName?: CodexHookEventName;
  cwd?: string;
  baseFingerprint?: string;
  lastTurnId?: string;
  turnContextKeys?: string[];
};

type CodexHookSessionStoreFile = {
  version: number;
  sessions: Record<string, CodexHookSessionBinding>;
};

export type CodexHookContextRequest = {
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
};

export type CodexHookContextResult = {
  action: "none" | "bind" | "status" | "refresh" | "off";
  binding: CodexHookSessionBinding | null;
  additionalContext: string;
};

export type CodexHookControl =
  | { action: "bind"; roleId: string }
  | { action: "status" | "refresh" | "off" };

export type CodexHookContextServiceOptions = {
  rolesRoot: () => string;
  storePath: string;
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
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function normalizeManagerBaseUrl(value: string | undefined): string {
  return String(value || "http://127.0.0.1:8790").trim().replace(/\/+$/, "");
}

function fingerprint(values: string[]): string {
  return crypto.createHash("sha256").update(values.join("\0")).digest("hex");
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

export class CodexHookContextService {
  private readonly rolesRoot: () => string;
  private readonly storePath: string;

  constructor(options: CodexHookContextServiceOptions) {
    this.rolesRoot = options.rolesRoot;
    this.storePath = path.resolve(options.storePath);
  }

  listRoles(): string[] {
    const root = path.resolve(this.rolesRoot());
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && Boolean(sanitizeRoleId(entry.name)))
      .filter((entry) => fs.existsSync(path.join(root, entry.name, "persona.md")))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  listBindings(): CodexHookSessionBinding[] {
    return Object.values(this.readStore().sessions)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getBinding(sessionId: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    return this.readStore().sessions[id] ?? null;
  }

  bindSession(sessionId: string, roleId: string): CodexHookSessionBinding {
    const id = this.requireSessionId(sessionId);
    const role = this.requireRole(roleId);
    const store = this.readStore();
    const previous = store.sessions[id];
    const timestamp = nowIso();
    const binding: CodexHookSessionBinding = {
      sessionId: id,
      roleId: role.roleId,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    store.sessions[id] = binding;
    this.writeStore(store);
    return binding;
  }

  unbindSession(sessionId: string): CodexHookSessionBinding | null {
    const id = this.requireSessionId(sessionId);
    const store = this.readStore();
    const previous = store.sessions[id] ?? null;
    if (previous) {
      delete store.sessions[id];
      this.writeStore(store);
    }
    return previous;
  }

  handleContext(request: CodexHookContextRequest): CodexHookContextResult {
    const sessionId = this.requireSessionId(request.sessionId);
    if (!["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].includes(request.eventName)) {
      throw new Error(`Unsupported Codex hook event: ${request.eventName}`);
    }
    const prompt = request.eventName === "UserPromptSubmit" ? String(request.prompt || "") : "";
    const control = request.eventName === "UserPromptSubmit" ? parseCodexHookControl(prompt) : null;
    let binding = this.getBinding(sessionId);
    let action: CodexHookContextResult["action"] = control?.action ?? "none";
    let forceBase = request.eventName === "SessionStart";

    if (control?.action === "off") {
      this.unbindSession(sessionId);
      return {
        action,
        binding: null,
        additionalContext: "[Rabi Codex]\nRabi PC 已解除当前 Codex 会话的人格绑定。后续不得继续沿用此前注入的人格、计划、记忆或角色技能。"
      };
    }

    if (control?.action === "bind") {
      binding = this.bindSession(sessionId, control.roleId);
      forceBase = true;
    }

    if (control?.action === "status") {
      return {
        action,
        binding,
        additionalContext: binding
          ? `[Rabi Codex 绑定状态]\n当前会话人格：${binding.roleId}\n绑定由 Rabi PC Manager 管理。`
          : "[Rabi Codex 绑定状态]\n当前会话没有绑定 Rabi 人格。"
      };
    }

    if (control?.action === "refresh") {
      if (!binding) {
        return {
          action,
          binding: null,
          additionalContext: "[Rabi Codex]\n当前会话没有绑定 Rabi 人格，无法刷新。"
        };
      }
      this.requireRole(binding.roleId);
      forceBase = true;
    }

    if (!binding) return { action, binding: null, additionalContext: "" };

    const role = this.requireRole(binding.roleId);
    const persona = readText(path.join(role.roleDir, "persona.md"));
    const growth = readText(path.join(role.roleDir, "growth.md"));
    const skills = readText(path.join(role.roleDir, "skills.md"));
    const baseFingerprint = fingerprint([persona, growth, skills]);
    const includeBase = forceBase || binding.baseFingerprint !== baseFingerprint;
    const managerBaseUrl = normalizeManagerBaseUrl(request.managerBaseUrl);
    const turnId = String(request.turnId || "").trim() || undefined;
    const sameTurn = Boolean(turnId && binding.lastTurnId === turnId);
    const seenContextKeys = new Set(sameTurn ? binding.turnContextKeys ?? [] : []);
    const contextResolution = rabiContextManager.resolve({
      kind: triggerKind(request.eventName),
      source: "codex_hook",
      roleId: role.roleId,
      roleDir: role.roleDir,
      signalText: triggerSignal(request),
      sessionId,
      turnId: request.turnId,
      eventId: request.toolUseId,
      toolName: request.toolName,
      seenContextKeys: [...seenContextKeys]
    });
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
    const blocks: string[] = [];

    if (includeBase) {
      blocks.push(section("Rabi Codex 会话人格", [
        "当前 Codex 会话已由 Rabi PC Manager 显式绑定人格。绑定只对当前 session_id 生效。",
        `角色 ID：${role.roleId}`,
        `Rabi Manager：${managerBaseUrl}`,
        "人格、计划、记忆、技能、召回、viewedAt、归档与整理均由 Rabi PC 管理；Codex Hook 只是触发器和注入器。"
      ]));
      blocks.push(section("人格工作集", excerpt(persona, 3200, 700)));
      if (growth) blocks.push(section("成长规则摘要", excerpt(growth, 350)));
      if (skills) blocks.push(section("角色技能摘要", excerpt(skills, 350)));
    }

    if (shouldRender && (!isReasoningCheckpoint || includeBase)) {
      blocks.push(section("记忆与计划", [
        `Rabi Manager API 基址：${managerBaseUrl}`,
        ...view.apiHintLines,
        "",
        "可用技能：",
        view.activeSkillIndex,
        "",
        "进行中计划：",
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
      ]));
      blocks.push(section("处理前上下文确认", [
        "下列 GET 路径均相对于上方 Rabi Manager API 基址。",
        ...view.requiredReadLines
      ]));
    } else if (shouldRender) {
      blocks.push(section("Rabi 推理期上下文刷新", [
        `触发点：${request.eventName}`,
        request.toolName ? `工具：${request.toolName}` : "",
        `Rabi Manager API 基址：${managerBaseUrl}`,
        "本次只注入本轮新命中的增量；人格、计划、记忆、技能及 viewedAt 仍由同一 Rabi PC Manager 管理。"
      ]));
      blocks.push(section("推理期命中召回", [
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
      baseFingerprint,
      lastTurnId: request.eventName === "SessionStart" ? undefined : turnId ?? binding.lastTurnId,
      turnContextKeys: request.eventName === "SessionStart" ? [] : deliveredKeys
    };
    this.replaceBinding(nextBinding);
    return {
      action,
      binding: nextBinding,
      additionalContext: shouldRender
        ? excerpt(blocks.filter(Boolean).join("\n\n"), MAX_CONTEXT_CHARS, 1400)
        : ""
    };
  }

  doctor(): Record<string, unknown> {
    const rolesRoot = path.resolve(this.rolesRoot());
    return {
      ok: true,
      rolesRoot,
      rolesRootAvailable: fs.existsSync(rolesRoot),
      roleIds: fs.existsSync(rolesRoot) ? this.listRoles() : [],
      storePath: this.storePath,
      bindings: this.listBindings().map(({ sessionId, roleId, updatedAt }) => ({ sessionId, roleId, updatedAt }))
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
    if (!fs.existsSync(this.storePath)) {
      const empty: CodexHookSessionStoreFile = { version: STORE_VERSION, sessions: {} };
      this.writeStore(empty);
      return empty;
    }
    const raw = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<CodexHookSessionStoreFile>;
    return {
      version: STORE_VERSION,
      sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {}
    };
  }

  private writeStore(store: CodexHookSessionStoreFile): void {
    writeJsonAtomic(this.storePath, { version: STORE_VERSION, sessions: store.sessions });
  }

  private replaceBinding(binding: CodexHookSessionBinding): void {
    const store = this.readStore();
    store.sessions[binding.sessionId] = binding;
    this.writeStore(store);
  }
}
