import type { HomeDeviceDirectory } from "../../shared/homeDeviceDirectoryContract.js";
import type { XiaomiHomeResource } from "./managerApi.js";

// Fixed read-only template; callers cannot supply expressions or registry fields.
export const HOME_DEVICE_DIRECTORY_TEMPLATE = `{% set ns = namespace(rows=[]) %}
{% for s in states %}{% set id = device_id(s.entity_id) %}{% if id %}
{% set ns.rows = ns.rows + [{'entityId': s.entity_id, 'deviceId': id,
'displayName': device_attr(id, 'name_by_user') or device_attr(id, 'name') or id,
'model': device_attr(id, 'model') or '', 'manufacturer': device_attr(id, 'manufacturer') or '',
'areaName': area_name(id) or ''}] %}{% endif %}{% endfor %}{{ ns.rows | to_json }}`;

export function deviceDirectory(resources: XiaomiHomeResource[], rows: unknown): HomeDeviceDirectory<XiaomiHomeResource> {
  if (!Array.isArray(rows) || rows.length > 100_000) throw new Error("Invalid device registry result.");
  const resourceById = new Map(resources.map(resource => [resource.entityId, resource]));
  const devices = new Map<string, HomeDeviceDirectory<XiaomiHomeResource>["devices"][number]>();
  const assigned = new Set<string>();
  const text = (value: unknown) => typeof value === "string" ? value.slice(0, 512) : "";
  for (const row of rows) {
    if (!row || typeof row !== "object" || !/^[a-z0-9_.:-]{1,128}$/i.test(String(row.deviceId || ""))
      || typeof row.entityId !== "string") throw new Error("Invalid device registry entry.");
    const resource = resourceById.get(row.entityId);
    if (!resource || assigned.has(resource.entityId)) continue;
    let device = devices.get(row.deviceId);
    if (!device) {
      device = { deviceId: row.deviceId, displayName: text(row.displayName) || row.deviceId,
        model: text(row.model), manufacturer: text(row.manufacturer), areaName: text(row.areaName), resources: [] };
      devices.set(row.deviceId, device);
    }
    device.resources.push(resource); assigned.add(resource.entityId);
  }
  return { schemaVersion: 1, observedAt: new Date().toISOString(),
    devices: [...devices.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    unassignedResources: resources.filter(resource => !assigned.has(resource.entityId)) };
}
