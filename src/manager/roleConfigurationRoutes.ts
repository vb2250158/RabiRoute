import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type http from "node:http";
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

type Context = {
  rolesRoot: string;
  routes: () => readonly GatewayDefinition[];
  presentation?: (roleId: string) => { avatarConfigured: boolean; avatarVersion?: string } | undefined;
  assertCatalogReady: () => void;
  isReadOnly?: () => boolean;
  readJson: <T>(request: http.IncomingMessage, maxBytes?: number) => Promise<T>;
  changed: (roleId: string) => Promise<void>;
};
type Command = { expectedRevision: string; confirmationId?: string; roleId?: string; title?: string; config?: RoleConfiguration };

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

export async function roleReferences(context: Context, roleId: string): Promise<string[]> {
  context.assertCatalogReady();
  const references = context.routes().filter(route => !route.agentRoleDeviceId && route.agentRoleId === roleId)
    .map(route => `路由：${route.routeName || route.name || route.id} (${route.id})`);
  const entries = await fs.readdir(context.rolesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === roleId || !sanitizeRoleId(entry.name)) continue;
    if (hasRoleReference(await optionalJson(path.join(roleFolderPath(context.rolesRoot, entry.name), "personaConfig.json")), roleId)) {
      references.push(`角色自动化：${entry.name}`);
    }
  }
  return references;
}

async function detail(context: Context, roleId: string) {
  const directory = await checkedRoleDirectory(context.rolesRoot, roleId);
  const [metadata, config, revision, runningWork] = await Promise.all([
    readRoleMetadata(directory), optionalJson(path.join(directory, "personaConfig.json")), roleRevision(directory), roleWorkCount(directory)
  ]);
  return { roleId, ...metadata, revision, config: roleConfigurationOf(config), runningWork,
    rolePath: path.join(directory, "persona.md"), roleDir: directory,
    routes: context.routes().filter(route => !route.agentRoleDeviceId && route.agentRoleId === roleId).map(route => ({ id: route.id, name: route.routeName || route.name || route.id })) };
}

async function list(context: Context, url: URL) {
  const archived = url.searchParams.get("scope") === "archived";
  const query = (url.searchParams.get("query") || "").toLocaleLowerCase();
  const cursor = url.searchParams.get("cursor") || "";
  const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit")) || 25));
  const entries = (await fs.readdir(context.rolesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && sanitizeRoleId(entry.name)).map(entry => entry.name).sort();
  const roles: Array<Record<string, unknown>> = [];
  let last = cursor;
  let examined = 0;
  for (const roleId of entries.filter(id => id > cursor)) {
    if (examined >= 200) break;
    last = roleId;
    examined++;
    try {
      const directory = await checkedRoleDirectory(context.rolesRoot, roleId);
      const metadata = await readRoleMetadata(directory);
      if (Boolean(metadata.archivedAt) !== archived) continue;
      let title = "";
      try {
        const handle = await fs.open(path.join(directory, "persona.md"), "r");
        try { const buffer = Buffer.alloc(8192); const read = await handle.read(buffer, 0, buffer.length, 0); title = personaMarkdownTitle(buffer.toString("utf8", 0, read.bytesRead)); }
        finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (query && !`${title} ${roleId}`.toLocaleLowerCase().includes(query)) continue;
      const presentation = context.presentation?.(roleId);
      roles.push({ roleId, title: title || roleId, archivedAt: metadata.archivedAt,
        avatarConfigured: presentation?.avatarConfigured === true,
        avatarUrl: `/api/roles/${encodeURIComponent(roleId)}/avatar${presentation?.avatarVersion ? `?v=${encodeURIComponent(presentation.avatarVersion)}` : ""}`, error: "" });
    } catch (error) {
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
  return withRoleLock(directory, async () => {
    const previous = await optionalJson(receipts);
    if (previous.fingerprint) {
      if (previous.fingerprint !== fingerprint) throw new RoleLifecycleError("ROLE_OPERATION_CONFLICT", "操作键已用于另一项角色修改。");
      if (previous.state === "committed") return previous.result;
      if (action !== "delete") {
        const file = previous.file;
        if (file !== "roleMetadata.json" && file !== "personaConfig.json") throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
        if (JSON.stringify(await optionalJson(path.join(directory, file))) !== JSON.stringify(previous.value)) {
          if (await roleRevision(directory) !== body.expectedRevision) throw new RoleLifecycleError("ROLE_OPERATION_UNCERTAIN", "原操作结果待核对，请保留原操作键。", 503);
          await atomicRoleJson(path.join(directory, file), previous.value);
        }
        await context.changed(roleId);
        const result = await detail(context, roleId);
        await atomicRoleJson(receipts, { fingerprint, state: "committed", result });
        return result;
      }
    }
    if (!previous.fingerprint) {
      await checkedRoleDirectory(context.rolesRoot, roleId);
      const revision = await roleRevision(directory);
      if (body.expectedRevision !== revision) throw new RoleLifecycleError("ROLE_REVISION_CONFLICT", "角色已被其他入口修改，请重新读取后保存。", 412);
    }
    const metadata = await readRoleMetadata(directory);
    if (action === "delete") {
      if (!metadata.archivedAt && !previous.fingerprint) throw new RoleLifecycleError("ROLE_NOT_ARCHIVED", "请先归档角色。");
      if (body.confirmationId !== roleId) throw new RoleLifecycleError("ROLE_CONFIRMATION_REQUIRED", "请输入角色 ID 确认彻底删除。", 400);
      const references = await roleReferences(context, roleId);
      if (references.length) throw new RoleLifecycleError("ROLE_REFERENCED", `请先解除以下引用：${references.join("；")}`);
      if (await roleWorkCount(directory)) throw new RoleLifecycleError("ROLE_WORK_RUNNING", "角色仍有运行中或状态待确认的任务。");
      const exists = await fs.lstat(directory).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
      if (exists) { await checkedRoleDirectory(context.rolesRoot, roleId); await rejectExternalLinks(directory); }
      await atomicRoleJson(receipts, { fingerprint, state: "pending" });
      await atomicRoleJson(path.join(roleStateRoot(directory), "deleted", `${roleId}.json`), { roleId, operationId, deletedAt: new Date().toISOString() });
      await fs.rm(directory, { recursive: true, force: true });
    } else {
      if (action === "config") {
        await assertRoleAcceptsWork(directory);
        const fragment = roleConfigurationOf(body.config || {});
        if (fragment.automationRules) {
          for (const rule of fragment.automationRules) if (rule.action.type === "deliver_agent") {
            if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
            validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target));
          }
          fragment.automationRules = ensureDefaultPersonaAutomations(fragment.automationRules);
        }
        const current = await optionalJson(path.join(directory, "personaConfig.json"));
        for (const key of ROLE_CONFIGURATION_KEYS) delete current[key];
        const value = { ...current, ...fragment };
        await atomicRoleJson(receipts, { fingerprint, state: "pending", file: "personaConfig.json", value });
        await atomicRoleJson(path.join(directory, "personaConfig.json"), value);
      } else {
        const value = { schemaVersion: 1, revision: metadata.revision + 1,
          archivedAt: action === "archive" ? metadata.archivedAt || new Date().toISOString() : null };
        await atomicRoleJson(receipts, { fingerprint, state: "pending", file: "roleMetadata.json", value });
        await atomicRoleJson(path.join(directory, "roleMetadata.json"), value);
      }
    }
    await context.changed(roleId);
    const result = action === "delete" ? { roleId, deleted: true } : await detail(context, roleId);
    await atomicRoleJson(receipts, { fingerprint, state: "committed", result });
    recordDataMutationAudit({ group: "persona", event: `role_${action}_committed`, owner: "role-configuration",
      action, target: { type: "role", id: roleId }, dataSource: { kind: "file", id: `roles/${roleId}` }, outcome: "committed" });
    return result;
  });
}

export function handleRoleConfigurationApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: Context): boolean {
  const match = url.pathname.match(/^\/api\/roles(?:\/([^/]+)\/(configuration|archive|restore|delete|references))?$/);
  if (!match) return false;
  const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
  void (async () => {
    if (request.method !== "GET" && context.isReadOnly?.()) throw new RoleLifecycleError("ROLE_READ_ONLY", "当前 Manager 为只读模式。", 403);
    if (!match[1] && request.method === "GET") { send(200, { code: 0, data: await list(context, url) }); return; }
    if (!match[1] && request.method === "POST") {
      const body = await context.readJson<Command>(request, 64 * 1024);
      const roleId = sanitizeRoleId(body.roleId);
      if (!roleId || roleId !== body.roleId || (typeof body.title !== "string" || !body.title.trim())) throw new RoleLifecycleError("ROLE_ID_INVALID", "请输入有效的角色 ID 和名称。", 400);
      const directory = roleFolderPath(context.rolesRoot, roleId);
      await withRoleLock(directory, async () => {
        await assertRoleAcceptsWork(directory);
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "persona.md"), `# ${body.title!.trim().replace(/[\r\n]/g, " ")}\n`, { flag: "wx" });
        await atomicRoleJson(path.join(directory, "personaConfig.json"), { automationRules: ensureDefaultPersonaAutomations([]) });
        await context.changed(roleId);
      });
      send(201, { code: 0, data: await detail(context, roleId) }); return;
    }
    const roleId = decodeURIComponent(match[1] || "");
    if (!sanitizeRoleId(roleId) || sanitizeRoleId(roleId) !== roleId) throw new RoleLifecycleError("ROLE_ID_INVALID", "角色 ID 无效。", 400);
    const action = match[2];
    if (request.method === "GET" && action === "configuration") { send(200, { code: 0, data: await detail(context, roleId) }); return; }
    if (request.method === "GET" && action === "references") { send(200, { code: 0, data: { references: await roleReferences(context, roleId), runningWork: await roleWorkCount(roleFolderPath(context.rolesRoot, roleId)) } }); return; }
    const mutationAllowed = request.method === "PUT" && action === "configuration"
      || request.method === "POST" && ["archive", "restore", "delete"].includes(action || "");
    if (!mutationAllowed) throw new RoleLifecycleError("ROLE_METHOD_INVALID", "不支持此操作。", 405);
    const operationId = String(request.headers["idempotency-key"] || "");
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(operationId)) throw new RoleLifecycleError("ROLE_OPERATION_KEY_REQUIRED", "缺少有效操作键。", 400);
    const body = await context.readJson<Command>(request, 2 * 1024 * 1024);
    const data = await command(context, roleId, action === "configuration" ? "config" : action, body, operationId);
    send(200, { code: 0, data, operationId, state: "committed" });
  })().catch(error => {
    recordDataMutationAudit({ level: "error", group: "persona", event: "role_operation_unconfirmed", owner: "role-configuration",
      action: match[2] || "list", target: { type: "role", id: match[1] || "catalog" },
      dataSource: { kind: "file", id: "roles" }, outcome: "failed", error });
    send(error instanceof RoleLifecycleError ? error.status : 500,
      { code: -1, error: error instanceof RoleLifecycleError ? error.code : "ROLE_OPERATION_FAILED", message: error instanceof RoleLifecycleError ? error.message : "角色操作未完成，请检查目录状态后重试。" });
  });
  return true;
}
