import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type http from "node:http";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";
import { withResourceCacheSettingsLock } from "./recordingArchiveBindings.js";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { localModelSettingsRequestAllowed } from "./speechModelSettingsAccess.js";
import type { ApiOperationResult } from "./apiOperationContract.js";
import { resourceRequestBytes, resourceRequestJson, type ResourceApiInput } from "./resourceApiRequest.js";
import { RESOURCE_HASH_PATTERN, RESOURCE_OBJECT_MAX_BYTES, RESOURCE_SETTINGS_MAX_BYTES, RESOURCE_DIRECTORY_MAX_LENGTH } from "./resourceCacheProtocol.js";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const resourceHash = new RegExp(RESOURCE_HASH_PATTERN);
const validId = (id: string) => resourceHash.test(id);
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
    if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > RESOURCE_DIRECTORY_MAX_LENGTH) throw new Error("请输入电脑上的绝对目录路径");
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
  async put(owner: string, id: string, body: Buffer, authorize: () => void = () => {}) {
    authorize();
    const index = this.index(owner,id);
    if (!body.length || body.length > RESOURCE_OBJECT_MAX_BYTES || digest(body) !== id) throw new Error("Resource size or checksum mismatch");
    try { const existing = await this.read(owner,id); authorize(); return { id, bytes: existing.length, sha256: id, durable: true }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const file = path.join((await this.settings()).directory, digest(owner), id.slice(0,2), id);
    await this.atomic(file,body,authorize);
    await this.atomic(index,Buffer.from(JSON.stringify({ file, bytes: body.length })),authorize);
    return { id, bytes: body.length, sha256: id, durable: true };
  }
}

export type ResourceCacheOptions = { local(request: http.IncomingMessage): boolean; tunnelKey(): string; readOnly(): boolean;
  receiveRecording?(owner: string, body: unknown, authorize?: () => void): Promise<void> };
export async function runResourceCacheOperation(store: ResourceCache, options: ResourceCacheOptions, input: ResourceApiInput): Promise<ApiOperationResult> {
    const { request } = input;
    const json = (status: number, body: unknown): ApiOperationResult => ({ status, body });
    try {
      const settings = input.route.key === "settings.read" || input.route.key === "settings.update";
      let principal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
      try { principal = assertTrustedLanAgentPrincipal(request); } catch { return json(403,{ message:"Access denied" }); }
      const settingsAuthorized = () => {
        try {
          const current = assertTrustedLanAgentPrincipal(request);
          return current === principal && (Boolean(current) || hasAuthenticatedConnectionRequest(request)
            || (options.local(request) && !request.headers["x-rabilink-tunnel-local"] && localModelSettingsRequestAllowed(request)));
        } catch { return false; }
      };
      if (settings) {
        try { principal = assertTrustedLanAgentPrincipal(request); } catch { return json(403,{ message:"Access denied" }); }
        if (!settingsAuthorized()) return json(403,{ message:"Access denied" });
      }
      const authorizeData = () => {
        try {
          const current = assertTrustedLanAgentPrincipal(request);
          if (current !== principal || !(current || hasAuthenticatedConnectionRequest(request)
            || (options.tunnelKey() && request.headers["x-rabilink-resource-key"] === options.tunnelKey()))) throw new Error("Access denied");
        } catch { throw Object.assign(new Error("Access denied"), { status: 403 }); }
      };
      if (!settings) authorizeData();
      const authorizeSettings = () => {
        if (!settingsAuthorized()) throw Object.assign(new Error("Access denied"), { status: 403 });
      };
      if (request.method !== "GET" && options.readOnly()) return json(403,{ message:"Read only" });
      if (settings && request.method === "GET") {
        const result = await store.settings();
        authorizeSettings();
        return json(200,result);
      }
      const objectHash = input.path.objectHash;
      const recording = input.route.key === "recording-events.write" && !!options.receiveRecording;
      if (!settings && !objectHash && !recording) return json(404,{ message:"Not found" });
      const owner = String(request.headers["x-rabilink-resource-owner"] || "");
      if (!settings && !recording && request.method === "GET") {
        const body = await store.read(owner,objectHash!);
        authorizeData();
        return { status: 200, headers: { "content-type":"application/octet-stream", "content-length":String(body.length) }, body };
      }
      if (request.method !== "PUT") return json(405,{ message:"Method not allowed" });
      if (!settings) authorizeData();
      if (recording) {
        const body = await resourceRequestJson(input, RESOURCE_OBJECT_MAX_BYTES);
        authorizeData(); await options.receiveRecording!(owner, body, authorizeData); authorizeData();
        return json(200, { durable: true });
      }
      if (settings) {
        const body = await resourceRequestJson(input, RESOURCE_SETTINGS_MAX_BYTES) as { directory?: unknown };
        authorizeSettings();
        const result = await store.configure(body.directory, authorizeSettings);
        authorizeSettings();
        return json(200,result);
      }
      const body = await resourceRequestBytes(input, RESOURCE_OBJECT_MAX_BYTES);
      authorizeData(); const result = await store.put(owner,objectHash!,body,authorizeData); authorizeData(); return json(200,result);
    } catch (error) { return json((error as { status?: number })?.status === 403 ? 403 : (error as { status?: number })?.status === 413 ? 413 : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400,{ message: error instanceof Error ? error.message : String(error) }); }
}
