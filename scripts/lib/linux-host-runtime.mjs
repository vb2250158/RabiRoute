import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fork } from "node:child_process";
import { createInterface } from "node:readline";

export const READY_PREFIX = "RABIROUTE_MANAGER_READY:";
export const HOST_NAMESPACE = `rabiroute-linux-host:${process.getuid?.() ?? "unknown"}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function processIdentity(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), start: fields[19] };
  } catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
}

function liveGroupMembers(group) {
  return fs.readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    let identity;
    try { identity = processIdentity(name); }
    catch (error) { if (["EACCES", "EPERM"].includes(error.code)) return []; throw error; }
    return identity?.group === group && !["Z", "X"].includes(identity.state) ? [Number(name)] : [];
  });
}

function signalOwnedGroup(child, signal) {
  const leader = processIdentity(child.pid);
  if (leader && leader.start !== child.rabiStartTime) throw new Error("Manager PID was reused; refusing to signal an unrelated process group.");
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}

export function loopbackUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Host endpoint must be an explicit HTTP IPv4 loopback origin.");
  }
  return url.origin;
}

export function validateReady(value, generation, pid) {
  if (!value || value.protocolVersion !== 1 || value.applicationGenerationId !== generation
    || value.pid !== pid || typeof value.managerInstanceId !== "string" || !value.managerInstanceId.trim()
    || typeof value.readyAt !== "string") throw new Error("Manager READY identity does not match this Host generation.");
  return { ...value, baseUrl: loopbackUrl(value.baseUrl) };
}

export function validateMeta(meta, ready) {
  if (meta?.applicationGenerationId !== ready.applicationGenerationId
    || meta?.managerInstanceId !== ready.managerInstanceId) throw new Error("Manager generation or instance changed.");
  if (meta.health?.live !== true || meta.health?.requiredReady !== true
    || !["healthy", "degraded"].includes(meta.health?.state)) throw new Error("Manager required capabilities are not ready.");
  return meta.health.state;
}

export async function requestJson(url, options = {}, timeoutMs = 5000) {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") return reject(new Error("Host requests are loopback-only."));
    const request = http.request(target, { method: options.method ?? "GET", headers: options.headers }, response => {
      const chunks = []; let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) request.destroy(new Error("Host response is too large."));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(body?.message || `HTTP ${response.statusCode}`);
          resolve(body);
        } catch (error) { reject(error); }
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error("Host request timed out.")), timeoutMs);
    request.once("close", () => clearTimeout(deadline));
    request.once("error", reject);
    request.end(options.body);
  });
}

export function descriptorPath(leasePath) { return `${leasePath}.control.json`; }

export function readDescriptor(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error("Linux Host control descriptor is not private to the current user.");
  }
  if (stat.size > 8192) throw new Error("Linux Host control descriptor is too large.");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(value.controlToken)
    || typeof value.hostInstanceId !== "string") throw new Error("Invalid Linux Host control descriptor.");
  return { ...value, baseUrl: loopbackUrl(value.baseUrl) };
}

export async function sendHostCommand(file, command, applicationGenerationId) {
  const descriptor = readDescriptor(file);
  const value = await requestJson(`${descriptor.baseUrl}/control`, {
    method: "POST", headers: { "content-type": "application/json", "x-rabiroute-host-token": descriptor.controlToken },
    body: JSON.stringify({ command, hostInstanceId: descriptor.hostInstanceId, applicationGenerationId })
  }, command === "restart" ? 90000 : 10000);
  if (value.hostInstanceId !== descriptor.hostInstanceId) throw new Error("Linux Host instance changed.");
  return value;
}

function equalToken(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class LinuxHost {
  constructor(options) {
    this.options = options;
    this.id = randomUUID();
    this.controlToken = randomBytes(32).toString("hex");
    this.state = "starting";
    this.failures = [];
    this.child = null;
    this.ready = null;
    this.stopping = false;
    this.transition = Promise.resolve();
  }

  response(ok = true, message) {
    return { ok, state: this.state, hostInstanceId: this.id, hostPid: process.pid,
      ...(message ? { message } : {}), applicationGenerationId: this.generation ?? null,
      controlFenceGenerationId: this.generation ?? null, managerInstanceId: this.ready?.managerInstanceId ?? null,
      managerBaseUrl: this.ready?.baseUrl ?? null, managerPid: this.child?.pid ?? null,
      readOnly: this.options.readOnly, autostart: this.options.autostart,
      packageRoot: this.options.packageRoot, stateRoot: this.options.stateRoot,
      desktopSurface: "web", logs: this.options.logPath };
  }

  async start() {
    this.log = fs.createWriteStream(this.options.logPath, { flags: "a", mode: 0o600 });
    this.log.on("error", error => { this.lastError = `Host log failed: ${error.code || "I/O error"}`; void this.close(); });
    this.server = http.createServer((request, response) => void this.handleControl(request, response));
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    const address = this.server.address();
    const descriptor = { schemaVersion: 1, hostInstanceId: this.id, baseUrl: `http://127.0.0.1:${address.port}`, controlToken: this.controlToken };
    const temporary = `${this.options.descriptorFile}.${this.id}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, this.options.descriptorFile);
    this.transition = this.transition.then(async () => {
      try { await this.startGeneration(); }
      catch (error) {
        if (!this.stopping) { this.state = "faulted"; this.lastError = error.message; }
        await this.stopGeneration();
      }
    });
    await this.transition;
    return this.response(this.state !== "faulted", this.lastError);
  }

  async handleControl(request, response) {
    const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST" || request.url !== "/control" || request.headers.origin
      || !equalToken(request.headers["x-rabiroute-host-token"], this.controlToken)) {
      request.resume(); reply(403, { message: "Local Host control authorization failed." }); return;
    }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of request) {
        bytes += chunk.length; if (bytes > 4096) throw new Error("Host request too large."); chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.hostInstanceId !== this.id) throw new Error("Host instance changed.");
      if (body.command === "status" || body.command === "activate") {
        reply(200, await this.status()); return;
      }
      if (!["restart", "quit"].includes(body.command)) throw new Error("Unsupported Linux Host command.");
      if (!body.applicationGenerationId || body.applicationGenerationId !== this.generation) throw new Error("Current application generation is required.");
      if (this.stopping) throw new Error("Host is stopping.");
      this.transition = this.transition.then(async () => {
        if (this.stopping) throw new Error("Host is stopping.");
        // Revalidate after earlier queued transitions; never apply a stale fence.
        if (body.applicationGenerationId !== this.generation) throw new Error("Application generation changed.");
        if (body.command === "quit") {
          this.stopping = true;
          reply(200, this.response(true, "Shutdown accepted."));
          setImmediate(() => void this.close());
          return;
        }
        this.state = "recovering";
        await this.stopGeneration();
        this.failures = [];
        try { await this.startGeneration(); }
        catch (error) {
          this.state = "faulted"; this.lastError = error.message;
          await this.stopGeneration(); throw error;
        }
        reply(200, this.response());
      }).catch(error => { if (!response.writableEnded) reply(409, this.response(false, error.message)); });
    } catch (error) { if (!response.writableEnded) reply(400, this.response(false, error.message)); }
  }

  async status() {
    if (!this.ready || !this.child || this.stopping || !["healthy", "degraded"].includes(this.state)) {
      return this.response(this.state !== "faulted", this.lastError);
    }
    try {
      this.state = validateMeta(await requestJson(`${this.ready.baseUrl}/meta`), this.ready);
      return this.response();
    } catch (error) { return this.response(false, error.message); }
  }

  async startGeneration() {
    if (this.stopping) return;
    this.generation = randomUUID();
    this.ready = null;
    this.state = "starting";
    this.lastError = undefined;
    this.managerControlToken = randomBytes(32).toString("hex");
    const env = { ...process.env, ...this.options.env, RABIROUTE_HOSTED: "1", RABIROUTE_HOST_TRANSPORT: "node-ipc",
      RABIROUTE_APPLICATION_GENERATION_ID: this.generation, RABIROUTE_HOST_CONTROL_TOKEN: this.managerControlToken,
      RABIROUTE_PACKAGE_ROOT: this.options.packageRoot, RABIROUTE_STATE_ROOT: this.options.stateRoot,
      GATEWAY_MANAGER_HOST: "127.0.0.1", GATEWAY_MANAGER_PORT: "0",
      RABIROUTE_MANAGER_READ_ONLY: this.options.readOnly ? "1" : "0",
      RABIROUTE_MANAGER_AUTOSTART: this.options.autostart ? "1" : "0" };
    // This minimal Linux Host does not claim Windows executable/reset support.
    delete env.RABIROUTE_HOST_EXECUTABLE;
    delete env.RABIROUTE_MANAGER_TEST_OWNERSHIP_NAMESPACE;
    const child = fork(this.options.managerEntry ?? path.join(this.options.packageRoot, "dist", "manager.js"), [], {
      cwd: this.options.packageRoot, env, detached: true, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    this.child = child;
    this.exited = new Promise(resolve => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", error => resolve({ error }));
    });
    child.stderr.pipe(this.log, { end: false });
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Manager did not publish READY within 60 seconds.")), this.options.startupTimeoutMs ?? 60000);
      const finish = (error, value) => { clearTimeout(timeout); error ? reject(error) : resolve(value); };
      lines.on("line", line => {
        if (line.length > 65536) return finish(new Error("Manager output line is too large."));
        this.log.write(`${line}\n`);
        if (!line.startsWith(READY_PREFIX)) return;
        try { finish(null, validateReady(JSON.parse(line.slice(READY_PREFIX.length)), this.generation, child.pid)); }
        catch (error) { finish(error); }
      });
      child.once("error", error => finish(error));
      child.once("exit", () => finish(new Error("Manager exited before readiness.")));
    });
    if (Number.isInteger(child.pid)) {
      child.rabiStartTime = processIdentity(child.pid)?.start;
      if (!child.rabiStartTime) {
        child.kill(); await ready.catch(() => {});
        throw new Error("Linux Host cannot verify its child process through /proc.");
      }
    }
    const descriptor = await ready;
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60000);
    let failure;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null && !this.stopping) {
      try {
        const state = validateMeta(await requestJson(`${descriptor.baseUrl}/meta`), descriptor);
        this.ready = descriptor; this.state = state;
        this.exited.then(() => { if (this.child === child && !this.stopping) void this.recover(); });
        return;
      } catch (error) { failure = error; await delay(200); }
    }
    throw new Error(`Manager required-readiness admission failed: ${failure?.message ?? "Manager stopped"}`);
  }

  async recover() {
    if (this.stopping) return;
    this.transition = this.transition.then(async () => {
      if (this.stopping) return;
      this.state = "recovering";
      this.failures = this.failures.filter(at => at > Date.now() - 15 * 60 * 1000);
      this.failures.push(Date.now());
      await this.stopGeneration();
      if (this.failures.length >= 5) { this.state = "faulted"; this.lastError = "Five generation failures within 15 minutes; run restart explicitly."; return; }
      await delay(Math.min(1000 * 2 ** (this.failures.length - 1), 10000));
      if (this.stopping) return;
      try { await this.startGeneration(); }
      catch (error) { this.lastError = error.message; setImmediate(() => void this.recover()); }
    }).catch(error => { this.state = "faulted"; this.lastError = error.message; });
  }

  async stopGeneration() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const exited = this.exited;
    if (!Number.isInteger(child.pid)) { await exited; this.ready = null; return; }
    if (child.exitCode === null && child.signalCode === null && this.ready) {
      await requestJson(`${this.ready.baseUrl}/_rabiroute/host/shutdown`, {
        method: "POST", headers: { "x-rabiroute-host-token": this.managerControlToken }, body: ""
      }).catch(() => {});
    }
    // The leader may already have exited while its owned descendants remain.
    signalOwnedGroup(child, "SIGTERM");
    const deadline = Date.now() + (this.options.stopTimeoutMs ?? 12000);
    while (liveGroupMembers(child.pid).length && Date.now() < deadline) await delay(50);
    if (liveGroupMembers(child.pid).length) {
      signalOwnedGroup(child, "SIGKILL");
      const killDeadline = Date.now() + 2000;
      while (liveGroupMembers(child.pid).length && Date.now() < killDeadline) await delay(25);
      if (liveGroupMembers(child.pid).length) throw new Error("Owned Manager process group did not stop.");
    }
    await exited;
    this.ready = null;
  }

  async close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      await this.stopGeneration();
      this.state = "stopped";
      if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
      try {
        if (readDescriptor(this.options.descriptorFile).hostInstanceId === this.id) fs.unlinkSync(this.options.descriptorFile);
      } catch (error) { if (error.code !== "ENOENT") this.lastError = "Could not remove the Host control descriptor."; }
      await new Promise(resolve => this.log ? this.log.end(resolve) : resolve());
      await this.options.lease.release();
      this.options.onClose?.();
    })();
    return this.closing;
  }
}
