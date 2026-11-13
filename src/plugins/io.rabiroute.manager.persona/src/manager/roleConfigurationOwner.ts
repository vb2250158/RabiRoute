import fs from "node:fs/promises";
import { readRoleDocument, atomicRoleDocument, assertRoleDocumentQuota } from "./roleDocumentStorage.js";
import { personaReadSettings } from "@rabiroute/host-api/shared/personaReadSettings";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";
import { personaMarkdownTitle } from "./personaCatalog.js";
import { sanitizeRoleId } from "@rabiroute/host-api/shared/routeIdentity";
import { roleFolderPath } from "@rabiroute/host-api/shared/routePaths";
import { ROLE_CONFIGURATION_KEYS, roleConfigurationOf, type RoleConfiguration } from "@rabiroute/host-api/shared/roleConfiguration";
import { ensureDefaultPersonaAutomations, normalizeDailyScheduleTimes, type GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { normalizeAgentDeliveryTarget, validateAgentDeliveryTarget } from "@rabiroute/host-api/shared/agentDeliveryTarget";
import { recordDataMutationAudit } from "@rabiroute/host-api/observability/dataMutationAudit";
import {
  RoleLifecycleError, readRoleMetadata, roleWorkCount, roleStateRoot, withRoleLock,
  checkedRoleDirectory, atomicRoleJson, assertRoleAcceptsWork
} from "@rabiroute/host-api/roleLifecycle";

export type RoleConfigurationContext = {
  rolesRoot(): string;
  identity(): PersonaResourceIdentity;
  routes(): readonly GatewayDefinition[];
  presentation?: (roleId: string) => { avatarConfigured: boolean; avatarVersion?: string } | undefined;
  assertCatalogReady(): void;
  isReadOnly?: () => boolean;
  /** Async catalog refresh must call assertCurrent before publishing its synchronous change event. */
  changed(roleId: string, assertCurrent: () => void): Promise<void>;
};
export type RoleConfigurationCommand = { expectedRevision: string; confirmationId?: string; roleId?: string; title?: string; document?: string; config?: RoleConfiguration & Record<string, unknown>; requestCommand?: unknown };
type Context = Omit<RoleConfigurationContext, "rolesRoot"> & {
  rolesRoot: string;
  assertCurrent(): void;
  step<T>(action: () => Promise<T>): Promise<T>;
  write<T>(action: () => Promise<T>): Promise<T>;
  retainPendingOutcome(): void;
};
type Command = RoleConfigurationCommand;

async function optionalJson(file: string, maxBytes = 0): Promise<Record<string, unknown>> {
  try {
    const handle = await fs.open(file, "r");
    try {
      if (maxBytes > 0 && (await handle.stat()).size > maxBytes) throw new RoleLifecycleError("ROLE_CONFIG_TOO_LARGE", `RABIROUTE_PERSONA_CONFIG_MAX_BYTES=${maxBytes} exceeded; increase this Manager setting or set 0 to remove the application quota.`, 413);
      const result: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid configuration");
      return result as Record<string, unknown>;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}

async function roleRevision(directory: string): Promise<string> {
  const [metadata, config] = await Promise.all([readRoleMetadata(directory), optionalJson(path.join(directory, "personaConfig.json"), personaReadSettings.configBytes)]);
  return createHash("sha256").update(JSON.stringify([metadata, config])).digest("hex");
}

function validateDocument(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new RoleLifecycleError("ROLE_DOCUMENT_REQUIRED", "请提供角色正文。", 400);
  assertRoleDocumentQuota(Buffer.byteLength(value));
}

async function documentDetail(context: Context, roleId: string) {
  const directory = await checkedConfigurationDirectory(context, roleId);
  const [document, personaConfig, metadata] = await context.step(() => Promise.all([
    readRoleDocument(directory), optionalJson(path.join(directory, "personaConfig.json"), personaReadSettings.configBytes), readRoleMetadata(directory)
  ]));
  const configurationRevision = createHash("sha256").update(JSON.stringify([metadata, personaConfig])).digest("hex");
  const revision = createHash("sha256").update(JSON.stringify([metadata, personaConfig, document])).digest("hex");
  return { roleId, document, personaConfig, revision, configurationRevision };
}

function hasRoleReference(value: unknown, roleId: string): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    (["roleId", "personaId", "agentRoleId", "targetRoleId", "targetPersonaId"].includes(key) && item === roleId)
    || hasRoleReference(item, roleId));
}

async function roleReferences(context: Context, roleId: string): Promise<string[]> {
  context.assertCatalogReady();
  const references = context.routes().filter(route => !route.agentRoleDeviceId && route.agentRoleId === roleId)
    .map(route => `路由：${route.routeName || route.name || route.id} (${route.id})`);
  const entries = await context.step(() => fs.readdir(context.rolesRoot, { withFileTypes: true }));
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === roleId || !sanitizeRoleId(entry.name)) continue;
    if (hasRoleReference(await context.step(() => optionalJson(path.join(roleFolderPath(context.rolesRoot, entry.name), "personaConfig.json"), personaReadSettings.configBytes)), roleId)) {
      references.push(`角色自动化：${entry.name}`);
    }
  }
  return references;
}

async function checkedConfigurationDirectory(context: Context, roleId: string): Promise<string> {
  return context.step(async () => {
    try { return await checkedRoleDirectory(context.rolesRoot, roleId); }
    catch (error) {
      context.assertCurrent();
      const cause = error as NodeJS.ErrnoException;
      if (cause.code === "ENOENT" && typeof cause.path === "string"
        && path.resolve(cause.path) === roleFolderPath(context.rolesRoot, roleId)) {
        // Missing storage is an operational failure, distinct from an absent selected role.
        await context.step(() => fs.realpath(context.rolesRoot));
        throw new RoleLifecycleError("ROLE_NOT_FOUND", "角色不存在。", 404);
      }
      throw error;
    }
  });
}

async function detail(context: Context, roleId: string) {
  const directory = await checkedConfigurationDirectory(context, roleId);
  const [metadata, config, revision, runningWork] = await context.step(() => Promise.all([
    readRoleMetadata(directory), optionalJson(path.join(directory, "personaConfig.json"), personaReadSettings.configBytes), roleRevision(directory), roleWorkCount(directory)
  ]));
  return { roleId, ...metadata, revision, config: roleConfigurationOf(config), personaConfig: config, runningWork,
    rolePath: path.join(directory, "persona.md"), roleDir: directory,
    routes: context.routes().filter(route => !route.agentRoleDeviceId && route.agentRoleId === roleId).map(route => ({ id: route.id, name: route.routeName || route.name || route.id })) };
}

async function list(context: Context, url: URL) {
  const archived = url.searchParams.get("scope") === "archived";
  const query = (url.searchParams.get("query") || "").toLocaleLowerCase();
  const cursor = url.searchParams.get("cursor") || "";
  const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit")) || 25));
  const entries = (await context.step(() => fs.readdir(context.rolesRoot, { withFileTypes: true })))
    .filter(entry => entry.isDirectory() && sanitizeRoleId(entry.name)).map(entry => entry.name).sort();
  const roles: Array<Record<string, unknown>> = [];
  let last = cursor;
  let examined = 0;
  const candidates = entries.filter(id => id > cursor);
  const readEntry = async (roleId: string): Promise<Record<string, unknown> | null> => {
    try {
      const directory = await context.step(() => checkedRoleDirectory(context.rolesRoot, roleId));
      const metadata = await context.step(() => readRoleMetadata(directory));
      if (Boolean(metadata.archivedAt) !== archived) return null;
      let title = "";
      try {
        const handle = await fs.open(path.join(directory, "persona.md"), "r");
        try { const buffer = Buffer.alloc(8192); const read = await handle.read(buffer, 0, buffer.length, 0); title = personaMarkdownTitle(buffer.toString("utf8", 0, read.bytesRead)); }
        finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      context.assertCurrent();
      if (query && !`${title} ${roleId}`.toLocaleLowerCase().includes(query)) return null;
      const presentation = context.presentation?.(roleId);
      return { roleId, title: title || roleId, archivedAt: metadata.archivedAt,
        avatarConfigured: presentation?.avatarConfigured === true,
        avatarUrl: `/api/roles/${encodeURIComponent(roleId)}/avatar${presentation?.avatarVersion ? `?v=${encodeURIComponent(presentation.avatarVersion)}` : ""}`, error: "" };
    } catch (error) {
      context.assertCurrent();
      return { roleId, title: roleId, archivedAt: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  while (examined < candidates.length && examined < 200 && roles.length < limit) {
    // Never read beyond the remaining page capacity: the cursor must cover every examined entry.
    const size = Math.min(4, limit - roles.length, 200 - examined);
    const batch = candidates.slice(examined, examined + size);
    const results = await Promise.allSettled(batch.map(readEntry));
    context.assertCurrent();
    for (let i = 0; i < batch.length; i++) {
      const result = results[i];
      if (result.status === "rejected") throw result.reason;
      last = batch[i];
      examined++;
      if (result.value) roles.push(result.value);
    }
  }
  return { roles, nextCursor: entries.some(id => id > last) ? last : null };
}

async function rejectExternalLinks(directory: string): Promise<void> {
  // lstat never follows symlinks/junctions. Reject them before destructive traversal.
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new RoleLifecycleError("ROLE_LINK_PRESENT", "角色目录包含链接，请先移除链接后再删除。");
    if (stat.isDirectory()) await rejectExternalLinks(target);
  }
}

/** The operation lock uses a namespace that cannot be a valid role ID. */
function operationLockDirectory(roleDirectory: string, operationId: string): string {
  return path.join(path.dirname(roleDirectory), `.operation-${createHash("sha256").update(operationId).digest("hex")}`);
}

async function assertManagedStateRoot(rolesRoot: string, includeCreating = false): Promise<void> {
  const canonicalRoot = await fs.realpath(rolesRoot);
  const state = path.join(canonicalRoot, ".role-state");
  for (const target of [state, ...["locks", "operations", ...(includeCreating ? ["creating"] : [])].map(name => path.join(state, name))]) {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(target, await fs.realpath(target)) !== "")
        throw new RoleLifecycleError("ROLE_STAGING_INVALID", "角色状态目录无效，请检查角色目录。", 403);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

async function prepareCreationStaging(rolesRoot: string, hash: string, assertCurrent: () => void): Promise<string> {
  const canonicalRoot = await fs.realpath(rolesRoot);
  let parent = canonicalRoot;
  for (const name of [".role-state", "creating", hash]) {
    const target = path.join(parent, name);
    try { await fs.mkdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    assertCurrent();
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RoleLifecycleError("ROLE_STAGING_INVALID", "角色创建暂存目录无效，请检查角色目录。", 403);
    const actual = await fs.realpath(target);
    if (path.relative(target, actual) !== "") throw new RoleLifecycleError("ROLE_STAGING_INVALID", "角色创建暂存目录超出角色目录。", 403);
    assertCurrent();
    parent = actual;
  }
  return parent;
}

async function command(context: Context, roleId: string, action: string, body: Command, operationId: string, transformConfig?: (current: RoleConfiguration) => RoleConfiguration) {
  const directory = roleFolderPath(context.rolesRoot, roleId);
  const receipts = path.join(roleStateRoot(directory), "operations", `${createHash("sha256").update(operationId).digest("hex")}.json`);
  const fingerprint = createHash("sha256").update(JSON.stringify([roleId, action, body])).digest("hex");
  await context.step(() => assertManagedStateRoot(context.rolesRoot));
  return context.step(() => withRoleLock(operationLockDirectory(directory, operationId), () => withRoleLock(directory, async () => {
    const previous = await context.step(() => optionalJson(receipts));
    if (previous.fingerprint) {
      if (previous.fingerprint !== fingerprint) throw new RoleLifecycleError("ROLE_OPERATION_CONFLICT", "操作键已用于另一项角色修改。");
      if (previous.state === "committed") return previous.result;
      context.retainPendingOutcome();
      if (action !== "delete") {
        const file = previous.file;
        if (file !== "roleMetadata.json" && file !== "personaConfig.json" && file !== "persona.md") throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
        const current = file === "persona.md" ? await context.step(() => readRoleDocument(directory)) : file === "personaConfig.json" ? await context.step(() => optionalJson(path.join(directory, "personaConfig.json"), personaReadSettings.configBytes)) : await context.step(() => optionalJson(path.join(directory, file)));
        if (JSON.stringify(current) !== JSON.stringify(previous.value)) {
          const revision = action === "document" ? (await context.step(() => documentDetail(context, roleId))).revision : await context.step(() => roleRevision(directory));
          if (revision !== body.expectedRevision) throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
          if (file === "persona.md") await context.write(() => atomicRoleDocument(directory, previous.value as string, context.assertCurrent));
          else await context.write(() => atomicRoleJson(path.join(directory, file as string), previous.value, context.assertCurrent));
        }
        await context.step(() => context.changed(roleId, context.assertCurrent));
        const result = await context.step(async () => action === "document" ? await documentDetail(context, roleId) : await detail(context, roleId));
        await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "committed", result }, context.assertCurrent));
        return result;
      }
    }
    if (!previous.fingerprint) {
      await context.step(() => checkedRoleDirectory(context.rolesRoot, roleId));
      const revision = action === "document" ? (await context.step(() => documentDetail(context, roleId))).revision : await context.step(() => roleRevision(directory));
      if (body.expectedRevision !== revision) throw new RoleLifecycleError("ROLE_REVISION_CONFLICT", "角色已被其他入口修改，请重新读取后保存。", 412);
    }
    const metadata = await context.step(() => readRoleMetadata(directory));
    if (action === "delete") {
      if (!metadata.archivedAt && !previous.fingerprint) throw new RoleLifecycleError("ROLE_NOT_ARCHIVED", "请先归档角色。");
      if (body.confirmationId !== roleId) throw new RoleLifecycleError("ROLE_CONFIRMATION_REQUIRED", "请输入角色 ID 确认彻底删除。", 400);
      const references = await context.step(() => roleReferences(context, roleId));
      if (references.length) throw new RoleLifecycleError("ROLE_REFERENCED", `请先解除以下引用：${references.join("；")}`);
      if (await context.step(() => roleWorkCount(directory))) throw new RoleLifecycleError("ROLE_WORK_RUNNING", "角色仍有运行中或状态待确认的任务。");
      const exists = await context.step(() => fs.lstat(directory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }));
      if (exists) { await context.step(() => checkedRoleDirectory(context.rolesRoot, roleId)); await context.step(() => rejectExternalLinks(directory)); }
      await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "pending" }, context.assertCurrent));
      await context.write(() => atomicRoleJson(path.join(roleStateRoot(directory), "deleted", `${roleId}.json`), { roleId, operationId, deletedAt: new Date().toISOString() }, context.assertCurrent));
      await context.write(() => fs.rm(directory, { recursive: true, force: true }));
    } else {
      if (action === "document") {
        await context.step(() => assertRoleAcceptsWork(directory));
        validateDocument(body.document);
        await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "pending", file: "persona.md", value: body.document }, context.assertCurrent));
        await context.write(() => atomicRoleDocument(directory, body.document!, context.assertCurrent));
      } else if (action === "config" || action === "config-patch") {
        await context.step(() => assertRoleAcceptsWork(directory));
        const current = await context.step(() => optionalJson(path.join(directory, "personaConfig.json"), personaReadSettings.configBytes));
        const fragment = action === "config-patch" ? { ...(body.config || {}) } : roleConfigurationOf(transformConfig ? transformConfig(roleConfigurationOf(current)) : body.config || {});
        if (action === "config-patch" && Object.hasOwn(fragment, "automationRules") && fragment.automationRules !== null) {
          if (!Array.isArray(fragment.automationRules)) throw new RoleLifecycleError("ROLE_CONFIG_INVALID", "automationRules 必须是数组。", 400);
          const unchanged = new Map<string, number>();
          for (const rule of Array.isArray(current.automationRules) ? current.automationRules : []) {
            const key = JSON.stringify(rule); unchanged.set(key, (unchanged.get(key) ?? 0) + 1);
          }
          fragment.automationRules = fragment.automationRules.map(rule => {
            const key = JSON.stringify(rule), count = unchanged.get(key) ?? 0;
            if (count) { unchanged.set(key, count - 1); return rule; }
            if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id.trim()
              || !rule.action || !["deliver_agent", "run_script"].includes(rule.action.type)
              || !rule.trigger || !["message", "schedule"].includes(rule.trigger.type)) throw new RoleLifecycleError("ROLE_CONFIG_INVALID", "新增或修改的自动化规则需要有效 ID、trigger 和 action。", 400);
            if (rule.trigger.type === "schedule" && rule.trigger.schedule?.type === "daily_time" && Object.hasOwn(rule.trigger.schedule, "timeOfDays") && normalizeDailyScheduleTimes(rule.trigger.schedule) === null)
              throw new RoleLifecycleError("ROLE_DAILY_TIMES_INVALID", "自动化的每日时间需要至少一个有效时间点（HH:mm 或 HH:mm:ss）。", 400);
            if (rule.action.type === "deliver_agent") {
              if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
              validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
            }
            return ensureDefaultPersonaAutomations([rule])[0];
          });
        } else if (action === "config" && fragment.automationRules && !transformConfig) {
          for (const [index, rule] of fragment.automationRules.entries()) {
            if (rule.trigger?.type === "schedule" && rule.trigger.schedule?.type === "daily_time"
              && Object.hasOwn(rule.trigger.schedule, "timeOfDays")
              && normalizeDailyScheduleTimes(rule.trigger.schedule) === null) {
              throw new RoleLifecycleError("ROLE_DAILY_TIMES_INVALID", `第 ${index + 1} 条自动化的每日时间需要至少一个有效时间点（HH:mm 或 HH:mm:ss）。`, 400);
            }
          }
          for (const rule of fragment.automationRules) if (rule.action.type === "deliver_agent") {
            if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
            validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
          }
          fragment.automationRules = ensureDefaultPersonaAutomations(fragment.automationRules);
        }
        // Saving role preferences is not a schedule migration. The storage owner
        // retains this version; only creation and the explicit upgrade advance it.
        const scheduleSchemaVersion = current.automationScheduleSchemaVersion;
        if (action === "config") for (const key of ROLE_CONFIGURATION_KEYS) delete current[key];
        const value: Record<string, unknown> = { ...current, ...fragment };
        if (action === "config-patch") for (const [key, valuePart] of Object.entries(fragment)) if (valuePart === null) delete value[key];
        if (scheduleSchemaVersion === undefined) delete value.automationScheduleSchemaVersion;
        else value.automationScheduleSchemaVersion = scheduleSchemaVersion;
        const configQuota = personaReadSettings.configBytes;
        if (configQuota > 0 && Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`) > configQuota) throw new RoleLifecycleError("ROLE_CONFIG_TOO_LARGE", `RABIROUTE_PERSONA_CONFIG_MAX_BYTES=${configQuota} exceeded; increase this Manager setting or set 0 to remove the application quota.`, 413);
        await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "pending", file: "personaConfig.json", value }, context.assertCurrent));
        await context.write(() => atomicRoleJson(path.join(directory, "personaConfig.json"), value, context.assertCurrent));
      } else {
        const value = { schemaVersion: 1, revision: metadata.revision + 1,
          archivedAt: action === "archive" ? metadata.archivedAt || new Date().toISOString() : null };
        await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "pending", file: "roleMetadata.json", value }, context.assertCurrent));
        await context.write(() => atomicRoleJson(path.join(directory, "roleMetadata.json"), value, context.assertCurrent));
      }
    }
    await context.step(() => context.changed(roleId, context.assertCurrent));
    const result = action === "delete" ? { roleId, deleted: true } : await context.step(async () => action === "document" ? documentDetail(context, roleId) : detail(context, roleId));
    await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "committed", result }, context.assertCurrent));
    recordDataMutationAudit({ group: "persona", event: `role_${action}_committed`, owner: "role-configuration",
      action, target: { type: "role", id: roleId }, dataSource: { kind: "file", id: `roles/${roleId}` }, outcome: "committed" });
    return result;
  })));
}

/** Functional owner: native CAS/receipts/lifecycle are shared by all HTTP consumers. */
export function createRoleConfigurationOwner(source: RoleConfigurationContext) {
  return { prepare(request: http.IncomingMessage, signal?: AbortSignal) {
    let admission!: () => void;
    const checkAdmission = (check: () => void) => {
      try { check(); }
      catch (error) {
        signal?.throwIfAborted();
        if ((error as { statusCode?: number })?.statusCode) throw error;
        throw new RoleLifecycleError("ROLE_CONNECTION_CHANGED", "原连接已失效，请重新连接。", 403);
      }
    };
    checkAdmission(() => { admission = preparePersonaResourceAdmission(request, signal, source.identity); });
    const rolesRoot = source.rolesRoot();
    let mutationStarted = false;
    const assertCurrent = () => {
      checkAdmission(admission);
      if (path.resolve(source.rolesRoot()) !== path.resolve(rolesRoot)) {
        throw new RoleLifecycleError("ROLE_ROOT_CHANGED", "角色目录已切换，请重新读取当前角色。", 409);
      }
      if (request.method !== "GET" && source.isReadOnly?.()) {
        throw new RoleLifecycleError("ROLE_READ_ONLY", "当前 Manager 为只读模式。", 403);
      }
    };
    const step = async <T>(action: () => Promise<T>): Promise<T> => {
      assertCurrent();
      const value = await action();
      assertCurrent();
      return value;
    };
    const write = <T>(action: () => Promise<T>) => step(() => { mutationStarted = true; return action(); });
    const context: Context = { ...source, rolesRoot, assertCurrent, step, write,
      retainPendingOutcome: () => { mutationStarted = true; } };
    const read = <T>(action: () => Promise<T>) => step(action);
    assertCurrent();
    return {
      assertCurrent,
      mutationOutcome: () => mutationStarted ? "unknown" as const : "not_started" as const,
      list: (url: URL) => read(() => list(context, url)),
      detail: (roleId: string) => read(() => detail(context, roleId)),
      document: (roleId: string) => read(() => documentDetail(context, roleId)),
      references: (roleId: string) => read(async () => ({
        references: await step(() => roleReferences(context, roleId)),
        runningWork: await step(() => roleWorkCount(roleFolderPath(rolesRoot, roleId)))
      })),
      command: (roleId: string, action: "config" | "config-patch" | "document" | "archive" | "restore" | "delete", body: Command, operationId: string, transformConfig?: (current: RoleConfiguration) => RoleConfiguration) =>
        read(() => command(context, roleId, action, body, operationId, transformConfig)),
      create: (body: Command, operationId?: string) => read(async () => {
        const roleId = sanitizeRoleId(body.roleId);
        if (!roleId || roleId !== body.roleId) {
          throw new RoleLifecycleError("ROLE_ID_INVALID", "请输入有效的角色 ID 和名称。", 400);
        }
        if (typeof body.title !== "string" || !body.title.trim()) throw new RoleLifecycleError("ROLE_TITLE_REQUIRED", "角色名称不能为空。", 400);
        const document = body.document ?? `# ${body.title.trim().replace(/[\r\n]/g, " ")}\n`;
        validateDocument(document);
        const supplied = body.config ?? {};
        if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) throw new RoleLifecycleError("ROLE_CONFIG_INVALID", "角色配置必须是对象。", 400);
        let rules = supplied.automationRules;
        if (rules !== undefined) {
          if (!Array.isArray(rules)) throw new RoleLifecycleError("ROLE_CONFIG_INVALID", "automationRules 必须是数组。", 400);
          for (const rule of rules) {
            if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id.trim() || !rule.trigger || !["message", "schedule"].includes(rule.trigger.type) || !rule.action || !["deliver_agent", "run_script"].includes(rule.action.type))
              throw new RoleLifecycleError("ROLE_CONFIG_INVALID", "自动化规则需要有效 ID、trigger 和 action。", 400);
            if (rule.trigger.type === "schedule" && rule.trigger.schedule?.type === "daily_time" && Object.hasOwn(rule.trigger.schedule, "timeOfDays") && normalizeDailyScheduleTimes(rule.trigger.schedule) === null)
              throw new RoleLifecycleError("ROLE_DAILY_TIMES_INVALID", "自动化的每日时间需要至少一个有效时间点（HH:mm 或 HH:mm:ss）。", 400);
            if (rule.action.type === "deliver_agent") {
              if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
              validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
            }
          }
        }
        const config = { ...supplied, automationRules: ensureDefaultPersonaAutomations(rules ?? []), automationScheduleSchemaVersion: 1 };
        const configQuota = personaReadSettings.configBytes;
        if (configQuota > 0 && Buffer.byteLength(`${JSON.stringify(config, null, 2)}\n`) > configQuota) throw new RoleLifecycleError("ROLE_CONFIG_TOO_LARGE", `RABIROUTE_PERSONA_CONFIG_MAX_BYTES=${configQuota} exceeded; increase this Manager setting or set 0 to remove the application quota.`, 413);
        const directory = roleFolderPath(rolesRoot, roleId);
        const key = operationId || randomUUID(), hash = createHash("sha256").update(key).digest("hex");
        const receipt = path.join(roleStateRoot(directory), "operations", `${hash}.json`);

        const fingerprint = createHash("sha256").update(JSON.stringify([roleId, "create", body])).digest("hex");
        let result: Awaited<ReturnType<typeof detail>> | undefined;
        await step(() => assertManagedStateRoot(rolesRoot, true));
        await step(() => withRoleLock(operationLockDirectory(directory, key), () => withRoleLock(directory, async () => {
          const previous = await step(() => optionalJson(receipt));
          if (previous.fingerprint) {
            if (previous.fingerprint !== fingerprint) throw new RoleLifecycleError("ROLE_OPERATION_CONFLICT", "操作键已用于另一项角色修改。");
            if (previous.state === "committed") { result = previous.result as Awaited<ReturnType<typeof detail>>; return; }
            context.retainPendingOutcome();
          }
          await step(() => assertRoleAcceptsWork(directory));
          const exists = await step(() => fs.lstat(directory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }));
          if (exists) {
            if (!previous.fingerprint) throw new RoleLifecycleError("ROLE_EXISTS", "角色已存在，请读取后修改。");
            await step(() => checkedRoleDirectory(rolesRoot, roleId));
            const existing = await step(() => documentDetail(context, roleId));
            if (existing.document !== document || JSON.stringify(existing.personaConfig) !== JSON.stringify(config)) {
              throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "创建后的角色已变化，请保留原操作键并核对。", 503);
            }
          } else {
            await write(() => atomicRoleJson(receipt, { fingerprint, state: "pending", action: "create", roleId }, assertCurrent));
            const staging = await write(() => prepareCreationStaging(rolesRoot, hash, assertCurrent));
            await write(() => atomicRoleDocument(staging, document, assertCurrent));
            await write(() => atomicRoleJson(path.join(staging, "personaConfig.json"), config, assertCurrent));
            await write(() => fs.rename(staging, directory));
          }
          await step(() => source.changed(roleId, assertCurrent));
          result = await step(() => detail(context, roleId));
          await write(() => atomicRoleJson(receipt, { fingerprint, state: "committed", result }, assertCurrent));
        })));
        recordDataMutationAudit({ group: "persona", event: "role_create_committed", owner: "role-configuration",
          action: "create", target: { type: "role", id: roleId }, dataSource: { kind: "file", id: `roles/${roleId}` }, outcome: "committed" });
        return result!;
      })
    };
  }};
}
