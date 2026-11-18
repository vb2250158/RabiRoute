import type http from "node:http";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import { MESSAGE_EVENT_CATEGORIES, type MessageEventCategory } from "../shared/personaEventTypes.js";
import { ROLE_CONTEXT_ROUTE_HEADER, ROLE_CONTEXT_MANAGER_HEADER, ROLE_CONTEXT_CAPABILITY_HEADER, ROLE_CONTEXT_GENERATION_HEADER } from "./roleContextProjection.js";
import type { AllDayRecordingService } from "./allDayRecording.js";

export const ALL_DAY_MESSAGE_INGRESS = "/api/internal/all-day-recording/message";
type Message = { roleId: string; category: MessageEventCategory; id: string; time: number; text: string };
type Identity = { applicationGenerationId: string; managerInstanceId: string };
type IngressContext = {
  identity: Identity;
  authorize(routeId: string, roleId: string, capability: string): boolean;
  readJson<T>(request: http.IncomingMessage, maxBytes: number): Promise<T>;
  receive: AllDayRecordingService["receiveMessage"];
  json(response: http.ServerResponse, status: number, result: unknown): void;
};

export async function handleAllDayMessageIngress(request: http.IncomingMessage, url: URL, response: http.ServerResponse, context: IngressContext): Promise<boolean> {
  if (url.pathname !== ALL_DAY_MESSAGE_INGRESS) return false;
  response.setHeader("cache-control", "no-store");
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress) || request.method !== "POST"
    || request.headers[ROLE_CONTEXT_GENERATION_HEADER] !== context.identity.applicationGenerationId
    || request.headers[ROLE_CONTEXT_MANAGER_HEADER] !== context.identity.managerInstanceId) {
    context.json(response, 403, { code: -1, error: "RECORDING_INGRESS_FORBIDDEN" });
    return true;
  }
  const message = await context.readJson<Partial<Message> | null>(request, 48 * 1024);
  const encodedRouteId = request.headers[ROLE_CONTEXT_ROUTE_HEADER];
  let routeId = "";
  if (typeof encodedRouteId === "string") {
    try { routeId = decodeURIComponent(encodedRouteId); } catch { routeId = ""; }
  }
  if (!routeId || !message || typeof message.roleId !== "string" || !context.authorize(routeId, message.roleId, String(request.headers[ROLE_CONTEXT_CAPABILITY_HEADER] || ""))) {
    context.json(response, 403, { code: -1, error: "RECORDING_INGRESS_FORBIDDEN" });
    return true;
  }
  const { id, category, time, text } = message;
  if (!category || !MESSAGE_EVENT_CATEGORIES.some(type => type.value === category) || typeof id !== "string" || !id || id.length > 256
    || typeof time !== "number" || !Number.isFinite(time) || time <= 0 || time > Date.now() + 60_000
    || typeof text !== "string" || !text.trim() || text.length > 4096) {
    context.json(response, 400, { code: -1, error: "INVALID_RECORDING_MESSAGE" });
    return true;
  }
  const roleId = message.roleId;
  const capability = String(request.headers[ROLE_CONTEXT_CAPABILITY_HEADER] || "");
  const recorded = await context.receive(roleId, category, { id, time, text }, () => {
    if (!context.authorize(routeId, roleId, capability)) throw new Error("Recording message authority changed");
  });
  context.json(response, 200, { code: 0, data: { recorded } });
  return true;
}

let pending = 0;
export async function projectAllDayMessage(message: Message): Promise<void> {
  const manager = process.env.GATEWAY_MANAGER_URL;
  const routeId = process.env.GATEWAY_ID;
  const capability = process.env.PERSONA_MESSAGING_CAPABILITY;
  const generation = process.env.RABIROUTE_APPLICATION_GENERATION_ID;
  const instance = process.env.RABIROUTE_MANAGER_INSTANCE_ID;
  if (!manager || !routeId || !capability || !generation || !instance) return;
  const base = new URL(manager);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password) return;
  if (pending >= 16) throw new Error("Recording projection queue is full");
  pending++;
  try {
    const response = await fetch(new URL(ALL_DAY_MESSAGE_INGRESS, base), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
      headers: { "content-type": "application/json", [ROLE_CONTEXT_ROUTE_HEADER]: encodeURIComponent(routeId),
        [ROLE_CONTEXT_CAPABILITY_HEADER]: capability, [ROLE_CONTEXT_GENERATION_HEADER]: generation, [ROLE_CONTEXT_MANAGER_HEADER]: instance },
      body: JSON.stringify({ ...message, text: message.text.slice(0, 4096) })
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Recording projection HTTP ${response.status}`);
  } finally { pending--; }
}
