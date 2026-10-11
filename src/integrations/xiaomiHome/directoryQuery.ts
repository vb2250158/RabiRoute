import type { HomeDirectoryPage, HomeResourceSummary, HomeDeviceSummary } from "../../shared/homeDeviceQueryContract.js";
import type { HomeDeviceDirectory } from "../../shared/homeDeviceDirectoryContract.js";
import { XiaomiHomeManagerApiError, type XiaomiHomeResource } from "./managerApi.js";

export type HomeDirectoryQuery = {
  q: string; kind: string; available?: boolean; deviceId: string;
  view: "summary" | "detail"; includeActions: boolean; offset: number; limit: number;
};
type Device = HomeDeviceDirectory<XiaomiHomeResource>["devices"][number];

/** Validate wire query parameters before contacting the provider. */
export function parseHomeDirectoryQuery(params: URLSearchParams, scope: "devices" | "resources"): HomeDirectoryQuery {
  const allowed = ["q", "kind", "available", "view", "offset", "limit", ...(scope === "resources" ? ["deviceId", "includeActions"] : [])];
  const invalid = () => { throw new XiaomiHomeManagerApiError(400, "xiaomi_home_query_invalid", "Use q (up to 256 characters), kind, available=0|1, view=summary|detail, offset and limit=1..50; resource queries also accept deviceId and includeActions=0|1."); };
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) invalid();
  const integer = (key: string, fallback: number, maximum: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(raw)) return invalid();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > maximum || key === "limit" && value < 1) return invalid();
    return value;
  };
  const q = (params.get("q") || "").trim();
  const kind = params.get("kind") || "";
  const deviceId = params.get("deviceId") || "";
  if (q.length > 256 || kind && !/^[a-z0-9_]{1,64}$/.test(kind)
    || deviceId && !/^[a-z0-9_.:-]{1,128}$/i.test(deviceId)) invalid();
  for (const key of ["available", "includeActions"]) if (params.has(key) && !["0", "1"].includes(params.get(key)!)) invalid();
  const includeActions = params.get("includeActions") === "1";
  const view = params.get("view") || (includeActions ? "detail" : "summary");
  if (!["summary", "detail"].includes(view) || includeActions && view !== "detail") invalid();
  return { q, kind, deviceId, available: params.has("available") ? params.get("available") === "1" : undefined,
    view: view as "summary" | "detail", includeActions, offset: integer("offset", 0, 1_000_000), limit: integer("limit", 20, 50) };
}

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
const deviceText = (device: Device) => [device.deviceId, device.displayName, device.areaName, device.model, device.manufacturer].join(" ");
const resourceText = (resource: XiaomiHomeResource) => [resource.resourceId, resource.displayName, resource.kind, resource.state, JSON.stringify(resource.attributes)].join(" ");
function matchesText(text: string, q: string): boolean {
  const normalized = normalize(text);
  return normalize(q).split(/\s+/).filter(Boolean).every(term => normalized.includes(term));
}
function matchesResource(resource: XiaomiHomeResource, query: HomeDirectoryQuery): boolean {
  return (!query.kind || resource.kind === query.kind) && (query.available === undefined || resource.available === query.available);
}

export function homeResourceSummary(resource: XiaomiHomeResource): HomeResourceSummary {
  return { resourceId: resource.resourceId, entityId: resource.entityId, displayName: resource.displayName.slice(0, 128), kind: resource.kind, available: resource.available };
}
export function homeDeviceSummary(device: Device): HomeDeviceSummary {
  return { deviceId: device.deviceId, displayName: device.displayName.slice(0, 128), model: device.model.slice(0, 128),
    manufacturer: device.manufacturer.slice(0, 128), areaName: device.areaName.slice(0, 128),
    resourceCount: device.resources.length, availableResourceCount: device.resources.filter(resource => resource.available).length,
    kinds: [...new Set(device.resources.map(resource => resource.kind))].sort(),
    resourcesPath: `/api/agent/xiaomi-home/resources?deviceId=${encodeURIComponent(device.deviceId)}` };
}

/** Summary pages also have a 6 KB item budget, so large names cannot fill a tool result. */
export function homeDirectoryPage<T>(items: T[], query: HomeDirectoryQuery): HomeDirectoryPage<T> {
  const page: T[] = [];
  let bytes = 0;
  for (const item of items.slice(query.offset, query.offset + query.limit)) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (query.view === "summary" && page.length && bytes + size > 6000) break;
    page.push(item); bytes += size;
  }
  const end = query.offset + page.length;
  return { schemaVersion: 1, view: query.view, observedAt: new Date().toISOString(), items: page,
    total: items.length, offset: query.offset, limit: query.limit, nextOffset: end < items.length ? end : null };
}

export function queryHomeDevices(directory: HomeDeviceDirectory<XiaomiHomeResource>, query: HomeDirectoryQuery) {
  const matches = directory.devices.filter(device => device.resources.some(resource => matchesResource(resource, query))
    && matchesText(deviceText(device) + " " + device.resources.map(resourceText).join(" "), query.q))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  return { ...homeDirectoryPage(matches.map(device => query.view === "detail" ? device : homeDeviceSummary(device)), query),
    unassignedResourceCount: directory.unassignedResources.length,
    unassignedResourcesPath: "/api/agent/xiaomi-home/resources?deviceId=unassigned" };
}

export function filterHomeResources(resources: XiaomiHomeResource[], query: HomeDirectoryQuery, directory?: HomeDeviceDirectory<XiaomiHomeResource>): XiaomiHomeResource[] {
  const deviceByEntityId = new Map<string, Device>();
  for (const device of directory?.devices || []) for (const resource of device.resources) deviceByEntityId.set(resource.entityId, device);
  if (query.deviceId && query.deviceId !== "unassigned" && !directory?.devices.some(device => device.deviceId === query.deviceId)) {
    throw new XiaomiHomeManagerApiError(404, "xiaomi_home_device_not_found", "Device was not found in the current registry.");
  }
  return resources.filter(resource => {
    const device = deviceByEntityId.get(resource.entityId);
    return (!query.deviceId || (query.deviceId === "unassigned" ? !device : device?.deviceId === query.deviceId))
      && matchesResource(resource, query) && matchesText(resourceText(resource) + " " + (device ? deviceText(device) : ""), query.q);
  }).sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}
