import http from "node:http";
import { randomUUID } from "node:crypto";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import type { DesktopPetSettingsAccess, DesktopPetEventPublisher } from "./desktopPetRoutes.js";

type MotionTarget = { kind: "position"; x: number; y: number } | {
  kind: "active-window" | "screen-corner"; corner: string; screenName?: string;
};
type MotionRequest = { requestId: string; mode: "auto" | "walk" | "teleport"; target: MotionTarget };
type Receipt = MotionRequest & { personaId: string; status: string; createdAt: number; updatedAt: number;
  reason?: string; position?: { x: number; y: number }; destination?: { x: number; y: number }; travelKind?: string };
type Entry = { receipt: Receipt; token?: string; fingerprint: string };
const stores = new WeakMap<DesktopPetSettingsAccess, Map<string, Entry>>();
const corners = new Set(["bottom-right", "bottom-left", "top-right", "top-left"]);
const terminal = new Set(["succeeded", "failed", "cancelled", "uncertain"]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object.");
  return value as Record<string, unknown>;
}
function point(value: unknown): { x: number; y: number } {
  const row = object(value);
  if (![row.x, row.y].every(n => typeof n === "number" && Number.isInteger(n) && Math.abs(n) <= 100000)) {
    throw new Error("x/y must be integer logical desktop pixels within +/-100000.");
  }
  return { x: row.x as number, y: row.y as number };
}
export function parseDesktopPetMotion(value: unknown): MotionRequest {
  const body = object(value), target = object(body.target);
  if (Object.keys(body).some(key => !["requestId", "target", "mode"].includes(key))) throw new Error("Unknown motion field.");
  if (typeof body.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(body.requestId)) throw new Error("requestId must be 8-128 ASCII identifier characters.");
  const mode = body.mode ?? "auto";
  if (!["auto", "walk", "teleport"].includes(String(mode))) throw new Error("Invalid travel mode.");
  let normalized: MotionTarget;
  if (target.kind === "position") {
    if (Object.keys(target).some(key => !["kind", "x", "y"].includes(key))) throw new Error("Unknown position field.");
    normalized = { kind: "position", ...point(target) };
  } else if (target.kind === "active-window" || target.kind === "screen-corner") {
    if (!corners.has(String(target.corner))) throw new Error("Invalid corner.");
    if (Object.keys(target).some(key => !["kind", "corner", "screenName"].includes(key))) throw new Error("Unknown corner field.");
    if (target.screenName !== undefined && (target.kind !== "screen-corner" || typeof target.screenName !== "string" || !target.screenName.length || target.screenName.length > 200)) throw new Error("Invalid screenName.");
    normalized = { kind: target.kind, corner: String(target.corner), ...(target.screenName ? { screenName: target.screenName as string } : {}) };
  } else throw new Error("Invalid target kind.");
  return { requestId: body.requestId, mode: mode as MotionRequest["mode"], target: normalized };
}
async function body(request: http.IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error("Motion body exceeds 8 KiB.");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function reply(response: http.ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}
export function handleDesktopPetMotion(request: http.IncomingMessage, url: URL, response: http.ServerResponse,
  settings?: DesktopPetSettingsAccess, publish?: DesktopPetEventPublisher): boolean {
  const match = url.pathname.match(/^\/api\/desktop-pet\/roles\/([^/]+)\/motion(?:\/(runtime|[A-Za-z0-9_.-]+))?$/);
  if (!match) return false;
  if (!settings) { reply(response, 503, { code: -1, message: "Desktop settings unavailable." }); return true; }
  let personaId: string;
  try { personaId = decodeURIComponent(match[1]); } catch { reply(response, 400, { code: -1, message: "Invalid persona." }); return true; }
  if (!sanitizeRoleId(personaId)) { reply(response, 400, { code: -1, message: "Invalid persona." }); return true; }
  const store = stores.get(settings) ?? new Map<string, Entry>(); stores.set(settings, store);
  const now = Date.now();
  for (const [key, entry] of store) {
    const receipt = entry.receipt;
    if (!terminal.has(receipt.status) && now - receipt.updatedAt > (receipt.status === "accepted" ? 20000 : 30000)) {
      receipt.status = receipt.status === "accepted" ? "failed" : "uncertain";
      receipt.reason = "Desktop runtime did not confirm execution within the deadline."; receipt.updatedAt = now;
    }
    if (terminal.has(receipt.status) && now - receipt.updatedAt > 3600000) store.delete(key);
  }
  const suffix = match[2], key = `${personaId}:${suffix}`;
  if (suffix && suffix !== "runtime" && request.method === "GET") {
    const entry = store.get(key);
    reply(response, entry ? 200 : 404, entry ? { code: 0, data: entry.receipt } : { code: -1, message: "Receipt not found in this Manager generation (retained for one hour)." });
    return true;
  }
  if (request.method !== "POST" || (suffix && suffix !== "runtime")) {
    reply(response, 405, { code: -1, message: "Method not allowed." }); return true;
  }
  void body(request).then(raw => {
    if (suffix === "runtime") {
      // Runtime acknowledgments are not part of the Agent API catalog. A claim
      // token prevents other renderers or stale completions changing the receipt.
      const input = object(raw);
      if (input.requestId) {
        const entry = store.get(`${personaId}:${input.requestId}`);
        if (!entry || !entry.token || input.token !== entry.token) { reply(response, 409, { code: -1, message: "Stale runtime claim." }); return; }
        if (terminal.has(entry.receipt.status)) { reply(response, 200, { code: 0, data: entry.receipt }); return; }
        if (!["running", "succeeded", "failed", "cancelled"].includes(String(input.status))) throw new Error("Invalid runtime result.");
        const position = point(input.position);
        if (input.status === "running") {
          // A slow frame-driven walk may last more than the receipt deadline.
          // Only the current renderer claim can renew liveness; it is not arrival.
          if (!entry.receipt.position || position.x !== entry.receipt.position.x || position.y !== entry.receipt.position.y) {
            entry.receipt.position = position;
            entry.receipt.updatedAt = Date.now();
          }
          reply(response, 200, { code: 0, data: entry.receipt }); return;
        }
        const destination = input.destination ? point(input.destination) : undefined;
        if (input.status === "succeeded" && (!destination || Math.hypot(position.x - destination.x, position.y - destination.y) >= 8)) throw new Error("Arrival position does not match destination.");
        Object.assign(entry.receipt, { status: input.status, position, destination,
          reason: typeof input.reason === "string" ? input.reason.slice(0, 300) : undefined,
          travelKind: ["move", "teleport"].includes(String(input.travelKind)) ? input.travelKind : undefined, updatedAt: Date.now() });
        publish?.("desktop_pet_motion_result", entry.receipt);
        reply(response, 200, { code: 0, data: entry.receipt }); return;
      }
      const entry = [...store.values()].find(item => item.receipt.personaId === personaId && item.receipt.status === "accepted");
      if (!entry) { reply(response, 200, { code: 0, data: null }); return; }
      entry.token = randomUUID(); entry.receipt.status = "running"; entry.receipt.updatedAt = Date.now();
      reply(response, 200, { code: 0, data: { ...entry.receipt, token: entry.token } }); return;
    }
    const motion = parseDesktopPetMotion(raw);
    if (request.headers["idempotency-key"] !== motion.requestId) throw new Error("Idempotency-Key must equal requestId.");
    const fingerprint = JSON.stringify(motion), requestKey = `${personaId}:${motion.requestId}`;
    const existing = store.get(requestKey);
    if (existing) { reply(response, existing.fingerprint === fingerprint ? 200 : 409,
      existing.fingerprint === fingerprint ? { code: 0, data: existing.receipt } : { code: -1, message: "requestId already has a different request." }); return; }
    const binding = settings.read().pets[personaId];
    if (!binding?.enabled || !binding.packId || binding.locked) { reply(response, 409, { code: -1, message: "Pet is disabled, unbound or position-locked." }); return; }
    if ([...store.values()].some(item => item.receipt.personaId === personaId && !terminal.has(item.receipt.status))) {
      reply(response, 409, { code: -1, message: "Pet already has an active Agent motion." }); return;
    }
    if (store.size >= 1000) { reply(response, 503, { code: -1, message: "Motion receipt capacity reached; retry after expiry." }); return; }
    const receipt: Receipt = { ...motion, personaId, status: "accepted", createdAt: now, updatedAt: now };
    store.set(requestKey, { receipt, fingerprint });
    publish?.("desktop_pet_motion_requested", { personaId, requestId: motion.requestId });
    reply(response, 202, { code: 0, data: receipt });
  }).catch(error => reply(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) }));
  return true;
}
