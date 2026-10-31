import type http from "node:http";
import { managerHostRequestAuthorized, type ManagerHostIdentity } from "./hostLifecycle.js";
import type { WebPatchRequest, WebPatchService } from "./webPatchService.js";

export function handleWebPatchApi(request: http.IncomingMessage, url: URL, response: http.ServerResponse, options: {
  service: WebPatchService; identity: ManagerHostIdentity | null;
  readJson(request: http.IncomingMessage, maximum: number): Promise<unknown>;
  json(response: http.ServerResponse, status: number, body: unknown): void;
}): boolean {
  const send = (status: number, data: unknown) => { response.setHeader("cache-control", "no-store"); options.json(response, status, data); };
  if (url.pathname === "/_rabiroute/host/web-patches" || url.pathname === "/_rabiroute/host/web-patches/reconcile") {
    if (request.method !== "POST") { send(405, { code: -1 }); return true; }
    if (!managerHostRequestAuthorized(request, options.identity)) { send(403, { code: -1, message: "Web publication requires local Host authority." }); return true; }
    void options.readJson(request, 8192).then(async body => {
      const input = body as WebPatchRequest;
      if (url.pathname.endsWith("/reconcile")) {
        const identity = options.service.status().identity;
        if (!input || Object.entries(identity).some(([key, value]) => input[key as keyof WebPatchRequest] !== value)) throw new Error("Web patch runtime identity changed.");
        return options.service.reconcile(input.operationId).then(result => ({ ...result, operationId: input.operationId }));
      }
      return options.service.publish(input);
    })
      .then(receipt => send(200, { code: 0, data: receipt }))
      .catch(error => send(409, { code: -1, message: String(error), operationState: options.service.status().state === "blocked" ? "unknown" : "not_started" }));
    return true;
  }
  return false;
}
