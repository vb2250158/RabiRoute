import type { ApiOperationResult } from "./apiOperationContract.js";
import { randomUUID } from "node:crypto";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import type { DesktopPetSettingsAccess, DesktopPetEventPublisher } from "./desktopPetRoutes.js";

type MotionTarget = { kind: "position"; x: number; y: number } | {
  kind: "active-window" | "screen-corner"; corner: string; screenName?: string;
};
type MotionRequest = { requestId: string; mode: "auto" | "walk" | "run" | "teleport"; target: MotionTarget };
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
export const DESKTOP_PET_MOTION_SCHEMA = {
  type: "object", required: ["requestId", "target"], additionalProperties: false,
  properties: {
    requestId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$" },
    mode: { description: "Optional; defaults to auto. Native String(value) must equal auto, walk, run or teleport. The native parser retains its existing coercion." },
    target: { oneOf: [
      { type: "object", required: ["kind", "x", "y"], additionalProperties: false, properties: { kind: { const: "position" }, x: { type: "integer", minimum: -100000, maximum: 100000 }, y: { type: "integer", minimum: -100000, maximum: 100000 } } },
      { type: "object", required: ["kind", "corner"], additionalProperties: false, properties: { kind: { const: "active-window" }, corner: { description: "Native String(value) selects bottom-right, bottom-left, top-right or top-left." } } },
      { type: "object", required: ["kind", "corner"], additionalProperties: false, properties: { kind: { const: "screen-corner" }, corner: { description: "Native String(value) selects bottom-right, bottom-left, top-right or top-left." }, screenName: { type: "string", minLength: 1, maxLength: 200 } } }
    ] }
  }
} as const;
export function parseDesktopPetMotion(value: unknown): MotionRequest {
  const body = object(value), target = object(body.target);
  if (Object.keys(body).some(key => !Object.keys(DESKTOP_PET_MOTION_SCHEMA.properties).includes(key))) throw new Error("Unknown motion field.");
  if (typeof body.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(body.requestId)) throw new Error("requestId must be 8-128 ASCII identifier characters.");
  const mode = body.mode ?? "auto";
  if (!["auto", "walk", "run", "teleport"].includes(String(mode))) throw new Error("Invalid travel mode.");
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

function result(status: number, body: unknown): ApiOperationResult {
  return { status, body, headers: { "cache-control": "no-store" } };
}

/** The original generation-scoped motion ledger; HTTP decoding and routing belong to executable operations. */
export function executeDesktopPetMotion(
  action: "submit" | "runtime" | "receipt",
  personaId: string,
  raw: unknown,
  requestId: string | undefined,
  idempotencyKey: string | string[] | undefined,
  settings?: DesktopPetSettingsAccess,
  publish?: DesktopPetEventPublisher
): ApiOperationResult {
  if (!settings) return result(503, { code: -1, message: "Desktop settings unavailable." });
  if (!sanitizeRoleId(personaId)) return result(400, { code: -1, message: "Invalid persona." });
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

  if (action === "receipt") {
    const entry = store.get(personaId + ":" + requestId);
    return result(entry ? 200 : 404, entry ? { code: 0, data: entry.receipt } : { code: -1, message: "Receipt not found in this Manager generation (retained for one hour)." });
  }
  try {

    if (action === "runtime") {
      // The original renderer claim token prevents stale or unrelated completions
      // from changing the generation-scoped receipt.
      const input = object(raw);
      if (input.requestId) {
        const entry = store.get(`${personaId}:${input.requestId}`);
        if (!entry || !entry.token || input.token !== entry.token) { return result(409, { code: -1, message: "Stale runtime claim." }); }
        if (terminal.has(entry.receipt.status)) { return result(200, { code: 0, data: entry.receipt }); }
        if (!["running", "succeeded", "failed", "cancelled"].includes(String(input.status))) throw new Error("Invalid runtime result.");
        const position = point(input.position);
        if (input.status === "running") {
          // Frame-driven locomotion may last more than the receipt deadline.
          // Only the current renderer claim can renew liveness; it is not arrival.
          if (!entry.receipt.position || position.x !== entry.receipt.position.x || position.y !== entry.receipt.position.y) {
            entry.receipt.position = position;
            entry.receipt.updatedAt = Date.now();
          }
          return result(200, { code: 0, data: entry.receipt });
        }
        const destination = input.destination ? point(input.destination) : undefined;
        if (input.status === "succeeded" && (!destination || Math.hypot(position.x - destination.x, position.y - destination.y) >= 8)) throw new Error("Arrival position does not match destination.");
        Object.assign(entry.receipt, { status: input.status, position, destination,
          reason: typeof input.reason === "string" ? input.reason.slice(0, 300) : undefined,
          travelKind: ["move", "run", "teleport"].includes(String(input.travelKind)) ? input.travelKind : undefined, updatedAt: Date.now() });
        publish?.("desktop_pet_motion_result", entry.receipt);
        return result(200, { code: 0, data: entry.receipt });
      }
      const entry = [...store.values()].find(item => item.receipt.personaId === personaId && item.receipt.status === "accepted");
      if (!entry) { return result(200, { code: 0, data: null }); }
      entry.token = randomUUID(); entry.receipt.status = "running"; entry.receipt.updatedAt = Date.now();
      return result(200, { code: 0, data: { ...entry.receipt, token: entry.token } });
    }
    const motion = parseDesktopPetMotion(raw);
    if (idempotencyKey !== motion.requestId) throw new Error("Idempotency-Key must equal requestId.");
    const fingerprint = JSON.stringify(motion), requestKey = `${personaId}:${motion.requestId}`;
    const existing = store.get(requestKey);
    if (existing) { return result(existing.fingerprint === fingerprint ? 200 : 409,
      existing.fingerprint === fingerprint ? { code: 0, data: existing.receipt } : { code: -1, message: "requestId already has a different request." }); }
    const binding = settings.read().pets[personaId];
    if (!binding?.enabled || !binding.packId || binding.locked) { return result(409, { code: -1, message: "Pet is disabled, unbound or position-locked." }); }
    if ([...store.values()].some(item => item.receipt.personaId === personaId && !terminal.has(item.receipt.status))) {
      return result(409, { code: -1, message: "Pet already has an active Agent motion." });
    }
    if (store.size >= 1000) { return result(503, { code: -1, message: "Motion receipt capacity reached; retry after expiry." }); }
    const receipt: Receipt = { ...motion, personaId, status: "accepted", createdAt: now, updatedAt: now };
    store.set(requestKey, { receipt, fingerprint });
    publish?.("desktop_pet_motion_requested", { personaId, requestId: motion.requestId });
    return result(202, { code: 0, data: receipt });

  } catch (error) { return result(400, { code: -1, message: error instanceof Error ? error.message : String(error) }); }
}
