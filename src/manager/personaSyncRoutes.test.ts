import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonaSyncService } from "../personaSync.js";
import type { PersonaSyncCoordinator } from "../personaSyncCoordinator.js";
import { handlePersonaSyncApi } from "./personaSyncRoutes.js";

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
        publishConflictResolution: async () => ({ status: "published" as const, peerId: "pc-b", transport: "lan" as const })
      } as unknown as PersonaSyncCoordinator,
      token: () => "shared-app-token",
      relay: () => ({ url: "", token: "shared-app-token", deviceId: "pc-a", deviceGuid: "guid-a" })
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
