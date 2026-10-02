import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type http from "node:http";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const RESET_PATH = "/api/rabi/identity/reset-instance-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ResetRequest = Readonly<{ operationId: string; expectedGuid: string }>;
type ResetStatus = Readonly<{ operationId: string; state: "queued" | "committed" | "rolled_back" | "failed"; newGuid?: string; message?: string }>;
export class IdentityResetError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export function instanceIdentityResetAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  const executable = environment.RABIROUTE_HOST_EXECUTABLE ?? "";
  return environment.RABIROUTE_HOSTED === "1" && path.isAbsolute(executable) && fsSync.existsSync(executable);
}

function localRequest(request: http.IncomingMessage): boolean {
  if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) return false;
  const authority = request.headers.host;
  // Reject DNS-rebound domains even when their browser Origin matches Host.
  if (typeof authority !== "string" || !/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::[1-9]\d{0,4})?$/i.test(authority)) return false;
  let local: URL;
  try { local = new URL(`http://${authority}`); }
  catch { return false; }
  if (Number(local.port || 80) !== request.socket.localPort) return false;
  if (["x-rabilink-tunnel-local", "x-rabiroute-relay-proxy", "x-rabiroute-peer-proxy", "x-forwarded-for", "forwarded"]
    .some(header => request.headers[header] !== undefined)) return false;
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (origin) {
    try { if (typeof origin !== "string" || new URL(origin).origin !== local.origin) return false; }
    catch { return false; }
  }
  return true;
}

function parseRequest(body: unknown): ResetRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new IdentityResetError("重置请求无效。", 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || value.confirmed !== true
    || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || typeof value.expectedGuid !== "string" || !UUID.test(value.expectedGuid)) {
    throw new IdentityResetError("请确认重置，并提供当前实例 ID 和操作 ID。", 400);
  }
  return { operationId: value.operationId.toLowerCase(), expectedGuid: value.expectedGuid };
}

export class HostInstanceIdentityReset {
  constructor(private readonly options: Readonly<{
    stateRoot: string;
    applicationGenerationId: string;
    environment?: NodeJS.ProcessEnv;
    execute?: (executable: string, args: readonly string[]) => Promise<unknown>;
  }>) {}

  available(): boolean { return instanceIdentityResetAvailable(this.options.environment); }

  async enqueue(input: ResetRequest): Promise<ResetStatus> {
    if (!this.available()) throw new IdentityResetError("此操作需要安装版 RabiRoute Host。", 503);
    const directory = path.join(this.options.stateRoot, "data", "rabilink", "identity-reset-requests");
    await fs.mkdir(directory, { recursive: true });
    const requestFile = path.join(directory, `${input.operationId}.json`);
    try { await fs.writeFile(requestFile, JSON.stringify(input), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = JSON.parse(await fs.readFile(requestFile, "utf8"));
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new IdentityResetError("操作 ID 已用于其他请求。", 409);
      const status = await this.status(input.operationId);
      if (status) return status;
      throw new IdentityResetError("先前请求的结果未确认，请查询操作状态，不要重复重置。", 409);
    }
    recordDataMutationAudit({
      group: "config.global", event: "device_identity_reset_request_created", owner: "HostInstanceIdentityReset",
      action: "create", operationId: input.operationId, target: { type: "identity_reset_request", id: input.operationId },
      dataSource: { kind: "file", id: `data/rabilink/identity-reset-requests/${input.operationId}.json` }, outcome: "committed"
    });
    const environment = this.options.environment ?? process.env;
    const execute = this.options.execute ?? ((executable: string, args: readonly string[]) => new Promise<unknown>((resolve, reject) => {
      execFile(executable, [...args], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        // A rejected command may still return a structured, audited Host response.
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new IdentityResetError("Host 未确认重置请求，请查询操作状态或从托盘重新打开页面。", 503)); }
      });
    }));
    let result: unknown;
    try {
      result = await execute(environment.RABIROUTE_HOST_EXECUTABLE!, [
        "--command", "reset-instance-id", "--application-generation-id", this.options.applicationGenerationId,
        "--identity-reset-request", requestFile, "--json"
      ]);
    } catch { throw new IdentityResetError("Host 未确认重置请求，请查询操作状态或从托盘重新打开页面。", 503); }
    const reply = result as { ok?: boolean; state?: string; operationId?: string } | null;
    if (!reply?.ok || reply.state !== "queued" || reply.operationId !== input.operationId) {
      throw new IdentityResetError("Host 未接受重置。请核对当前运行版本和实例状态。", 409);
    }
    return { operationId: input.operationId, state: "queued" };
  }

  async status(operationId: string): Promise<ResetStatus | undefined> {
    if (!UUID.test(operationId)) throw new IdentityResetError("操作 ID 无效。", 400);
    const file = path.join(this.options.stateRoot, "data", "rabilink", "identity-resets", operationId.toLowerCase(), "host-status.json");
    let raw: Record<string, unknown>;
    try {
      if ((await fs.stat(file)).size > 4096) throw new Error("bounded status");
      raw = JSON.parse(await fs.readFile(file, "utf8"));
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new IdentityResetError("操作状态暂不可读取，请不要重复重置。", 503); }
    if (raw.schemaVersion !== 1 || raw.operationId !== operationId.toLowerCase()
      || typeof raw.oldGuid !== "string" || !UUID.test(raw.oldGuid)
      || !["queued", "committed", "rolled_back", "failed"].includes(String(raw.state))
      || raw.state === "committed" && (typeof raw.newGuid !== "string" || !UUID.test(raw.newGuid)
        || raw.newGuid.toLowerCase() === raw.oldGuid.toLowerCase())) {
      throw new IdentityResetError("操作状态无效，请不要重复重置。", 503);
    }
    return { operationId: operationId.toLowerCase(), state: raw.state as ResetStatus["state"],
      ...(typeof raw.newGuid === "string" && UUID.test(raw.newGuid) ? { newGuid: raw.newGuid } : {}),
      ...(raw.state === "failed" ? { message: "重置未完成，请检查 Host 日志与备份。" } : {}),
      ...(raw.state === "rolled_back" ? { message: "重置失败，已恢复原身份。" } : {}) };
  }

  async waitStatus(operationId: string, signal: AbortSignal): Promise<ResetStatus | undefined> {
    const current = await this.status(operationId);
    if (current?.state !== "queued" || signal.aborted) return current;
    const directory = path.join(this.options.stateRoot, "data", "rabilink", "identity-resets", operationId.toLowerCase());
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); watcher.close(); signal.removeEventListener("abort", finish); resolve(); };
      const watcher = fsSync.watch(directory, (_event, filename) => {
        if (filename?.toString() === "host-status.json") finish();
      });
      watcher.once("error", finish);
      const deadline = setTimeout(finish, 10_000);
      signal.addEventListener("abort", finish, { once: true });
      // Close the read/register race without repeatedly checking unchanged state.
      void this.status(operationId).then(value => { if (value?.state !== "queued") finish(); }).catch(finish);
      if (signal.aborted) finish();
    });
    return this.status(operationId);
  }
}

export function handleInstanceIdentityReset(request: http.IncomingMessage, url: URL, response: http.ServerResponse, options: Readonly<{
  service: Pick<HostInstanceIdentityReset, "available" | "enqueue" | "status"> & Partial<Pick<HostInstanceIdentityReset, "waitStatus">>;
  currentGuid: () => string;
  trustedRemote: (request: http.IncomingMessage) => boolean;
  readJson: (request: http.IncomingMessage, maximumBytes: number) => Promise<unknown>;
  json: (response: http.ServerResponse, status: number, body: unknown) => void;
}>): boolean {
  if (url.pathname !== RESET_PATH && !url.pathname.startsWith(`${RESET_PATH}/`)) return false;
  response.setHeader("cache-control", "no-store");
  if (!localRequest(request) || options.trustedRemote(request)) {
    options.json(response, 403, { code: -1, message: "实例身份只能在本机页面重置。" }); return true;
  }
  if (url.search) { options.json(response, 400, { code: -1, message: "此接口不接受查询参数。" }); return true; }
  const operationId = url.pathname.slice(RESET_PATH.length + 1);
  if (request.method === "GET" && url.pathname !== RESET_PATH) {
    const controller = new AbortController();
    const close = () => controller.abort();
    response.once("close", close);
    const pending = options.service.waitStatus ? options.service.waitStatus(operationId, controller.signal) : options.service.status(operationId);
    void pending.then(status => { if (!response.destroyed) options.json(response, status ? 200 : 404, { code: status ? 0 : -1, data: status }); })
      .catch(error => options.json(response, error instanceof IdentityResetError ? error.statusCode : 503, { code: -1, message: "操作状态暂不可读取，请不要重复重置。" }));
    return true;
  }
  if (request.method !== "POST" || url.pathname !== RESET_PATH) { options.json(response, 405, { code: -1, message: "Method not allowed." }); return true; }
  if (!options.service.available()) { options.json(response, 503, { code: -1, message: "此操作需要安装版 RabiRoute Host。" }); return true; }
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) {
    options.json(response, 415, { code: -1, message: "重置请求必须使用 JSON。" }); return true;
  }
  void options.readJson(request, 2048).then(body => {
    const input = parseRequest(body);
    const currentGuid = options.currentGuid();
    if (input.expectedGuid.toLowerCase() !== currentGuid.toLowerCase()) throw new IdentityResetError("实例 ID 已改变，请重新读取页面。", 409);
    // Preserve the saved spelling for the offline transaction's exact CAS fence.
    return options.service.enqueue({ ...input, expectedGuid: currentGuid });
  }).then(status => options.json(response, status.state === "queued" ? 202 : 200, { code: 0, data: status }))
    .catch(error => options.json(response, error instanceof IdentityResetError ? error.statusCode : 400,
      { code: -1, message: error instanceof IdentityResetError ? error.message : "重置请求无效。" }));
  return true;
}
