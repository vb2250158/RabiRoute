import type http from "node:http";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import { writeDesktopLifecycleIntent } from "./desktopLifecycleIntent.js";

type DesktopLifecycleApiOptions = {
  rootDir: string;
  shutdownManager: (reason: string) => void | Promise<void>;
  shutdownDelayMs?: number;
  scheduleShutdown?: (task: () => void, delayMs: number) => void;
  trackOperation?: <T>(operation: Promise<T>) => Promise<T>;
};

function jsonResponse(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function readJsonBody(request: http.IncomingMessage, maxBytes = 8 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    request.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(new Error("request body must be a JSON object"));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

export function handleDesktopLifecycleApi(
  request: http.IncomingMessage,
  requestUrl: URL,
  response: http.ServerResponse,
  options: DesktopLifecycleApiOptions
): boolean {
  const isStart = requestUrl.pathname === "/manager/desktop-lifecycle/start";
  const isShutdown = requestUrl.pathname === "/manager/shutdown";
  if (!isStart && !isShutdown) return false;

  if (request.method !== "POST") {
    jsonResponse(response, 405, { code: -1, message: "method not allowed" });
    return true;
  }
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
    jsonResponse(response, 403, { code: -1, message: "desktop lifecycle control is loopback-only" });
    return true;
  }

  if (isStart) {
    const operation = readJsonBody(request)
      .then((body) => {
        const requestedSource = typeof body.source === "string" ? body.source : "desktop-start";
        const source = requestedSource === "packaged-desktop" || requestedSource === "windows-desktop"
          ? requestedSource
          : "desktop-start";
        const intent = writeDesktopLifecycleIntent(options.rootDir, "running", source);
        jsonResponse(response, 200, { code: 0, message: "desktop lifecycle started", intent });
      })
      .catch((error) => {
        jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
      });
    void (options.trackOperation ? options.trackOperation(operation) : operation);
    return true;
  }

  const operation = readJsonBody(request)
    .then((body) => {
      if (body.desktopExit === true) {
        writeDesktopLifecycleIntent(options.rootDir, "stopped", "desktop-exit");
      }
      jsonResponse(response, 200, { code: 0, message: "manager shutdown requested" });
      const task = (): void => { void options.shutdownManager("api"); };
      const delayMs = Math.max(0, options.shutdownDelayMs ?? 20);
      if (options.scheduleShutdown) options.scheduleShutdown(task, delayMs);
      else setTimeout(task, delayMs);
    })
    .catch((error) => {
      jsonResponse(response, 400, { code: -1, message: error instanceof Error ? error.message : String(error) });
    });
  void (options.trackOperation ? options.trackOperation(operation) : operation);
  return true;
}
