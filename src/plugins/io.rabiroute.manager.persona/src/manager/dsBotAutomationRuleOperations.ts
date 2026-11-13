import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { beginRoleWork, checkedRoleDirectory, readRoleMetadata } from "@rabiroute/host-api/roleLifecycle";
import { sanitizeRoleId } from "@rabiroute/host-api/shared/routeIdentity";
import { ApiContractError, type ApiOperationDefinition } from "@rabiroute/host-api/manager/apiOperationContract";
import { normalizePersonaAutomationRules, type PersonaAutomationRuleDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { validateAgentDeliveryTarget, normalizeDsBotConnectionOrigin, normalizeAgentDeliveryTarget } from "@rabiroute/host-api/shared/agentDeliveryTarget";
import { normalizeAgentInstanceBinding } from "@rabiroute/host-api/shared/agentInstance";

type Rule = Record<string, unknown>;
type Entry = { id: string; sourceRoleId: string; rawRuleId: string; rule: Rule };
type Snapshot = { items: Entry[]; warnings: { roleId: string; code: string }[]; revision: string; refreshedAt: string; storageOwner: string };
export type DsBotAutomationRuleContext = {
  rolesRoot(): string;
  identity(): { applicationGenerationId: string; managerInstanceId: string };
};
export type RoleAutomationScheduleTask = { sourceRoleId: string; rawRuleId: string; storageOwner: string; rule: PersonaAutomationRuleDefinition & { trigger: { type: "schedule" } } };

/** Rebuildable role configuration index; it never dispatches or authorizes work. */
export function createDsBotAutomationRuleOwner(context: DsBotAutomationRuleContext) {
  let epoch = 0;
  let disposed = false;
  const reads = new Set<Promise<Snapshot>>();
  const work = new Set<Promise<void>>();
  const admissions = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let cached: { key: string; value: Promise<Snapshot>; expiresAt: number } | undefined;
  const key = () => JSON.stringify([path.resolve(context.rolesRoot()), context.identity(), epoch]);
  const storageIdentity = () => JSON.stringify([path.resolve(context.rolesRoot()), context.identity()]);
  async function scan(root: string, storageOwner: string): Promise<Snapshot> {
    const roles = (await fs.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && sanitizeRoleId(entry.name) === entry.name).map(entry => entry.name).sort();
    const results = new Array<{ items: Entry[]; warnings: Snapshot["warnings"] }>(roles.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, roles.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= roles.length) return;
        const roleId = roles[index]!;
        const items: Entry[] = [], warnings: Snapshot["warnings"] = [];
        try {
          const directory = await checkedRoleDirectory(root, roleId);
          if (!(await readRoleMetadata(directory)).archivedAt) {
            let value: unknown = {};
            try {
              const handle = await fs.open(path.join(directory, "personaConfig.json"), "r");
              try {
                value = JSON.parse(await handle.readFile("utf8"));
              } finally { await handle.close(); }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid configuration");
            const rules = (value as { automationRules?: unknown }).automationRules;
            if (rules !== undefined && !Array.isArray(rules)) throw new Error("invalid rules");
            for (const candidate of Array.isArray(rules) ? rules : []) {
              if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) { warnings.push({ roleId, code: "AUTOMATION_RULE_INVALID" }); continue; }
              const rule = candidate as Rule;
              const action = rule.action as { type?: unknown; target?: { kind?: unknown } } | undefined;
              if (action?.type !== "deliver_agent" || action.target?.kind !== "ds_bot") continue;
              if (typeof rule.id !== "string" || !rule.id) { warnings.push({ roleId, code: "AUTOMATION_RULE_ID_INVALID" }); continue; }
              try { validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(action.target)); }
              catch { warnings.push({ roleId, code: "AUTOMATION_DESTINATION_INVALID" }); }
              items.push({ id: Buffer.from(JSON.stringify([roleId, rule.id])).toString("base64url"), sourceRoleId: roleId, rawRuleId: rule.id, rule });
            }
          }
        } catch { warnings.push({ roleId, code: "ROLE_CONFIGURATION_UNAVAILABLE" }); }
        results[index] = { items, warnings };
      }
    }));
    const data = { items: results.flatMap(result => result.items), warnings: results.flatMap(result => result.warnings) };
    return { ...data, storageOwner, revision: createHash("sha256").update(JSON.stringify([storageOwner, data])).digest("hex"), refreshedAt: new Date().toISOString() };
  }
  return {
    invalidate() { epoch++; cached = undefined; if (!disposed) for (const listener of listeners) listener(); },
    async acquireTaskLease(sourceRoleId: string, expectedStorageOwner: string) {
      const original = expectedStorageOwner;
      const assertCurrent = () => { if (disposed || original !== storageIdentity()) throw new Error("Original role automation storage owner changed."); };
      assertCurrent();
      let settled!: () => void;
      const pending = new Promise<void>(resolve => { settled = resolve; });
      work.add(pending);
      const previous = admissions.get(sourceRoleId);
      let admitted!: () => void;
      const admission = new Promise<void>(resolve => { admitted = resolve; });
      admissions.set(sourceRoleId, admission);
      try {
        await previous;
        assertCurrent();
        const directory = await checkedRoleDirectory(context.rolesRoot(), sourceRoleId);
        assertCurrent();
        const release = await beginRoleWork(directory);
        try { assertCurrent(); } catch (error) { await release(); throw error; }
        return { assertCurrent, async release() { try { await release(); } finally { settled(); work.delete(pending); } } };
      } catch (error) { settled(); work.delete(pending); throw error; }
      finally { admitted(); if (admissions.get(sourceRoleId) === admission) admissions.delete(sourceRoleId); }
    },
    subscribeChanged(listener: () => void) { if (disposed) throw new Error("DSBot automation rule view is disposed."); listeners.add(listener); return () => { listeners.delete(listener); }; },
    async dispose() { disposed = true; listeners.clear(); cached = undefined; await Promise.allSettled([...reads, ...work]); },
    async readScheduleSnapshot() {
      const source = await this.snapshot();
      const warnings = [...source.warnings];
      const tasks: RoleAutomationScheduleTask[] = [];
      for (const entry of source.items) {
        try {
          const rule = normalizePersonaAutomationRules([entry.rule])[0]!;
          if (!rule.enabled || rule.trigger.type !== "schedule" || rule.trigger.schedule.enabled === false) continue;
          if (rule.sourceRouteIds?.length) { warnings.push({ roleId: entry.sourceRoleId, code: "ROLE_AUTOMATION_ROUTE_CONSTRAINT" }); continue; }
          if (rule.action.type !== "deliver_agent" || rule.action.target?.kind !== "ds_bot") continue;
          validateAgentDeliveryTarget(rule.action.target);
          tasks.push({ sourceRoleId: entry.sourceRoleId, rawRuleId: entry.rawRuleId, storageOwner: source.storageOwner, rule: rule as RoleAutomationScheduleTask["rule"] });
        } catch { warnings.push({ roleId: entry.sourceRoleId, code: "AUTOMATION_SCHEDULE_INVALID" }); }
      }
      return { revision: source.revision, refreshedAt: source.refreshedAt, tasks, warnings };
    },
    async snapshot(): Promise<Snapshot> {
      for (;;) {
        if (disposed) throw new Error("DSBot automation rule view is disposed.");
        const root = path.resolve(context.rolesRoot());
        const identity = context.identity();
        const current = JSON.stringify([root, identity, epoch]);
        if (cached?.key !== current || cached.expiresAt <= Date.now()) {
          const value = scan(root, JSON.stringify([root, identity]));
          cached = { key: current, value, expiresAt: Date.now() + 30_000 };
          reads.add(value);
          void value.then(() => reads.delete(value), () => { reads.delete(value); if (cached?.value === value) cached = undefined; });
        }
        const value = await cached.value;
        if (current === key()) return structuredClone(value);
      }
    }
  };
}

/** Lists rules explicitly assigned to one native DSBot across every source role. */
export function createDsBotAutomationRuleOperations(owner: ReturnType<typeof createDsBotAutomationRuleOwner>): readonly ApiOperationDefinition[] {
  const operationId = "manager.personas.automation.ds-bot-rules.list";
  const empty = { type: "object", additionalProperties: false } as const;
  return [{ contract: {
    operationId, contractVersion: "1.0.0", method: "GET", pathTemplate: "/api/automation/ds-bot-rules", exposure: "public", transport: "http",
    description: "Read complete editable rules explicitly assigned to a native DSBot.",
    request: { path: empty, query: { type: "object", required: ["botScopeId", "botId"], additionalProperties: false, properties: {
      botScopeId: { type: "string", minLength: 1 }, botId: { type: "string", minLength: 1 }, agentTargetId: { type: "string", minLength: 1 },
      dshBaseUrl: { type: "string", minLength: 1 }, instanceBinding: { type: "string", minLength: 1 },
      cursor: { type: "string", minLength: 1 }, limit: { type: "string", pattern: "^(?:[1-9]|[1-9][0-9]|100)$" }
    } }, headers: { type: "object" }, body: { kind: "none" } },
    responses: { "200": { mediaType: "application/json", schema: { type: "object" } } },
    effects: { mode: "read", description: "Read role configuration without mutation or dispatch." },
    recovery: { strategy: "repeatable-read", description: "Refresh pagination when the role configuration revision changes." }, validators: []
  }, async handler(input) {
    const snapshot = await owner.snapshot();
    const bindingIdentity = (value: unknown) => {
      const binding = normalizeAgentInstanceBinding(value);
      if (!binding) throw new Error("Invalid Agent instance binding.");
      return JSON.stringify([binding.instanceId, binding.agentId, binding.ownerDeviceId ?? ""]);
    };
    let connection = "";
    try {
      if (input.query.dshBaseUrl && input.query.instanceBinding) throw new Error("Select one connection.");
      if (input.query.dshBaseUrl) connection = "local:" + normalizeDsBotConnectionOrigin(input.query.dshBaseUrl);
      if (input.query.instanceBinding) connection = "remote:" + bindingIdentity(JSON.parse(String(input.query.instanceBinding)));
    } catch { throw new ApiContractError(400, "DS_BOT_RULE_CONNECTION_INVALID", "dshBaseUrl", operationId); }
    const selection = [input.query.botScopeId, input.query.botId, input.query.agentTargetId ?? "", connection];
    const matches = snapshot.items.filter(item => {
      const target = (item.rule.action as { target: Record<string, unknown> }).target;
      if (!(target.agentAdapter === "dsh" && target.botScopeId === selection[0] && target.botId === selection[1]
        && (!selection[2] || target.agentTargetId === selection[2]))) return false;
      if (!connection) return true;
      try {
        return connection === (target.instanceBinding ? "remote:" + bindingIdentity(target.instanceBinding) : "local:" + normalizeDsBotConnectionOrigin(target.dshBaseUrl));
      } catch { return false; }
    });
    let offset = 0;
    if (input.query.cursor) {
      let cursor: { revision?: string; selection?: unknown; offset?: number };
      try { cursor = JSON.parse(Buffer.from(String(input.query.cursor), "base64url").toString("utf8")); }
      catch { throw new ApiContractError(400, "DS_BOT_RULE_CURSOR_INVALID", "cursor", operationId); }
      if (!cursor || cursor.revision !== snapshot.revision || JSON.stringify(cursor.selection) !== JSON.stringify(selection)) throw new ApiContractError(409, "DS_BOT_RULE_CATALOG_CHANGED", "cursor", operationId);
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! > matches.length) throw new ApiContractError(400, "DS_BOT_RULE_CURSOR_INVALID", "cursor", operationId);
      offset = cursor.offset!;
    }
    const end = Math.min(offset + Number(input.query.limit ?? 25), matches.length);
    return { status: 200, headers: { "cache-control": "no-cache" }, body: { code: 0, data: {
      schemaVersion: "1", revision: snapshot.revision, refreshedAt: snapshot.refreshedAt, maxCacheAgeMs: 30_000, botScopeId: selection[0], botId: selection[1], items: matches.slice(offset, end), total: matches.length, warnings: snapshot.warnings,
      nextCursor: end < matches.length ? Buffer.from(JSON.stringify({ revision: snapshot.revision, selection, offset: end })).toString("base64url") : null
    } } };
  } }];
}
