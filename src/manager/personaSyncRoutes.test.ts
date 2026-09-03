import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { PersonaSyncService } from "../personaSync.js";
import type { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import {
  createActivePlanPackageCommandFromFiles,
  createArchivedPlanPackageCommandFromFiles,
  type PersonaSyncPlanPackageFile
} from "../personaSyncPlanPackage.js";
import { handlePersonaSyncApi } from "./personaSyncRoutes.js";

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function packageFile(relativePath: string, value: string): PersonaSyncPlanPackageFile {
  const content = Buffer.from(value, "utf8");
  return {
    path: relativePath,
    size: content.byteLength,
    sha256: sha256(content),
    contentBase64: content.toString("base64")
  };
}

function activePackage(roleId: string, planId: string, title = "Route active plan") {
  const recordedAt = "2026-08-31T00:00:00.000Z";
  const plan = {
    id: planId,
    title,
    focus: "Exercise the active plan package route",
    status: "执行中",
    createdAt: recordedAt,
    updatedAt: recordedAt,
    steps: [{ id: "route", title: "Route", status: "进行中" }],
    keywords: ["route"]
  };
  const history = {
    id: `created-${planId}`,
    planId,
    kind: "created",
    recordedAt,
    after: plan
  };
  return createActivePlanPackageCommandFromFiles(roleId, planId, [
    packageFile("plan.json", `${JSON.stringify(plan, null, 2)}\n`),
    packageFile("history.jsonl", `${JSON.stringify(history)}\n`)
  ], "route-peer");
}

function archivePackage(roleId: string, planId: string) {
  const createdAt = "2026-08-01T00:00:00.000Z";
  const completedAt = "2026-08-02T00:00:00.000Z";
  const archivedAt = "2026-08-31T00:00:00.000Z";
  const completed = {
    id: planId,
    title: "Route archived plan",
    focus: "Exercise the archive plan package route",
    status: "完成",
    createdAt,
    completedAt,
    updatedAt: completedAt,
    steps: [{ id: "done", title: "Done", status: "已完成" }],
    keywords: ["route", "archive"]
  };
  const archived = { ...completed, archiveStatus: "已归档", archivedAt, updatedAt: archivedAt };
  const history = [
    { id: `created-${planId}`, planId, kind: "created", recordedAt: completedAt, after: completed },
    { id: `archived-${planId}`, planId, kind: "archived", recordedAt: archivedAt, before: completed, after: archived }
  ];
  return createArchivedPlanPackageCommandFromFiles(roleId, planId, [
    packageFile("plan.json", `${JSON.stringify(archived, null, 2)}\n`),
    packageFile("history.jsonl", `${history.map(record => JSON.stringify(record)).join("\n")}\n`)
  ], "route-peer");
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port.");
  return address.port;
}

type TestHttpResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
};

async function request(
  port: number,
  pathname: string,
  options: { method?: string; json?: unknown } = {}
): Promise<TestHttpResponse> {
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);
  return await new Promise<TestHttpResponse>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method || "GET",
      headers: body === undefined
        ? undefined
        : {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body)
          }
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.once("end", () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("persona sync conflict control lets a local Agent inspect and resolve evidence", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-sync-routes-"));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "local\n", "utf8");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"));
  t.after(() => service.stopManifestIndex());
  await service.startManifestIndex();
  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    contentBase64: Buffer.from("remote\n").toString("base64"),
    baseHash: "unrelated-base",
    peerId: "pc-b"
  });
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(request, requestUrl, response, {
      service,
      coordinator: {
        preview: async () => ({
          peer: { id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] },
          transport: "lan" as const,
          files: [{
            roleId: "Rabi",
            path: "persona.md",
            operation: "pull_update" as const,
            direction: "pull" as const,
            mergeStrategy: "three-way-file" as const,
            localHash: "local",
            remoteHash: "remote"
          }],
          changedFiles: 1,
          conflicts: 0
        }),
        publishConflictResolution: async () => ({ status: "published" as const, peerId: "pc-b", transport: "lan" as const })
      } as unknown as PersonaSyncCoordinator,
      token: () => "shared-app-token",
      relay: () => ({ url: "", token: "shared-app-token", deviceId: "pc-a", deviceGuid: "guid-a" }),
      planStorageStartup: () => ({
        state: "ready",
        attempt: 1,
        incidents: 0,
        lastTransitionAt: "2026-09-01T00:00:00.000Z"
      })
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const manifestResponse = await request(port, "/api/persona-sync/manifest?roleId=Rabi");
  assert.equal(manifestResponse.status, 200);
  const indexResponse = await request(port, "/api/persona-sync/index-status");
  assert.equal(indexResponse.status, 200);
  const indexBody = JSON.parse(indexResponse.text) as { data: { state: string; files: number } };
  assert.equal(indexBody.data.state, "ready");
  assert.equal(indexBody.data.files, 1);
  const autoStatusResponse = await request(port, "/api/persona-sync/auto-status");
  assert.equal(autoStatusResponse.status, 200);
  const autoStatusBody = JSON.parse(autoStatusResponse.text) as { data: { state: string; pending: boolean } };
  assert.equal(autoStatusBody.data.state, "stopped");
  assert.equal(autoStatusBody.data.pending, false);

  const previewResponse = await request(port, "/api/persona-sync/preview?peerId=pc-b&roleId=Rabi");
  assert.equal(previewResponse.status, 200);
  const previewBody = JSON.parse(previewResponse.text) as { data: { changedFiles: number; files: Array<{ path: string; operation: string }> } };
  assert.equal(previewBody.data.changedFiles, 1);
  assert.deepEqual(previewBody.data.files.map(file => [file.path, file.operation]), [["persona.md", "pull_update"]]);

  const listResponse = await request(port, "/api/persona-sync/conflicts?roleId=Rabi");
  assert.equal(listResponse.status, 200);
  const listBody = JSON.parse(listResponse.text) as { data: { conflicts: Array<{ conflictId: string; localHash: string }> } };
  assert.equal(listBody.data.conflicts.length, 1);
  const conflict = listBody.data.conflicts[0]!;

  const contentResponse = await request(port, `/api/persona-sync/conflicts/content?conflictId=${encodeURIComponent(conflict.conflictId)}`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.text, "remote\n");
  const relativePathHeader = contentResponse.headers["x-rabi-relative-path"];
  assert.equal(decodeURIComponent(Array.isArray(relativePathHeader) ? relativePathHeader[0] || "" : relativePathHeader || ""), "persona.md");

  const resolveResponse = await request(port, "/api/persona-sync/conflicts/resolve", {
    method: "POST",
    json: {
      conflictId: conflict.conflictId,
      action: "keep_local",
      expectedLocalHash: conflict.localHash
    }
  });
  assert.equal(resolveResponse.status, 200);
  const resolveBody = JSON.parse(resolveResponse.text) as { data: { publish: { status: string } } };
  assert.equal(resolveBody.data.publish.status, "published");
  assert.equal(fs.readFileSync(path.join(roleDir, "persona.md"), "utf8"), "local\n");
  assert.equal(service.listConflicts("Rabi").length, 0);

  service.merge({
    roleId: "Rabi",
    path: "persona.md",
    deleted: true,
    remoteHash: "deleted",
    baseHash: "unrelated-base",
    peerId: "pc-b"
  });
  const deletionListResponse = await request(port, "/api/persona-sync/conflicts?roleId=Rabi");
  const deletionListBody = JSON.parse(deletionListResponse.text) as {
    data: { conflicts: Array<{ conflictId: string; localHash: string; remoteDeleted?: boolean; peerId?: string }> };
  };
  const deletionConflict = deletionListBody.data.conflicts[0]!;
  assert.equal(deletionConflict.remoteDeleted, true);
  assert.equal(deletionConflict.peerId, "pc-b");
  const deleteResponse = await request(port, "/api/persona-sync/conflicts/resolve", {
    method: "POST",
    json: {
      conflictId: deletionConflict.conflictId,
      action: "use_remote",
      expectedLocalHash: deletionConflict.localHash
    }
  });
  assert.equal(deleteResponse.status, 200);
  const deleteBody = JSON.parse(deleteResponse.text) as { data: { remoteDeleted?: boolean; publish: { status: string } } };
  assert.equal(deleteBody.data.remoteDeleted, true);
  assert.equal(deleteBody.data.publish.status, "published");
  assert.equal(fs.existsSync(path.join(roleDir, "persona.md")), false);
});

test("persona plan package routes apply canonical whole packages and generic merge rejects plan files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-package-routes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  const server = http.createServer((incoming, response) => {
    const requestUrl = new URL(incoming.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(incoming, requestUrl, response, {
      service,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "shared-app-token",
      relay: () => ({ url: "", token: "shared-app-token", deviceId: "pc-a", deviceGuid: "guid-a" }),
      planStorageStartup: () => ({
        state: "ready",
        attempt: 1,
        incidents: 0,
        lastTransitionAt: "2026-09-01T00:00:00.000Z"
      })
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const active = activePackage("Rabi", "route-active");
  const activeResponse = await request(port, "/api/persona-sync/plan-packages/active", {
    method: "POST",
    json: active
  });
  assert.equal(activeResponse.status, 200);
  const activeBody = JSON.parse(activeResponse.text) as { data: { status: string; planId: string; inventoryHash: string } };
  assert.deepEqual(
    [activeBody.data.status, activeBody.data.planId, activeBody.data.inventoryHash],
    ["applied", "route-active", active.inventoryHash]
  );
  const activePlanFile = path.join(roleDir, "plans", "active", "route-active", "plan.json");
  const activeHistoryFile = path.join(roleDir, "plans", "active", "route-active", "history.jsonl");
  assert.equal(fs.existsSync(activePlanFile), true);
  assert.equal(fs.existsSync(activeHistoryFile), true);
  const activePlanBefore = fs.readFileSync(activePlanFile);

  const genericMerge = await request(port, "/api/persona-sync/merge", {
    method: "POST",
    json: {
      roleId: "Rabi",
      path: "plans/active/route-active/plan.json",
      contentBase64: activePlanBefore.toString("base64"),
      remoteHash: sha256(activePlanBefore),
      peerId: "route-peer"
    }
  });
  assert.equal(genericMerge.status, 400);
  assert.match(genericMerge.text, /requires an atomic plan package/i);
  assert.deepEqual(fs.readFileSync(activePlanFile), activePlanBefore);

  const repeatedActive = await request(port, "/api/persona-sync/plan-packages/active", {
    method: "POST",
    json: active
  });
  assert.equal(repeatedActive.status, 200);
  assert.equal((JSON.parse(repeatedActive.text) as { data: { status: string } }).data.status, "unchanged");

  const divergentActive = await request(port, "/api/persona-sync/plan-packages/active", {
    method: "POST",
    json: activePackage("Rabi", "route-active", "Divergent route plan")
  });
  assert.equal(divergentActive.status, 409);
  assert.equal((JSON.parse(divergentActive.text) as { data: { status: string; reason: string } }).data.status, "conflict");
  assert.deepEqual(fs.readFileSync(activePlanFile), activePlanBefore);

  const archived = archivePackage("Rabi", "route-archive");
  const archiveResponse = await request(port, "/api/persona-sync/plan-packages/archive", {
    method: "POST",
    json: archived
  });
  assert.equal(archiveResponse.status, 200);
  const archiveBody = JSON.parse(archiveResponse.text) as { data: { status: string; planId: string; inventoryHash: string } };
  assert.deepEqual(
    [archiveBody.data.status, archiveBody.data.planId, archiveBody.data.inventoryHash],
    ["applied", "route-archive", archived.inventoryHash]
  );
  assert.equal(fs.existsSync(path.join(roleDir, "plans", "archive", "route-archive", "plan.json")), true);
  assert.equal(fs.existsSync(path.join(roleDir, "plans", "active", "route-archive")), false);
});

test("persona plan package mutation is rejected before body processing while startup recovery is pending", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-persona-plan-startup-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolesRoot = path.join(root, "roles");
  const service = new PersonaSyncService(() => rolesRoot, path.join(root, "state"), { watch: false });
  t.after(() => service.stopManifestIndex());
  const server = http.createServer((incoming, response) => {
    const requestUrl = new URL(incoming.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(incoming, requestUrl, response, {
      service,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "shared-app-token",
      relay: () => ({ url: "", token: "shared-app-token", deviceId: "pc-a", deviceGuid: "guid-a" }),
      planStorageStartup: () => ({
        state: "running",
        attempt: 1,
        incidents: 0,
        lastTransitionAt: "2026-09-01T00:00:00.000Z"
      })
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const response = await request(port, "/api/persona-sync/plan-packages/active", {
    method: "POST",
    json: { shouldNeverBeParsedAsAPlanPackage: true }
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers["retry-after"], "1");
  assert.equal((JSON.parse(response.text) as { error: string }).error, "PLAN_STORAGE_STARTUP_UNAVAILABLE");
  assert.equal(fs.existsSync(rolesRoot), false);
});

test("persona manifest endpoint reads only the published snapshot and fails closed while the first worker refresh is running", async (t) => {
  const service = {
    manifest: () => {
      throw new Error("GET must not invoke manifest refresh work.");
    },
    publishedManifestSnapshot: () => ({
      publication: {
        executionMode: "child_process",
        available: false,
        revision: 0,
        state: "refreshing",
        stale: false,
        refreshStartedAt: new Date(0).toISOString(),
        workerPid: 1234,
        deadlineMs: 5_000
      }
    })
  } as unknown as PersonaSyncService;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(request, requestUrl, response, {
      service,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "",
      relay: () => ({ url: "", token: "", deviceId: "", deviceGuid: "" })
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const startedAt = Date.now();
  const response = await request(port, "/api/persona-sync/manifest");
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(response.status, 503);
  const body = JSON.parse(response.text) as { code: number; data?: unknown; scan: Record<string, unknown> };
  assert.equal(body.code, -1);
  assert.equal(body.data, undefined);
  assert.deepEqual(body.scan, {
    state: "refreshing",
    partial: false,
    revision: 0,
    stale: false,
    refreshStartedAt: new Date(0).toISOString(),
    deadlineMs: 5_000
  });
});

test("persona manifest GET has a static memory-only boundary", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src", "manager", "personaSyncRoutes.ts"), "utf8");
  const start = source.indexOf('requestUrl.pathname === "/api/persona-sync/manifest"');
  const end = source.indexOf("const fileMatch", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.match(route, /publishedManifestSnapshot\(roleId\)/);
  assert.doesNotMatch(route, /\.manifest\(|reconcile|physicalPlanScopes|withPlanStorageLease|createHash|\bfs\./);
});

test("authenticated WebGUI control plane may compare persona folders without opening diagnostics on the LAN data plane", async (t) => {
  const service = {} as PersonaSyncService;
  const coordinator = {
    preview: async () => ({
      peer: { id: "pc-b", name: "Peer B", online: true, capabilities: ["persona-sync"], peerUrls: [] },
      transport: "lan" as const,
      files: [],
      changedFiles: 0,
      conflicts: 0
    })
  } as unknown as PersonaSyncCoordinator;
  const createServer = (controlPlaneAuthorized: boolean) => http.createServer((request, response) => {
    Object.defineProperty(request.socket, "remoteAddress", { value: "192.168.1.20" });
    const requestUrl = new URL(request.url || "/", "http://pc.local");
    if (!handlePersonaSyncApi(request, requestUrl, response, {
      service,
      coordinator,
      controlPlaneAuthorized,
      token: () => "relay-secret",
      relay: () => ({ url: "", token: "relay-secret", deviceId: "pc-a", deviceGuid: "guid-a" })
    })) response.writeHead(404).end();
  });

  const webguiServer = createServer(true);
  const webguiPort = await listen(webguiServer);
  t.after(() => new Promise<void>(resolve => webguiServer.close(() => resolve())));
  const allowed = await request(webguiPort, "/api/persona-sync/preview?peerId=pc-b&roleId=Rabi");
  assert.equal(allowed.status, 200);

  const lanServer = createServer(false);
  const lanPort = await listen(lanServer);
  t.after(() => new Promise<void>(resolve => lanServer.close(() => resolve())));
  const denied = await request(lanPort, "/api/persona-sync/preview?peerId=pc-b&roleId=Rabi");
  assert.equal(denied.status, 401);
});

test("persona conflict catalog returns a bounded building state instead of holding the HTTP connection", async (t) => {
  const service = {
    listConflictsAsync: () => new Promise(() => undefined),
    conflictListSnapshot: () => []
  } as unknown as PersonaSyncService;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(request, requestUrl, response, {
      service,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "",
      relay: () => ({ url: "", token: "", deviceId: "", deviceGuid: "" }),
      conflictListDeadlineMs: 20
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const startedAt = Date.now();
  const response = await request(port, "/api/persona-sync/conflicts?roleId=Rabi");
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(response.status, 202);
  const body = JSON.parse(response.text) as { data: { conflicts: unknown[]; scan: { state: string; partial: boolean; retryAfterMs: number } } };
  assert.deepEqual(body.data.conflicts, []);
  assert.deepEqual(body.data.scan, {
    state: "building",
    partial: true,
    retryAfterMs: 1_000,
    message: "Conflict history is being organized in the background; Manager remains available."
  });
});

test("persona conflict worker scans start after the HTTP building response", async (t) => {
  let scans = 0;
  const service = {
    conflictListSnapshot: () => undefined
  } as unknown as PersonaSyncService;
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (!handlePersonaSyncApi(request, requestUrl, response, {
      service,
      coordinator: {} as PersonaSyncCoordinator,
      token: () => "",
      relay: () => ({ url: "", token: "", deviceId: "", deviceGuid: "" }),
      conflictScheduleDelayMs: 10,
      listConflicts: async () => {
        scans += 1;
        return [];
      }
    })) response.writeHead(404).end();
  });
  const port = await listen(server);
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const startedAt = Date.now();
  const response = await request(port, "/api/persona-sync/conflicts?roleId=Rabi");
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(response.status, 202);
  assert.equal(scans, 0);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(scans, 1);
});
