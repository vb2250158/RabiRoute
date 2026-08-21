import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDesktopLifecycleIntent } from "./desktopLifecycleIntent.js";
import { handleDesktopLifecycleApi } from "./desktopLifecycleRoutes.js";

async function startServer(rootDir: string, shutdownReasons: string[]) {
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (handleDesktopLifecycleApi(request, requestUrl, response, {
      rootDir,
      shutdownManager: async (reason) => { shutdownReasons.push(reason); },
      shutdownDelayMs: 0
    })) return;
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("desktop start and explicit desktop exit persist intent before shutdown", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-routes-"));
  const shutdownReasons: string[] = [];
  const app = await startServer(rootDir, shutdownReasons);
  try {
    const startResponse = await fetch(`${app.baseUrl}/manager/desktop-lifecycle/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "windows-desktop" })
    });
    assert.equal(startResponse.status, 200);
    assert.equal(readDesktopLifecycleIntent(rootDir)?.desiredState, "running");
    assert.equal(readDesktopLifecycleIntent(rootDir)?.source, "windows-desktop");

    const exitResponse = await fetch(`${app.baseUrl}/manager/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ desktopExit: true })
    });
    assert.equal(exitResponse.status, 200);
    assert.equal(readDesktopLifecycleIntent(rootDir)?.desiredState, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(shutdownReasons, ["api"]);
  } finally {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("non-desktop Manager shutdown preserves the running desktop intent", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-desktop-routes-"));
  const shutdownReasons: string[] = [];
  const app = await startServer(rootDir, shutdownReasons);
  try {
    await fetch(`${app.baseUrl}/manager/desktop-lifecycle/start`, { method: "POST" });
    const response = await fetch(`${app.baseUrl}/manager/shutdown`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(readDesktopLifecycleIntent(rootDir)?.desiredState, "running");
  } finally {
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
