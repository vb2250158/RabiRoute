export function cloneComputerValue<T>(value:T):T { return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T; }
/** View-only helpers: identities, settings, capabilities and work remain Manager-owned. */
export type ComputerTarget = {
  id: string; instanceId: string; ownerDeviceId?: string; name: string;
  kind: "host" | "node"; local: boolean; status: "online" | "offline" | "unknown";
  enabled?:boolean; computerSettings?:Record<string,unknown>; platform?: string; ownerName?: string; capabilities?: string[]; terminalShells?: string[]; issue?: string;
};
export function computerTargetKey(target: Pick<ComputerTarget, "ownerDeviceId" | "instanceId">): string {
  return JSON.stringify([target.ownerDeviceId || "", target.instanceId]);
}
export function stableComputerRows(previous: readonly ComputerTarget[], next: readonly ComputerTarget[]): ComputerTarget[] {
  const fresh = new Map(next.map(target => [target.id, target]));
  const result = previous.flatMap(target => { const value = fresh.get(target.id); fresh.delete(target.id); return value ? [value] : []; });
  return [...result, ...fresh.values()];
}
export function filterComputers(rows: readonly ComputerTarget[], query: string, kind: string, status: string): ComputerTarget[] {
  const text = query.trim().toLocaleLowerCase();
  return rows.filter(row => (kind === "all" || row.kind === kind) && (status === "all" || row.status === status)
    && (!text || [row.name, row.ownerName, row.platform].some(value => value?.toLocaleLowerCase().includes(text))));
}
export function computerDeepLink(query: Record<string, unknown>, rows: readonly ComputerTarget[]): string | undefined {
  const instanceId = typeof query.instanceId === "string" ? query.instanceId : undefined;
  const ownerDeviceId = typeof query.deviceId === "string" ? query.deviceId : "";
  return rows.find(row => instanceId ? row.instanceId === instanceId && (row.ownerDeviceId || "") === ownerDeviceId
    : !!ownerDeviceId && row.kind === "host" && row.ownerDeviceId === ownerDeviceId)?.id;
}
export type ComputerFieldSchema = { type?: string | string[]; title?: string; description?: string; default?: unknown; enum?: unknown[];
  minimum?: number; maximum?: number; unit?: string; properties?: Record<string, ComputerFieldSchema>; items?: ComputerFieldSchema; required?: string[]; anyOf?: ComputerFieldSchema[]; oneOf?: ComputerFieldSchema[] };
export function schemaDefault(schema: ComputerFieldSchema): unknown {
  if (schema.default !== undefined) return cloneComputerValue(schema.default);
  if (schema.type === "object" || schema.properties) { const entries = Object.entries(schema.properties || {}).map(([key, field]) => [key, schemaDefault(field)]).filter(([,value]) => value !== undefined); return entries.length ? Object.fromEntries(entries) : undefined; }
  return undefined;
}
export function readField(value: Record<string, unknown>, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined, value);
}
export function writeField(value: Record<string, unknown>, path: readonly string[], next: unknown): Record<string, unknown> {
  const copy = cloneComputerValue(value); let cursor = copy;
  for (const key of path.slice(0, -1)) { cursor[key] = { ...(cursor[key] as Record<string, unknown> || {}) }; cursor = cursor[key] as Record<string, unknown>; }
  cursor[path[path.length - 1]!] = next; return copy;
}
