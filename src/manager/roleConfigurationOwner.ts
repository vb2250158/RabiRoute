import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
import { preparePersonaResourceAdmission, type PersonaResourceIdentity } from "./personaResourceAdmission.js";
import { personaMarkdownTitle } from "./personaCatalog.js";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFolderPath } from "../shared/routePaths.js";
import { ROLE_CONFIGURATION_KEYS, roleConfigurationOf, type RoleConfiguration } from "../shared/roleConfiguration.js";
import { ensureDefaultPersonaAutomations, type GatewayDefinition } from "../shared/gatewayConfigModel.js";
import { normalizeAgentDeliveryTarget, validateAgentDeliveryTarget } from "../shared/agentDeliveryTarget.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import {
  RoleLifecycleError, readRoleMetadata, roleWorkCount, roleStateRoot, withRoleLock,
  checkedRoleDirectory, atomicRoleJson, assertRoleAcceptsWork
} from "../roleLifecycle.js";

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
export type RoleConfigurationCommand = { expectedRevision: string; confirmationId?: string; roleId?: string; title?: string; config?: RoleConfiguration };
type Context = Omit<RoleConfigurationContext, "rolesRoot"> & {
  rolesRoot: string;
  assertCurrent(): void;
  step<T>(action: () => Promise<T>): Promise<T>;
  write<T>(action: () => Promise<T>): Promise<T>;
  retainPendingOutcome(): void;
};
type Command = RoleConfigurationCommand;

async function optionalJson(file: string): Promise<Record<string, unknown>> {
  try {
    const handle = await fs.open(file, "r");
    try {
      if ((await handle.stat()).size > 2 * 1024 * 1024) throw new RoleLifecycleError("ROLE_CONFIG_TOO_LARGE", "角色配置超过大小限制。", 413);
      const result: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid configuration");
      return result as Record<string, unknown>;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}

async function roleRevision(directory: string): Promise<string> {
  const [metadata, config] = await Promise.all([readRoleMetadata(directory), optionalJson(path.join(directory, "personaConfig.json"))]);
  return createHash("sha256").update(JSON.stringify([metadata, config])).digest("hex");
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
    if (hasRoleReference(await context.step(() => optionalJson(path.join(roleFolderPath(context.rolesRoot, entry.name), "personaConfig.json"))), roleId)) {
      references.push(`角色自动化：${entry.name}`);
    }
  }
  return references;
}

async function detail(context: Context, roleId: string) {
  const directory = await context.step(async () => {
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
  const [metadata, config, revision, runningWork] = await context.step(() => Promise.all([
    readRoleMetadata(directory), optionalJson(path.join(directory, "personaConfig.json")), roleRevision(directory), roleWorkCount(directory)
  ]));
  return { roleId, ...metadata, revision, config: roleConfigurationOf(config), runningWork,
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
  for (const roleId of entries.filter(id => id > cursor)) {
    if (examined >= 200) break;
    last = roleId;
    examined++;
    try {
      const directory = await context.step(() => checkedRoleDirectory(context.rolesRoot, roleId));
      const metadata = await context.step(() => readRoleMetadata(directory));
      if (Boolean(metadata.archivedAt) !== archived) continue;
      let title = "";
      try {
        const handle = await fs.open(path.join(directory, "persona.md"), "r");
        try { const buffer = Buffer.alloc(8192); const read = await handle.read(buffer, 0, buffer.length, 0); title = personaMarkdownTitle(buffer.toString("utf8", 0, read.bytesRead)); }
        finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      context.assertCurrent();
      if (query && !`${title} ${roleId}`.toLocaleLowerCase().includes(query)) continue;
      const presentation = context.presentation?.(roleId);
      roles.push({ roleId, title: title || roleId, archivedAt: metadata.archivedAt,
        avatarConfigured: presentation?.avatarConfigured === true,
        avatarUrl: `/api/roles/${encodeURIComponent(roleId)}/avatar${presentation?.avatarVersion ? `?v=${encodeURIComponent(presentation.avatarVersion)}` : ""}`, error: "" });
    } catch (error) {
      context.assertCurrent();
      roles.push({ roleId, title: roleId, archivedAt: null, error: error instanceof Error ? error.message : String(error) });
    }
    if (roles.length >= limit || examined >= 200) break;
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

async function command(context: Context, roleId: string, action: string, body: Command, operationId: string) {
  const directory = roleFolderPath(context.rolesRoot, roleId);
  const receipts = path.join(roleStateRoot(directory), "operations", `${createHash("sha256").update(operationId).digest("hex")}.json`);
  const fingerprint = createHash("sha256").update(JSON.stringify([roleId, action, body])).digest("hex");
  return context.step(() => withRoleLock(directory, async () => {
    const previous = await context.step(() => optionalJson(receipts));
    if (previous.fingerprint) {
      if (previous.fingerprint !== fingerprint) throw new RoleLifecycleError("ROLE_OPERATION_CONFLICT", "操作键已用于另一项角色修改。");
      if (previous.state === "committed") return previous.result;
      context.retainPendingOutcome();
      if (action !== "delete") {
        const file = previous.file;
        if (file !== "roleMetadata.json" && file !== "personaConfig.json") throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
        if (JSON.stringify(await context.step(() => optionalJson(path.join(directory, file)))) !== JSON.stringify(previous.value)) {
          if (await context.step(() => roleRevision(directory)) !== body.expectedRevision) throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
          await context.write(() => atomicRoleJson(path.join(directory, file as string), previous.value, context.assertCurrent));
        }
        await context.step(() => context.changed(roleId, context.assertCurrent));
        const result = await context.step(() => detail(context, roleId));
        await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "committed", result }, context.assertCurrent));
        return result;
      }
    }
    if (!previous.fingerprint) {
      await context.step(() => checkedRoleDirectory(context.rolesRoot, roleId));
      const revision = await context.step(() => roleRevision(directory));
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
      if (action === "config") {
        await context.step(() => assertRoleAcceptsWork(directory));
        const fragment = roleConfigurationOf(body.config || {});
        if (fragment.automationRules) {
          for (const rule of fragment.automationRules) if (rule.action.type === "deliver_agent") {
            if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
            validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
          }
          fragment.automationRules = ensureDefaultPersonaAutomations(fragment.automationRules);
        }
        const current = await context.step(() => optionalJson(path.join(directory, "personaConfig.json")));
        for (const key of ROLE_CONFIGURATION_KEYS) delete current[key];
        const value = { ...current, ...fragment };
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
    const result = action === "delete" ? { roleId, deleted: true } : await context.step(() => detail(context, roleId));
    await context.write(() => atomicRoleJson(receipts, { fingerprint, state: "committed", result }, context.assertCurrent));
    recordDataMutationAudit({ group: "persona", event: `role_${action}_committed`, owner: "role-configuration",
      action, target: { type: "role", id: roleId }, dataSource: { kind: "file", id: `roles/${roleId}` }, outcome: "committed" });
    return result;
  }));
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
      references: (roleId: string) => read(async () => ({
        references: await step(() => roleReferences(context, roleId)),
        runningWork: await step(() => roleWorkCount(roleFolderPath(rolesRoot, roleId)))
      })),
      command: (roleId: string, action: "config" | "archive" | "restore" | "delete", body: Command, operationId: string) =>
        read(() => command(context, roleId, action, body, operationId)),
      create: (body: Command) => read(async () => {
        const roleId = sanitizeRoleId(body.roleId);
        if (!roleId || roleId !== body.roleId || typeof body.title !== "string" || !body.title.trim()) {
          throw new RoleLifecycleError("ROLE_ID_INVALID", "请输入有效的角色 ID 和名称。", 400);
        }
        const directory = roleFolderPath(rolesRoot, roleId);
        await step(() => withRoleLock(directory, async () => {
          await step(() => assertRoleAcceptsWork(directory));
          await write(() => fs.mkdir(directory));
          await write(() => fs.writeFile(path.join(directory, "persona.md"), `# ${body.title!.trim().replace(/[\r\n]/g, " ")}\n`, { flag: "wx" }));
          await write(() => atomicRoleJson(path.join(directory, "personaConfig.json"), { automationRules: ensureDefaultPersonaAutomations([]) }, assertCurrent));
          await step(() => source.changed(roleId, assertCurrent));
        }));
        const result = await step(() => detail(context, roleId));
        recordDataMutationAudit({ group: "persona", event: "role_create_committed", owner: "role-configuration",
          action: "create", target: { type: "role", id: roleId }, dataSource: { kind: "file", id: `roles/${roleId}` }, outcome: "committed" });
        return result;
      })
    };
  }};
}
