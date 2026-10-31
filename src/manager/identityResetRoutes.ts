import { getTimeoutMs } from "../shared/timeoutSettings.js";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type http from "node:http";
import { hasAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { isLoopbackRemoteAddress } from "./webguiLanAccess.js";
import { assertTrustedLanAgentPrincipal } from "./lanAgentRequestAccess.js";
import { isLanAgentCredentialToken } from "./lanAgentAuthority.js";
import { recordDataMutationAudit } from "../observability/dataMutationAudit.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ResetRequest = Readonly<{ operationId: string; expectedGuid: string }>;
type ResetStatus = Readonly<{ operationId: string; state: "queued" | "committed" | "rolled_back" | "failed"; newGuid?: string; message?: string }>;
export class IdentityResetError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class IdentityResetAuthorizationError extends IdentityResetError {
  constructor(readonly commitState: "not_started" | "unknown") {
    super("实例身份操作授权已失效。", 403);
  }
}

/** The original owner or Manager generation changed; this is not a new permission requirement. */
export class IdentityResetOwnerChangedError extends IdentityResetError {
  constructor(readonly commitState: "not_started" | "unknown") { super("实例身份操作的原服务或运行代际已改变。", 409); }
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

function parseIdentityResetRequest(body: unknown): ResetRequest {
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

  /** Internal callers are trusted by default; HTTP callers must supply their captured authorization fence. */
  async enqueue(input: ResetRequest, authorize: () => void = () => {}): Promise<ResetStatus> {
    let requestMayExist = false;
    const assertAccess = () => {
      try { authorize(); }
      catch (error) {
        if (error instanceof IdentityResetOwnerChangedError) throw new IdentityResetOwnerChangedError(requestMayExist ? "unknown" : "not_started");
        throw new IdentityResetAuthorizationError(requestMayExist ? "unknown" : "not_started");
      }
    };
    assertAccess();
    if (!this.available()) throw new IdentityResetError("此操作需要安装版 RabiRoute Host。", 503);
    const directory = path.join(this.options.stateRoot, "data", "rabilink", "identity-reset-requests");
    assertAccess();
    try { await fs.mkdir(directory, { recursive: true }); }
    finally { assertAccess(); }
    const requestFile = path.join(directory, `${input.operationId}.json`);
    try {
      assertAccess();
      // A write rejection can leave a partial file; do not claim that the reset request never started.
      requestMayExist = true;
      await fs.writeFile(requestFile, JSON.stringify(input), { flag: "wx", mode: 0o600 });
    }
    catch (error) {
      assertAccess();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let content: string;
      try { content = await fs.readFile(requestFile, "utf8"); }
      finally { assertAccess(); }
      const existing = JSON.parse(content);
      if (JSON.stringify(existing) !== JSON.stringify(input)) throw new IdentityResetError("操作 ID 已用于其他请求。", 409);
      assertAccess();
      const status = await this.status(input.operationId, assertAccess);
      assertAccess();
      if (status) return status;
      throw new IdentityResetError("先前请求的结果未确认，请查询操作状态，不要重复重置。", 409);
    }
    assertAccess();
    recordDataMutationAudit({
      group: "config.global", event: "device_identity_reset_request_created", owner: "HostInstanceIdentityReset",
      action: "create", operationId: input.operationId, target: { type: "identity_reset_request", id: input.operationId },
      dataSource: { kind: "file", id: `data/rabilink/identity-reset-requests/${input.operationId}.json` }, outcome: "committed"
    });
    const environment = this.options.environment ?? process.env;
    const execute = this.options.execute ?? ((executable: string, args: readonly string[]) => new Promise<unknown>((resolve, reject) => {
      execFile(executable, [...args], { windowsHide: true, timeout: getTimeoutMs("backend.manager.identityResetRoutes.enqueue.execFile.timeout", 15_000), maxBuffer: 64 * 1024 }, (error, stdout) => {
        // A rejected command may still return a structured, audited Host response.
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new IdentityResetError("Host 未确认重置请求，请查询操作状态或从托盘重新打开页面。", 503)); }
      });
    }));
    let result: unknown;
    assertAccess();
    try {
      result = await execute(environment.RABIROUTE_HOST_EXECUTABLE!, [
        "--command", "reset-instance-id", "--application-generation-id", this.options.applicationGenerationId,
        "--identity-reset-request", requestFile, "--json"
      ]);
    } catch (error) {
      assertAccess();
      if (error instanceof IdentityResetAuthorizationError || error instanceof IdentityResetOwnerChangedError) throw error;
      throw new IdentityResetError("Host 未确认重置请求，请查询操作状态或从托盘重新打开页面。", 503);
    }
    assertAccess();
    const reply = result as { ok?: boolean; state?: string; operationId?: string } | null;
    if (!reply?.ok || reply.state !== "queued" || reply.operationId !== input.operationId) {
      throw new IdentityResetError("Host 未接受重置。请核对当前运行版本和实例状态。", 409);
    }
    return { operationId: input.operationId, state: "queued" };
  }

  async status(operationId: string, authorize: () => void = () => {}): Promise<ResetStatus | undefined> {
    authorize();
    if (!UUID.test(operationId)) throw new IdentityResetError("操作 ID 无效。", 400);
    const file = path.join(this.options.stateRoot, "data", "rabilink", "identity-resets", operationId.toLowerCase(), "host-status.json");
    let raw: Record<string, unknown>;
    try {
      const stat = await fs.stat(file);
      authorize();
      if (stat.size > 4096) throw new Error("bounded status");
      const content = await fs.readFile(file, "utf8");
      authorize();
      raw = JSON.parse(content);
    }
    catch (error) {
      authorize();
      if (error instanceof IdentityResetAuthorizationError || error instanceof IdentityResetOwnerChangedError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new IdentityResetError("操作状态暂不可读取，请不要重复重置。", 503);
    }
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

  async waitStatus(operationId: string, signal: AbortSignal, authorize: () => void = () => {}): Promise<ResetStatus | undefined> {
    authorize();
    const current = await this.status(operationId, authorize);
    authorize();
    if (current?.state !== "queued" || signal.aborted) return current;
    const directory = path.join(this.options.stateRoot, "data", "rabilink", "identity-resets", operationId.toLowerCase());
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(deadline); watcher.close(); signal.removeEventListener("abort", finish); resolve(); };
      const watcher = fsSync.watch(directory, (_event, filename) => {
        if (filename?.toString() === "host-status.json") finish();
      });
      watcher.once("error", finish);
      const deadline = setTimeout(finish, getTimeoutMs("deadline.manager.identityResetRoutes.waitStatus", 10_000));
      signal.addEventListener("abort", finish, { once: true });
      // Close the read/register race without repeatedly checking unchanged state.
      void this.status(operationId, authorize).then(value => { if (value?.state !== "queued") finish(); }).catch(finish);
      if (signal.aborted) finish();
    });
    authorize();
    return this.status(operationId, authorize);
  }
}

export type InstanceIdentityResetContext = Readonly<{
  service: Pick<HostInstanceIdentityReset, "available" | "enqueue" | "status"> & Partial<Pick<HostInstanceIdentityReset, "waitStatus">>;
  currentGuid: () => string;
}>;

/** Capture original authorization before body parsing; a new principal cannot adopt this request. */
export function captureIdentityResetAuthority(request: http.IncomingMessage, url: URL,
  outcome: () => "not_started" | "unknown", assertCurrent: () => void = () => {}) {
  let originalPrincipal: ReturnType<typeof assertTrustedLanAgentPrincipal>;
  let principalCaptured = false;

  const assertAccess = () => {
    try {
      assertCurrent();
      const principal = assertTrustedLanAgentPrincipal(request);
      if (principalCaptured && principal !== originalPrincipal) throw new Error("Request principal changed.");
      // Denied credential candidates cannot borrow the strict local exception.
      const bearer = typeof request.headers.authorization === "string" ? request.headers.authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "" : "";
      const legacy = request.headers["x-rabiroute-webgui-token"];
      // Local transport properties can disappear after body consumption; capture that strict exception once.
      if (!principal && (isLanAgentCredentialToken(bearer) || typeof legacy === "string" && isLanAgentCredentialToken(legacy)
        || [...url.searchParams.values()].some(isLanAgentCredentialToken)
        || !principalCaptured && !localRequest(request) && !hasAuthenticatedConnectionRequest(request))) throw new Error("Local authorization required.");
      originalPrincipal = principal; principalCaptured = true;
    } catch (error) {
      if (error instanceof IdentityResetOwnerChangedError) throw error;
      throw new IdentityResetAuthorizationError(outcome());
    }
  };
  assertAccess();
  return assertAccess;
}

export function createInstanceIdentityResetOwner(options: InstanceIdentityResetContext) {
  const service = options.service, currentGuid = options.currentGuid;
  const available = service.available, enqueue = service.enqueue, status = service.status, waitStatus = service.waitStatus;
  let dispatched = false;
  const assertOwner = () => {
    if (options.service !== service || options.currentGuid !== currentGuid || service.available !== available || service.enqueue !== enqueue || service.status !== status || service.waitStatus !== waitStatus) {
      throw new IdentityResetOwnerChangedError(dispatched ? "unknown" : "not_started");
    }
  };
  return {
    available: () => { assertOwner(); const value = available.call(service); assertOwner(); return value; },
    async enqueue(body: unknown, guard: () => void, onDispatched: () => void) {
      const assertCurrent = () => { guard(); assertOwner(); };
      assertCurrent();
      const input = parseIdentityResetRequest(body), savedGuid = currentGuid();
      if (input.expectedGuid.toLowerCase() !== savedGuid.toLowerCase()) throw new IdentityResetError("实例 ID 已改变，请重新读取页面。", 409);
      assertCurrent(); onDispatched(); dispatched = true;
      const reply = await enqueue.call(service, { ...input, expectedGuid: savedGuid }, assertCurrent);
      assertCurrent();
      return { status: reply.state === "queued" ? 202 : 200, body: { code: 0, data: reply } };
    },
    async status(operationId: string, signal: AbortSignal, guard: () => void) {
      const assertCurrent = () => { guard(); assertOwner(); };
      assertCurrent();
      const reply = waitStatus ? await waitStatus.call(service, operationId, signal, assertCurrent) : await status.call(service, operationId, assertCurrent);
      assertCurrent();
      return { status: reply ? 200 : 404, body: { code: reply ? 0 : -1, data: reply } };
    }
  };
}
