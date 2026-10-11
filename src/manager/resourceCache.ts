import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { withResourceCacheSettingsLock } from "./recordingArchiveBindings.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
/** Durable resource objects. Receipts are published only after fsync and atomic rename. */
export class ResourceCache {
  constructor(private readonly stateDir: string) {}
  private configFile() { return path.join(this.stateDir, "resource-cache.json"); }
  async settings(): Promise<{ directory: string }> {
    try {
      const value = JSON.parse(await fs.readFile(this.configFile(), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource settings");
      const directory = value.directory ?? path.join(this.stateDir, "resource-cache");
      if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("Invalid resource directory");
      return { ...value, directory };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return { directory: path.join(this.stateDir, "resource-cache") }; }
  }
  private async atomic(file: string, body: Buffer, authorize: () => void = () => {}) {
    const audit = (outcome: "started" | "committed" | "failed") => recordDataMutationAudit({
      group: "resource-cache", event: "resource_file_write", owner: "resource-cache",
      action: "write", target: { type: "resource-file", id: digest(file) },
      dataSource: { kind: "file", id: digest(file) }, outcome
    });
    audit("started");
    try {
      authorize();
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + "." + randomUUID() + ".partial";
      try {
        authorize();
        const handle = await fs.open(temporary, "wx");
        try { authorize(); await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
        authorize();
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
      audit("committed");
    } catch (error) {
      audit("failed");
      throw error;
    }
  }
  async configure(directory: unknown, authorize: () => void = () => {}) {
    authorize();
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 2048) throw new Error("请输入电脑上的绝对目录路径");
    const normalized = path.resolve(directory);
    await fs.mkdir(normalized, { recursive: true });
    authorize();
    const probe = path.join(normalized, ".rabi-write-test-" + randomUUID());
    try { await this.atomic(probe, Buffer.from("test"), authorize); } finally { await fs.rm(probe, { force: true }); }
    authorize();
    await fs.mkdir(this.stateDir, { recursive: true });
    authorize();
    return withResourceCacheSettingsLock(this.configFile(), async () => {
      authorize();
      let previous: Record<string, unknown> = {};
      try {
        previous = JSON.parse(await fs.readFile(this.configFile(), "utf8"));
        if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("Invalid resource settings");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      authorize();
      await this.atomic(this.configFile(), Buffer.from(JSON.stringify({ ...previous, directory: normalized })), authorize);
      return this.settings();
    });
  }
  private index(owner: string, id: string) {
    if (!owner || !validId(id)) throw new Error("Invalid resource identity");
    return path.join(this.stateDir, "resource-cache-index", digest(owner), id + ".json");
  }
  async read(owner: string, id: string) {
    const reference = JSON.parse(await fs.readFile(this.index(owner,id), "utf8"));
    const body = await fs.readFile(reference.file);
    if (body.length !== reference.bytes || digest(body) !== id) throw new Error("Resource integrity check failed");
    return body;
  }
  async put(owner: string, id: string, body: Buffer) {
    const index = this.index(owner,id);
    if (!body.length || body.length > 1024 * 1024 || digest(body) !== id) throw new Error("Resource size or checksum mismatch");
    try { const existing = await this.read(owner,id); return { id, bytes: existing.length, sha256: id, durable: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const file = path.join((await this.settings()).directory, digest(owner), id.slice(0,2), id);
    await this.atomic(file,body);
    await this.atomic(index,Buffer.from(JSON.stringify({ file, bytes: body.length })));
    return { id, bytes: body.length, sha256: id, durable: true };
  }
}

export function resourceCacheHandler(store: ResourceCache, options: { local(request: http.IncomingMessage): boolean; tunnelKey(): string; readOnly(): boolean; receiveRecording?(owner: string, body: unknown): Promise<void> }) {
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse): boolean => {
    if (!url.pathname.startsWith("/api/resource-cache/")) return false;
    const json = (status: number, data: unknown) => { response.writeHead(status,{ "content-type":"application/json" }); response.end(JSON.stringify(data)); };
    void (async () => {
      const settings = url.pathname === "/api/resource-cache/settings";
      let principal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
      const settingsAuthorized = () => {
        try {
          const current = assertTrustedLanAgentPrincipal(request);
          return current === principal && (Boolean(current)
            || (options.local(request) && !request.headers["x-rabilink-tunnel-local"] && localModelSettingsRequestAllowed(request)));
        } catch { return false; }
      };
      if (settings) {
        try { principal = assertTrustedLanAgentPrincipal(request); } catch { json(403,{ message:"Access denied" }); return; }
        if (!settingsAuthorized()) { json(403,{ message:"Access denied" }); return; }
      } else if (request.headers["x-rabilink-resource-key"] !== options.tunnelKey()) { json(403,{ message:"Access denied" }); return; }
      const authorizeSettings = () => {
        if (!settingsAuthorized()) throw Object.assign(new Error("Access denied"), { status: 403 });
      };
      if (request.method !== "GET" && options.readOnly()) { json(403,{ message:"Read only" }); return; }
      if (settings && request.method === "GET") {
        const result = await store.settings();
        authorizeSettings();
        json(200,result); return;
      }
      const match = /^\/api\/resource-cache\/data\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
      const recording = url.pathname === "/api/resource-cache/data/recording-events" && !!options.receiveRecording;
      if (!settings && !match && !recording) { json(404,{ message:"Not found" }); return; }
      const owner = String(request.headers["x-rabilink-resource-owner"] || "");
      if (!settings && !recording && request.method === "GET") {
        const body = await store.read(owner,match![1]);
        response.writeHead(200,{ "content-type":"application/octet-stream", "content-length":body.length }); response.end(body); return;
      }
      if (request.method !== "PUT") { json(405,{ message:"Method not allowed" }); return; }
      const chunks: Buffer[] = []; let size=0;
      for await (const chunk of request) { size += chunk.length; if(size > (settings ? 8192 : 1024*1024)) throw new Error("Request too large"); chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks);
      if (recording) { await options.receiveRecording!(owner, JSON.parse(body.toString())); json(200, { durable: true }); return; }
      if (settings) {
        authorizeSettings();
        const result = await store.configure(JSON.parse(body.toString()).directory, authorizeSettings);
        authorizeSettings();
        json(200,result);
      } else json(200,await store.put(owner,match![1],body));
    })().catch(error => { if (!response.headersSent) json(error?.status === 403 ? 403 : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400,{ message: error instanceof Error ? error.message : String(error) }); else response.destroy(); });
    return true;
  };
}
