import { createHash } from "node:crypto";
import { createRoleConfigurationOwner, type RoleConfigurationContext } from "./roleConfigurationOwner.js";
import { RoleLifecycleError } from "@rabiroute/host-api/roleLifecycle";
import { ReadSettingsError } from "@rabiroute/host-api/shared/readSettingsError";
import {
  ensureDefaultPersonaAutomations, personaAutomationRulesFromNotificationRules,
  type PersonaAutomationRuleDefinition
} from "@rabiroute/host-api/shared/gatewayConfigModel";
import { normalizeAgentDeliveryTarget, validateAgentDeliveryTarget } from "@rabiroute/host-api/shared/agentDeliveryTarget";
import type { RoleConfiguration } from "@rabiroute/host-api/shared/roleConfiguration";
import type { ApiOperationDefinition, ApiOperationInput, ApiOperationResult, ApiSchema } from "@rabiroute/host-api/manager/apiOperationContract";

const text = { type: "string" };
const object = { type: "object" };
const stringList = { type: "array", items: text };
const ruleFields = {
  name: text, enabled: { type: "boolean" }, sourceRouteIds: stringList,
  trigger: { type: "object", properties: {
    type: { enum: ["message", "schedule"] }, triggerIds: stringList, routeKinds: stringList,
    targetGroupId: text, targetUserId: text, allowedSpeakerNames: stringList, regex: text,
    schedule: { type: "object", properties: {
      id: text, name: text, enabled: { type: "boolean" }, type: { enum: ["interval", "daily_time", "once_at"] },
      intervalSeconds: { type: "number", exclusiveMinimum: 0 }, windowStartTime: text, windowEndTime: text,
      timeOfDay: text, timeOfDays: { type: "array", items: text, minItems: 1 }, onceAt: text
    }, additionalProperties: false }
  }, additionalProperties: false },
  action: { type: "object", properties: {
    type: { enum: ["deliver_agent", "run_script"] }, target: object,
    recentMessageLimit: { type: "integer", minimum: 0 }, message: text, template: text,
    scriptPath: text, arguments: stringList, timeoutSeconds: { type: "number", minimum: 5, maximum: 3600 }
  }, additionalProperties: false }
};
const ruleSchema = { type: "object", required: ["id", "trigger", "action"], properties: { id: text, ...ruleFields } };
type Action = "list" | "read" | "create" | "update" | "delete";
type RulePatch = Partial<PersonaAutomationRuleDefinition> & Record<string, unknown>;
type Command = { expectedRevision: string; rule?: RulePatch; patch?: RulePatch };
type Bound = ReturnType<ReturnType<typeof createRoleConfigurationOwner>["prepare"]>;

function rulesOf(config: RoleConfiguration): PersonaAutomationRuleDefinition[] {
  if (Array.isArray(config.automationRules)) for (const rule of config.automationRules) {
    if (!rule || typeof rule !== "object" || typeof rule.id !== "string" || !rule.id.trim()
      || !rule.trigger || !["message", "schedule"].includes(rule.trigger.type)
      || !rule.action || !["deliver_agent", "run_script"].includes(rule.action.type)) {
      throw new RoleLifecycleError("AUTOMATION_STORED_RULE_INVALID", "现有自动化规则损坏，请通过角色配置 PATCH 修正；本次未修改规则。", 400);
    }
  }
  try {
    const rules = config.automationRules === undefined && config.notificationRules !== undefined
      ? personaAutomationRulesFromNotificationRules(config.notificationRules)
      : ensureDefaultPersonaAutomations(config.automationRules);
    return rules.map(rule => rule.action.type === "deliver_agent"
      ? { ...rule, action: { ...rule.action, target: normalizeAgentDeliveryTarget(rule.action.target) } } : rule);
  } catch {
    throw new RoleLifecycleError("AUTOMATION_STORED_RULE_INVALID", "现有自动化规则损坏，请通过角色配置 PATCH 修正；本次未修改规则。", 400);
  }
}

function editableRules(config: RoleConfiguration): PersonaAutomationRuleDefinition[] {
  if (config.automationRules === undefined) return rulesOf(config);
  if (!Array.isArray(config.automationRules)) {
    throw new RoleLifecycleError("AUTOMATION_COLLECTION_INVALID", "automationRules 应为数组，请通过角色配置 PATCH 修正。", 400);
  }
  return [...config.automationRules];
}

function readableRules(config: RoleConfiguration) {
  if (!Array.isArray(config.automationRules)) return { rules: rulesOf(config), warnings: [] as { index: number; ruleId?: string; message: string }[] };
  const rules: PersonaAutomationRuleDefinition[] = [], warnings: { index: number; ruleId?: string; message: string }[] = [];
  for (const [index, rule] of config.automationRules.entries()) {
    try { rules.push(...rulesOf({ automationRules: [rule] })); }
    catch { warnings.push({ index, ...(typeof rule?.id === "string" ? { ruleId: rule.id } : {}), message: "该规则配置无效；其他规则仍可读取。" }); }
  }
  return { rules, warnings };
}

function mergeRule(current: PersonaAutomationRuleDefinition, patch: RulePatch): PersonaAutomationRuleDefinition {
  const trigger = patch.trigger ? { ...(patch.trigger.type && patch.trigger.type !== current.trigger?.type ? {} : current.trigger), ...patch.trigger } : current.trigger;
  if (current.trigger?.type === "schedule" && trigger?.type === "schedule" && patch.trigger?.type !== "message"
    && patch.trigger && "schedule" in patch.trigger && patch.trigger.schedule
    && (!patch.trigger.schedule.type || patch.trigger.schedule.type === current.trigger.schedule.type)) {
    trigger.schedule = { ...current.trigger.schedule, ...patch.trigger.schedule };
  }
  return { ...current, ...patch, id: current.id,
    trigger,
    ...(patch.action ? { action: { ...(patch.action.type && patch.action.type !== current.action?.type ? {} : current.action), ...patch.action } } : {})
  } as PersonaAutomationRuleDefinition;
}

function validateRule(rule: PersonaAutomationRuleDefinition): void {
  if (!rule.id.trim()) throw new RoleLifecycleError("AUTOMATION_ID_INVALID", "自动化 ID 不能为空。", 400);
  if (!rule.trigger || !["message", "schedule"].includes(rule.trigger.type)
    || !rule.action || !["deliver_agent", "run_script"].includes(rule.action.type)) {
    throw new RoleLifecycleError("AUTOMATION_RULE_INVALID", "请提供消息或定时触发条件，以及 Agent 或脚本动作。", 400);
  }
  if (rule.trigger.type === "message" && rule.trigger.regex) {
    try { new RegExp(rule.trigger.regex); }
    catch { throw new RoleLifecycleError("AUTOMATION_REGEX_INVALID", "消息匹配表达式无效。", 400); }
  }
  if (rule.trigger.type === "schedule") {
    const schedule = rule.trigger.schedule;
    if (!schedule || !["interval", "daily_time", "once_at"].includes(schedule.type)) {
      throw new RoleLifecycleError("AUTOMATION_SCHEDULE_REQUIRED", "定时触发需要明确的 schedule 配置。", 400);
    }
    if (schedule.type === "daily_time" && !(Array.isArray(schedule.timeOfDays) ? schedule.timeOfDays.length > 0 && schedule.timeOfDays.every(value => /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) : /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(schedule.timeOfDay ?? ""))
      || schedule.type === "once_at" && !Number.isFinite(Date.parse(schedule.onceAt ?? ""))) {
      throw new RoleLifecycleError("AUTOMATION_SCHEDULE_INVALID", "请提供有效的每日时间或一次性触发时间。", 400);
    }
  }
  if (rule.action.type === "deliver_agent") {
    if (!rule.action.target) throw new RoleLifecycleError("ROLE_TARGET_REQUIRED", "消息动作需要明确的 Agent 目标。", 400);
    try { validateAgentDeliveryTarget(normalizeAgentDeliveryTarget(rule.action.target)); }
    catch { throw new RoleLifecycleError("ROLE_TARGET_INVALID", "请输入有效的 Agent 目标。", 400); }
  }
  if (rule.action.type === "run_script" && !rule.action.scriptPath?.trim()) {
    throw new RoleLifecycleError("AUTOMATION_SCRIPT_REQUIRED", "脚本动作需要明确的脚本路径。", 400);
  }
}

function failure(error: unknown, bound?: Bound): ApiOperationResult {
  const mutationOutcome = bound?.mutationOutcome() ?? "not_started";
  return { status: error instanceof RoleLifecycleError ? error.status : (error as { statusCode?: number })?.statusCode ?? 500,
    mutationOutcome, headers: { "cache-control": "no-store" }, body: {
      code: -1, error: error instanceof RoleLifecycleError || error instanceof ReadSettingsError ? error.code : "AUTOMATION_OPERATION_FAILED",
      message: error instanceof RoleLifecycleError || error instanceof ReadSettingsError ? error.message : "自动化操作未确认，请保留原操作键和请求内容。",
      mutationOutcome, ...(mutationOutcome === "unknown" ? { uncertain: true } : {})
    } };
}

/** Item commands share the role owner's lock, CAS and original request receipts. */
export function createRoleAutomationOperations(context: RoleConfigurationContext): readonly ApiOperationDefinition[] {
  const owner = createRoleConfigurationOwner(context);
  const entries: readonly [Action, "GET" | "POST" | "PATCH" | "DELETE", string][] = [
    ["list", "GET", "/api/roles/:roleId/automation-rules"],
    ["read", "GET", "/api/roles/:roleId/automation-rules/:ruleId"],
    ["create", "POST", "/api/roles/:roleId/automation-rules"],
    ["update", "PATCH", "/api/roles/:roleId/automation-rules/:ruleId"],
    ["delete", "DELETE", "/api/roles/:roleId/automation-rules/:ruleId"]
  ];
  return entries.map(([action, method, pathTemplate]) => {
    const mutation = method !== "GET", item = pathTemplate.endsWith(":ruleId");
    const data: ApiSchema = { type: "object", required: ["roleId", "revision", ...(action === "list" ? ["rules"] : action === "delete" ? ["ruleId", "deleted"] : ["rule"])], properties: {
      roleId: text, revision: text, rules: { type: "array", items: ruleSchema }, rule: ruleSchema, ruleId: text, deleted: { const: true },
      warnings: { type: "array", items: { type: "object", required: ["index", "message"], properties: { index: { type: "integer", minimum: 0 }, ruleId: text, message: text } } }
    } };
    const prepare = (input: Omit<ApiOperationInput, "body">) => {
      let bound: Bound;
      try { bound = owner.prepare(input.request, input.signal); }
      catch (error) { input.signal?.throwIfAborted(); return failure(error); }
      return async (parsed: ApiOperationInput): Promise<ApiOperationResult> => {
        try {
          const roleId = parsed.path.roleId, key = String(parsed.request.headers["idempotency-key"] ?? "");
          const body = parsed.body as Command;
          const ruleId = action === "create" ? body.rule?.id?.trim()
            ?? `automation-${createHash("sha256").update(JSON.stringify([roleId, key])).digest("hex").slice(0, 24)}` : parsed.path.ruleId?.trim();
          const selected = mutation ? await bound.command(roleId, "config", {
            expectedRevision: body.expectedRevision,
            requestCommand: { type: `automation-${action}`, ruleId, ...(action === "create" ? { rule: body.rule } : action === "update" ? { patch: body.patch } : {}) }
          }, key, (config: RoleConfiguration) => {
            const rules = editableRules(config), index = rules.findIndex(rule => typeof rule?.id === "string" && rule.id.trim() === ruleId);
            if (action === "create") {
              if (index >= 0) throw new RoleLifecycleError("AUTOMATION_EXISTS", "该自动化 ID 已存在。", 409);
              const rule = { ...body.rule, id: ruleId } as PersonaAutomationRuleDefinition;
              validateRule(rule);
              const panelIndex = rules.findIndex(value => value?.id === "role-panel-message");
              if (panelIndex >= 0) rules.splice(panelIndex, 0, rule);
              else rules.push(rule);
            } else {
              if (index < 0) throw new RoleLifecycleError("AUTOMATION_NOT_FOUND", "自动化规则不存在。", 404);
              if (action === "delete") rules.splice(index, 1);
              else { const rule = mergeRule(rules[index], body.patch!); validateRule(rule); rules[index] = rule; }
            }
            return { ...config, automationRules: rules };
          }) : await bound.detail(roleId);
          bound.assertCurrent();
          const result = selected as { revision: string; config: RoleConfiguration };
          const snapshot = readableRules(result.config);
          let rules = snapshot.rules;
          const rule = rules.find(value => value.id === ruleId);
          if (action === "read" && snapshot.warnings.some(warning => warning.ruleId === ruleId)) {
            throw new RoleLifecycleError("AUTOMATION_RULE_INVALID", "该规则配置无效，请通过角色配置接口修正。", 409);
          }
          if (action === "read" && !rule) throw new RoleLifecycleError("AUTOMATION_NOT_FOUND", "自动化规则不存在。", 404);
          if (action === "list") {
            const query = String(parsed.query.query ?? "").toLocaleLowerCase(), enabled = parsed.query.enabled;
            rules = rules.filter(rule => (!query || `${rule.id} ${rule.name ?? ""}`.toLocaleLowerCase().includes(query))
              && (enabled === undefined || (rule.enabled !== false) === (enabled === "true")));
          }
          return { status: action === "create" ? 201 : 200, mutationOutcome: bound.mutationOutcome(), headers: { "cache-control": "no-store" }, body: {
            code: 0, data: { roleId, revision: result.revision, ...(action === "list" ? { rules, warnings: snapshot.warnings } : action === "delete" ? { ruleId, deleted: true } : { rule }) },
            ...(mutation ? { operationId: key, state: "committed" } : {})
          } };
        } catch (error) { parsed.signal?.throwIfAborted(); return failure(error, bound); }
      };
    };
    return { contract: {
      operationId: `manager.roles.automations.${action}`, contractVersion: "1.0.0", method, pathTemplate, exposure: "public", transport: "http",
      description: "Query or change one role automation rule through the original configuration owner; message and schedule triggers, Agent and script actions use the same saved rules as the role editor.",
      request: {
        path: { type: "object", required: ["roleId", ...(item ? ["ruleId"] : [])], additionalProperties: false, properties: {
          roleId: { type: "string", pattern: "^[\\p{L}\\p{N}_-]+$", minLength: 1 }, ...(item ? { ruleId: { type: "string", minLength: 1 } } : {})
        } },
        query: { type: "object", additionalProperties: false, properties: action === "list" ? { query: text, enabled: { enum: ["true", "false"] } } : {} },
        headers: mutation ? { type: "object", required: ["idempotency-key"], properties: { "idempotency-key": { type: "string", pattern: "^[A-Za-z0-9:._-]{1,128}$" } } } : object,
        body: !mutation ? { kind: "none", allowIgnoredBody: true } : { kind: "json", allowAnyContentType: true, maxBytes: 0,
          schema: { type: "object", required: ["expectedRevision", ...(action === "create" ? ["rule"] : action === "update" ? ["patch"] : [])], additionalProperties: false, properties: {
            expectedRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
            ...(action === "create" ? { rule: { type: "object", required: ["trigger", "action"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, ...ruleFields } } }
              : action === "update" ? { patch: { type: "object", additionalProperties: false, properties: ruleFields } } : {})
          } }
        }
      },
      responses: { [action === "create" ? "201" : "200"]: { mediaType: "application/json", schema: { type: "object", required: ["code", "data"], properties: { code: { const: 0 }, data, operationId: text, state: { const: "committed" } } } },
        ...Object.fromEntries([400,403,404,409,410,412,413,500,503].map(status => [status, { mediaType: "application/json", schema: { type: "object", required: ["code", "error", "message"], properties: { code: { const: -1 }, error: text, message: text, uncertain: { type: "boolean" }, mutationOutcome: { enum: ["not_started", "unknown"] } } } }])) },
      effects: { mode: mutation ? "native-role-lifecycle-mutation" : "read", description: mutation ? "Persist a single rule change using the role lock, configuration revision, atomic write and operation receipt; preserve other rules and all unrelated configuration. Saving a rule does not itself invoke its action." : "Read the role owner's current configuration without sending messages or running actions." },
      recovery: { strategy: mutation ? "native-role-receipt" : "read-current-role", ...(mutation ? { idempotencyHeader: "Idempotency-Key" } : {}), description: "Writes require the configuration revision from GET /api/roles/:roleId/configuration or the automation response. Retain the same key, role, rule and original body after an unknown result. A repeated committed request returns its original receipt; never reconstruct it from newer configuration." },
      validators: [{ id: "original-role-owner", description: "Reuse original connection/generation admission, archived-role admission, locked CAS, normalization, explicit Agent target and operation receipt. Rule IDs remain stable across edits and retries." }]
    }, prepare, handler: async input => { const bound = prepare(input); return typeof bound === "function" ? bound(input) : bound; } } satisfies ApiOperationDefinition;
  });
}
