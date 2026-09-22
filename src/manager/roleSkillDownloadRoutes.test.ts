import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import test, { type TestContext } from "node:test";
import { authorizeAgentApiOperation } from "./agentApiPolicy.js";
import { parseRoleSkillDownloadRoute } from "./roleKnowledgeRoute.js";
import { authorizeLanAgentRoleSkillRequest } from "./lanAgentRoleSkillAccess.js";
import { remoteAgentTargetKey } from "../shared/routeAgentTargets.js";
import { handleRoleSkillDownloadApi, RoleSkillDownloadAdmission, type RoleSkillArchiveReply } from "./roleSkillDownloadRoutes.js";
import { ManagerReadWorkerPool, ManagerReadWorkerError } from "./managerReadWorkerPool.js";

const principal = { kind: "agent", nodeId: "fixture-node", agentId: "fixture-agent" } as const;
const binding = { instanceId: principal.nodeId, agentId: principal.agentId };
const definitions = [{ persona: "example", remoteAgentTargets: [{ ...binding, id: remoteAgentTargetKey(binding), provider: "codex" as const }] }];
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
};
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-route-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const temporaryRoot = path.join(root, "temp");
  const roleDir = path.join(root, "role");
  await fs.mkdir(temporaryRoot);
  await fs.mkdir(path.join(roleDir, "skills", "bundle", "scripts"), { recursive: true });
  await fs.writeFile(path.join(roleDir, "skills", "bundle", "SKILL.md"), "---\nid: selected\ntitle: Example\nsummary: Example bundle\nkeywords: [fixture]\n---\n# Example\n");
  await fs.writeFile(path.join(roleDir, "skills", "bundle", "scripts", "check.ps1"), "# test only\n");
  return { roleDir, temporaryRoot };
}
async function serve(t: TestContext, listener: http.RequestListener) {
  const server = http.createServer(listener);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function cleaned(directory: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await fs.readdir(directory)).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await fs.readdir(directory), [], "private request artifact was not cleaned");
}

test("real worker HTTP ZIP requires persona binding before any read, preserves both aliases and 404", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const pool = new ManagerReadWorkerPool({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 5000 });
  t.after(() => pool.stop());
  let reads = 0;
  let cleanupErrors = 0;
  const base = await serve(t, (request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    if (url.pathname === "/meta") {
      json(response, 200, { applicationGenerationId: "fixture-generation", managerInstanceId: "fixture-instance",
        health: { live: true, requiredReady: true, state: "healthy" } });
      return;
    }
    const policy = authorizeAgentApiOperation(request.method!, request.url!);
    if (!policy.allowed) { json(response, 403, { code: -1 }); return; }
    const guard = authorizeLanAgentRoleSkillRequest(principal, request.method, url.pathname, definitions, item => item.persona);
    if (!guard.allowed) { json(response, guard.status, { code: -1, error: guard.error }); return; }
    if (!handleRoleSkillDownloadApi(request, url.pathname, response, {
      ...f, roleDirectory: () => f.roleDir, json, reportCleanupError: () => { cleanupErrors++; },
      archive: (roleDir, skillId, outputPath, options) => {
        reads++;
        return pool.run<RoleSkillArchiveReply>({ type: "role_skill_archive", roleDir, skillId, outputPath }, options);
      }
    })) json(response, 404, {});
  });
  for (const prefix of ["/api/roles", "/roles"]) {
    const denied = await fetch(`${base}${prefix}/other/skills/selected/download`);
    assert.equal(denied.status, 403); await denied.arrayBuffer();
  }
  assert.equal(reads, 0);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
  for (const prefix of ["/api/roles", "/roles"]) {
    const response = await fetch(`${base}${prefix}/example/skills/selected/download`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/zip");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32LE(), 0x04034b50);
    assert.equal(bytes.length, Number(response.headers.get("content-length")));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), response.headers.get("x-rabiroute-content-sha256"));
    assert.match(response.headers.get("content-disposition")!, /attachment;.*selected.zip/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const missing = await fetch(`${base}${prefix}/example/skills/missing/download`);
    assert.equal(missing.status, 404); await missing.arrayBuffer();
  }
  const injected = await fetch(`${base}/api/roles/example/skills/selected/download?path=other`);
  assert.equal(injected.status, 403); await injected.arrayBuffer();
  // Exercise the real registered connector's --api/--output path against this real reader HTTP route.
  const configPath = path.join(path.dirname(f.roleDir), "connector.json");
  const outputPath = path.join(path.dirname(f.roleDir), "selected.zip");
  const receiptPath = path.join(path.dirname(f.roleDir), "receipt.json");
  await fs.writeFile(configPath, JSON.stringify({ managerUrl: base, nodeCredential: "fixture-only-credential", agents: [{ agentId: principal.agentId }] }));
  const cliArgs = ["--api", "GET", "/api/roles/example/skills/selected/download", "--agent", principal.agentId, "--output", outputPath];
  const command = "const {runManagerCommand}=await import(process.argv[1]);const receipt=await runManagerCommand(JSON.parse(process.argv[2]),process.argv[3]);const fs=await import('node:fs/promises');await fs.writeFile(process.argv[4],JSON.stringify(receipt));";
  const child = spawn(process.execPath, ["--input-type=module", "--eval", command,
    new URL("../../apps/rabi-agent/lib/manager-cli.mjs", import.meta.url).href, JSON.stringify(cliArgs), configPath, receiptPath], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Connector fixture exited ${code}`)));
  });
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  const saved = await fs.readFile(outputPath);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.sizeBytes, saved.length);
  assert.equal(receipt.sha256, createHash("sha256").update(saved).digest("hex"));
  await cleaned(f.temporaryRoot);
  assert.equal(cleanupErrors, 0);
});

test("invalid download paths fail before role resolution or temporary creation in guard and handler", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let resolved = 0;
  let archived = 0;
  let localMode = false;
  const base = await serve(t, (request, response) => {
    const pathname = request.url!;
    if (!localMode) {
      const access = authorizeLanAgentRoleSkillRequest(principal, request.method, pathname, definitions, item => item.persona);
      if (!access.allowed) { json(response, access.status, { error: access.error }); return; }
    }
    handleRoleSkillDownloadApi(request, pathname, response, {
      ...f, json, reportCleanupError: () => assert.fail("cleanup failed"),
      roleDirectory: () => { resolved++; return f.roleDir; },
      archive: async () => { archived++; return { ok: false, code: "not_found" }; }
    });
  });
  for (const mode of [false, true]) {
    localMode = mode;
    for (const raw of ["/roles/%ZZ/skills/selected/download", "/roles/example/skills/%ZZ/download",
      "/roles/example%2fother/skills/selected/download", "/roles/example/skills/..%2fother/download",
      "/roles/../skills/selected/download", "/roles/example/skills/C%3a%5cfile/download",
      "/roles/%20example/skills/selected/download", "/roles/example/skills/%252e%252e/download"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.get(new URL(base), { path: raw }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
        request.once("error", reject);
      });
      assert.equal(status, 403, raw);
    }
  }
  assert.equal(resolved, 0); assert.equal(archived, 0);
  assert.deepEqual(await fs.readdir(f.temporaryRoot), []);
  assert.deepEqual(parseRoleSkillDownloadRoute(`/roles/${encodeURIComponent("示例人格")}/skills/${encodeURIComponent("示例技能")}/download`), {
    roleId: "示例人格", skillId: "示例技能"
  });
});

test("download policy denies encoded paths, queries, other methods; persona guard covers download", () => {
  for (const prefix of ["/api/roles", "/roles"]) {
    assert.equal(authorizeAgentApiOperation("GET", `${prefix}/example/skills/selected/download`).allowed, true);
    for (const id of ["..%2fother", "C%3a%5cother", "%2fetc%2fpasswd", "%252e%252e", "bad%00id"]) {
      assert.equal(authorizeAgentApiOperation("GET", `${prefix}/example/skills/${id}/download`).allowed, false, id);
    }
    assert.equal(authorizeAgentApiOperation("POST", `${prefix}/example/skills/selected/download`).allowed, false);
    assert.equal(authorizeAgentApiOperation("GET", `${prefix}/example/skills/selected/download?file=x`).allowed, false);
    assert.equal(authorizeLanAgentRoleSkillRequest({ ...principal, nodeId: "other-node" }, "GET", `${prefix}/example/skills/selected/download`, definitions, item => item.persona).allowed, false);
  }
});

test("known worker results map to 403/404/409/413 and busy/timeout to 503 without partial ZIP", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const base = await serve(t, (req, res) => {
    const code = new URL(req.url!, "http://fixture.invalid").pathname.split("/")[5];
    handleRoleSkillDownloadApi(req, new URL(req.url!, "http://fixture.invalid").pathname, res, {
      ...f, roleDirectory: () => f.roleDir, json, reportCleanupError: () => assert.fail("cleanup failed"),
      archive: async () => {
        if (code === "busy" || code === "timeout") throw new ManagerReadWorkerError("Unavailable", code);
        return { ok: false, code: code as "not_found" | "unsafe_path" | "conflict" | "too_large" };
      }
    });
  });
  for (const [code, status] of [["not_found", 404], ["unsafe_path", 403], ["conflict", 409], ["too_large", 413], ["busy", 503], ["timeout", 503]] as const) {
    const response = await fetch(`${base}/api/roles/example/skills/${code}/download`);
    assert.equal(response.status, status, code);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.equal((await response.json()).code, -1);
  }
  await cleaned(f.temporaryRoot);
});

test("unconfirmed termination quarantines artifact until actual worker-release callback", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const admission = new RoleSkillDownloadAdmission(1);
  let released!: () => void;
  const base = await serve(t, (req, res) => {
    handleRoleSkillDownloadApi(req, new URL(req.url!, "http://fixture.invalid").pathname, res, {
      ...f, admission, roleDirectory: () => f.roleDir, json, reportCleanupError: () => assert.fail("cleanup failed"),
      archive: async (_role, _skill, output, options) => {
        await fs.writeFile(output, "private partial fixture");
        released = options.onWorkerReleased;
        throw new ManagerReadWorkerError("Unconfirmed", "termination_unconfirmed");
      }
    });
  });
  const response = await fetch(`${base}/roles/example/skills/selected/download`);
  assert.equal(response.status, 503); await response.arrayBuffer();
  assert.equal((await fs.readdir(f.temporaryRoot)).length, 1);
  assert.equal(admission.active, 1);
  const denied = await fetch(`${base}/roles/example/skills/selected/download`);
  assert.equal(denied.status, 503);
  assert.equal((await denied.json()).error, "SKILL_DOWNLOAD_BUSY");
  assert.equal((await fs.readdir(f.temporaryRoot)).length, 1);
  released();
  await cleaned(f.temporaryRoot);
  assert.equal(admission.active, 0);
});

test("client abort cancels archive generation, does not write JSON, and cleans the lease", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let notify!: () => void;
  const started = new Promise<void>(resolve => { notify = resolve; });
  let aborted = false;
  let writes = 0;
  const base = await serve(t, (req, res) => {
    handleRoleSkillDownloadApi(req, new URL(req.url!, "http://fixture.invalid").pathname, res, {
      ...f, roleDirectory: () => f.roleDir, json: () => { writes++; }, reportCleanupError: () => assert.fail("cleanup failed"),
      archive: (_role, _skill, _output, { signal, onWorkerReleased }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true; onWorkerReleased(); reject(new ManagerReadWorkerError("Aborted", "aborted"));
        }, { once: true });
        notify();
      })
    });
  });
  const controller = new AbortController();
  const result = assert.rejects(fetch(`${base}/roles/example/skills/selected/download`, { signal: controller.signal }));
  await started; controller.abort(); await result;
  await cleaned(f.temporaryRoot);
  assert.equal(aborted, true); assert.equal(writes, 0);
});

test("disconnect during ZIP streaming cleans the completed private artifact", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  let errors = 0;
  const base = await serve(t, (req, res) => {
    handleRoleSkillDownloadApi(req, new URL(req.url!, "http://fixture.invalid").pathname, res, {
      ...f, roleDirectory: () => f.roleDir, json, reportCleanupError: () => { errors++; },
      archive: async (_role, _skill, output, options) => {
        const bytes = Buffer.alloc(8 * 1024 * 1024);
        bytes.writeUInt32LE(0x04034b50);
        await fs.writeFile(output, bytes);
        options.onWorkerReleased();
        return { ok: true, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), fileCount: 1 };
      }
    });
  });
  const response = await fetch(`${base}/roles/example/skills/selected/download`);
  assert.equal(response.status, 200);
  await response.body!.cancel();
  await cleaned(f.temporaryRoot);
  assert.equal(errors, 0);
});

test("slow clients retain bounded admission; transfer deadline cleans and releases without creating excess leases", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const admission = new RoleSkillDownloadAdmission(1);
  let generated = 0;
  let cleanupErrors = 0;
  const base = await serve(t, (req, res) => {
    handleRoleSkillDownloadApi(req, new URL(req.url!, "http://fixture.invalid").pathname, res, {
      ...f, admission, transferTimeoutMs: 300, roleDirectory: () => f.roleDir, json,
      reportCleanupError: () => { cleanupErrors++; },
      archive: async (_role, _skill, output, options) => {
        generated++;
        if (process.platform !== "win32") assert.equal((await fs.stat(path.dirname(output))).mode & 0o777, 0o700);
        const bytes = Buffer.alloc(16 * 1024 * 1024);
        bytes.writeUInt32LE(0x04034b50);
        await fs.writeFile(output, bytes);
        options.onWorkerReleased();
        return { ok: true, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), fileCount: 1 };
      }
    });
  });
  const slow = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(`${base}/roles/example/skills/selected/download`, response => { response.pause(); resolve(response); });
    request.once("error", reject);
  });
  t.after(() => slow.destroy());
  assert.equal(slow.statusCode, 200);
  assert.equal(admission.active, 1);
  const rejected = await fetch(`${base}/roles/example/skills/selected/download`);
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).error, "SKILL_DOWNLOAD_BUSY");
  assert.equal(generated, 1);
  assert.equal((await fs.readdir(f.temporaryRoot)).length, 1);
  await cleaned(f.temporaryRoot);
  assert.equal(admission.active, 0);
  assert.equal(cleanupErrors, 0);
});
