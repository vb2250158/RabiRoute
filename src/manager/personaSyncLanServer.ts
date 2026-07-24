import http from "node:http";
import os from "node:os";
import type { PersonaSyncRouteContext } from "./personaSyncRoutes.js";
import { handlePersonaSyncApi } from "./personaSyncRoutes.js";

export type PersonaSyncLanStatus = {
  state: "disabled" | "starting" | "listening" | "error";
  port?: number;
  urls: string[];
  error?: string;
};

export type PersonaSyncLanServerOptions = {
  host?: string;
  port?: number;
  addresses?: () => string[];
  onStatus?: (status: PersonaSyncLanStatus) => void;
};

function privateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

export function personaSyncLanAddresses(): string[] {
  return [...new Set(Object.values(os.networkInterfaces()).flatMap(entries => (entries ?? [])
    .filter(entry => entry.family === "IPv4" && !entry.internal && privateIpv4(entry.address))
    .map(entry => entry.address)))].sort();
}

function dataPlaneRequest(method: string | undefined, pathname: string): boolean {
  if (method === "GET" && pathname === "/api/persona-sync/manifest") return true;
  if (method === "GET" && /^\/api\/persona-sync\/files\/[^/]+\/.+/.test(pathname)) return true;
  return method === "POST" && pathname === "/api/persona-sync/merge";
}

export class PersonaSyncLanServer {
  private server: http.Server | null = null;
  private startFlight: Promise<void> | null = null;
  private runtimeStatus: PersonaSyncLanStatus = { state: "disabled", urls: [] };
  private readonly host: string;
  private readonly port: number;
  private readonly addresses: () => string[];

  constructor(
    private readonly context: PersonaSyncRouteContext,
    private readonly options: PersonaSyncLanServerOptions = {}
  ) {
    this.host = options.host?.trim() || "0.0.0.0";
    const requestedPort = Number(options.port ?? 0);
    this.port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535 ? requestedPort : 0;
    this.addresses = options.addresses ?? personaSyncLanAddresses;
  }

  status(): PersonaSyncLanStatus {
    return { ...this.runtimeStatus, urls: [...this.runtimeStatus.urls] };
  }

  peerUrls(): string[] {
    return this.status().urls;
  }

  start(): Promise<void> {
    if (this.runtimeStatus.state === "listening") return Promise.resolve();
    if (this.startFlight) return this.startFlight;
    this.updateStatus({ state: "starting", urls: [] });
    this.startFlight = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const requestUrl = new URL(request.url || "/", "http://persona-sync.local");
        if (!dataPlaneRequest(request.method, requestUrl.pathname)) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ code: -1, message: "This LAN listener only exposes persona synchronization data-plane APIs." }));
          return;
        }
        try {
          if (!handlePersonaSyncApi(request, requestUrl, response, this.context)) {
            response.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
            response.end(JSON.stringify({ code: -1, message: "Not found" }));
          }
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ code: -1, message: error instanceof Error ? error.message : String(error) }));
        }
      });
      this.server = server;
      const fail = (error: Error) => {
        if (this.server === server) this.server = null;
        this.updateStatus({ state: "error", urls: [], error: error.message });
        reject(error);
      };
      server.once("error", fail);
      server.listen(this.port, this.host, () => {
        server.off("error", fail);
        server.on("error", error => {
          this.updateStatus({ state: "error", urls: [], error: error.message });
        });
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 0;
        const urls = port > 0 ? this.addresses().map(host => `http://${host}:${port}`) : [];
        this.updateStatus({ state: "listening", port, urls });
        resolve();
      });
    }).finally(() => {
      this.startFlight = null;
    });
    return this.startFlight;
  }

  stop(): void {
    const server = this.server;
    this.server = null;
    this.startFlight = null;
    if (server) server.close();
    this.updateStatus({ state: "disabled", urls: [] });
  }

  private updateStatus(status: PersonaSyncLanStatus): void {
    this.runtimeStatus = status;
    this.options.onStatus?.(this.status());
  }
}
