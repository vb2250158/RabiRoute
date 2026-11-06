import type { PersonaAutomationRuleDefinition } from "../../../../../ribiwebgui/src/types";
import type { HistoryQqRoute, QqDirectoryContact } from "@shared/qqConversationHistory";

export type AutomationQqDirectory = {
  routeId: string;
  instanceId: string;
  accountId: string;
  entries: QqDirectoryContact[];
};
export type AutomationQqConversation = { kind: "group" | "private"; id: string; name: string };
const groupKinds = new Set(["direct_at", "direct_reply", "indirect_reply", "group_message"]);
const qqId = (value: unknown): string | undefined => typeof value === "string" && /^[1-9]\d*$/.test(value.trim()) ? value.trim() : undefined;

/** A name/regex/voice speaker filter never establishes a QQ account identity. */
export function automationQqTarget(rule: PersonaAutomationRuleDefinition): Omit<AutomationQqConversation, "name"> | undefined {
  if (rule.trigger.type !== "message") return;
  const kinds = rule.trigger.routeKinds ?? [];
  if (!kinds.length) return;
  const trigger = rule.trigger as typeof rule.trigger & { targetUserId?: string };
  const groupId = qqId(trigger.targetGroupId), userId = qqId(trigger.targetUserId);
  if (groupId && !userId && kinds.every(kind => groupKinds.has(kind))) return { kind: "group", id: groupId };
  if (userId && !groupId && kinds.every(kind => kind === "private")) return { kind: "private", id: userId };
}

function scopedRoutes(rule: PersonaAutomationRuleDefinition, routes: readonly HistoryQqRoute[]): HistoryQqRoute[] | undefined {
  const scope = rule.sourceRouteIds ?? [];
  if (scope.some(id => !routes.some(route => route.routeId === id))) return;
  return scope.length ? routes.filter(route => scope.includes(route.routeId)) : [...routes];
}

/** Accept a directory only for the requested Route, instance and a proven logged-in account. */
export function automationQqDirectory(route: HistoryQqRoute, value: unknown): AutomationQqDirectory | undefined {
  if (!value || typeof value !== "object") return;
  const raw = value as { instanceId?: unknown; account?: { userId?: unknown }; entries?: unknown; warnings?: unknown };
  const instanceId = typeof raw.instanceId === "string" ? raw.instanceId : "";
  const accountId = qqId(raw.account?.userId);
  if (!instanceId || !accountId || route.instanceId && route.instanceId !== instanceId || !Array.isArray(raw.entries)) return;
  const warnings = Array.isArray(raw.warnings) ? raw.warnings : [];
  const entries = raw.entries.filter((item): item is QqDirectoryContact => {
    if (!item || typeof item !== "object") return false;
    const contact = item as Partial<QqDirectoryContact>;
    return (contact.kind === "group" || contact.kind === "private") && Boolean(qqId(contact.target))
      && typeof contact.name === "string" && Boolean(contact.name.trim())
      && !warnings.includes(contact.kind === "group" ? "QQ_GROUP_LIST_UNAVAILABLE" : "QQ_FRIEND_LIST_UNAVAILABLE");
  });
  return { routeId: route.routeId, instanceId, accountId, entries };
}

function contactsFor(rule: PersonaAutomationRuleDefinition, routes: readonly HistoryQqRoute[], directories: readonly AutomationQqDirectory[]) {
  const scope = scopedRoutes(rule, routes);
  if (!scope?.length) return;
  const selected = scope.map(route => directories.find(directory => directory.routeId === route.routeId
    && (!route.instanceId || directory.instanceId === route.instanceId)));
  if (selected.some(directory => !directory)) return;
  return selected as AutomationQqDirectory[];
}

export function automationRuleConversation(rule: PersonaAutomationRuleDefinition, routes: readonly HistoryQqRoute[], directories: readonly AutomationQqDirectory[]): AutomationQqConversation | undefined {
  const target = automationQqTarget(rule);
  if (!target) return;
  const selected = contactsFor(rule, routes, directories);
  if (!selected) return;
  const matches = selected.map(directory => directory.entries.filter(contact => contact.kind === target.kind && contact.target === target.id));
  if (matches.some(entries => !entries.length)) return;
  const names = new Set(matches.flat().map(contact => contact.name.trim()));
  return { ...target, name: names.size === 1 ? [...names][0]! : target.id };
}

/** Choices remain keyed by QQ ID; cross-account aliases cannot select another person. */
export function automationQqContactChoices(kind: "group" | "private", rule: PersonaAutomationRuleDefinition | null, routes: readonly HistoryQqRoute[], directories: readonly AutomationQqDirectory[]): Array<{ title: string; value: string }> {
  if (!rule) return [];
  const selected = contactsFor(rule, routes, directories);
  if (!selected) return [];
  const ids = new Set(selected.flatMap(directory => directory.entries.filter(contact => contact.kind === kind).map(contact => contact.target)));
  return [...ids].map(id => {
    const names = new Set(selected.flatMap(directory => directory.entries.filter(contact => contact.kind === kind && contact.target === id).map(contact => contact.name.trim())));
    const name = names.size === 1 ? [...names][0]! : id;
    return { title: name === id ? id : `${name} · ${id}`, value: id };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

export function automationPrivateContactChoices(rule: PersonaAutomationRuleDefinition | null, routes: readonly HistoryQqRoute[], directories: readonly AutomationQqDirectory[]) {
  return automationQqContactChoices("private", rule, routes, directories);
}
