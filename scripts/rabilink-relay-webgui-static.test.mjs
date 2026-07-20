import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`relay exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Relay is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not become healthy");
}

test("remote WebGUI serves bundled reports below the authenticated PC prefix", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rabilink-relay-webgui-static-"));
  const dataDirectory = path.join(directory, "data");
  const webguiDirectory = path.join(directory, "webgui");
  fs.mkdirSync(path.join(webguiDirectory, "reports"), { recursive: true });
  fs.writeFileSync(path.join(webguiDirectory, "index.html"), "<!doctype html><html><head></head><body>WebGUI</body></html>");
  fs.writeFileSync(path.join(webguiDirectory, "reports", "sample.html"), "<!doctype html><title>Speech report</title>");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("scripts/rabilink-relay-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      RABILINK_RELAY_DATA_DIR: dataDirectory,
      RABILINK_RELAY_WEBGUI_DIST_DIR: webguiDirectory
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForHealth(baseUrl, child);
    const accountResponse = await fetch(`${baseUrl}/manage/api/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "docs-test", password: "strong-test-password" })
    });
    assert.equal(accountResponse.status, 200);
    const cookie = String(accountResponse.headers.get("set-cookie") || "").split(";")[0];

    const appResponse = await fetch(`${baseUrl}/manage/api/apps`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Docs app" })
    });
    assert.equal(appResponse.status, 200);
    const token = (await appResponse.json()).app.token;

    const workerResponse = await fetch(`${baseUrl}/worker/tasks?deviceId=pc-docs&deviceGuid=guid-docs&deviceName=Docs%20PC&waitMs=0`, {
      headers: { "x-rabilink-token": token }
    });
    assert.equal(workerResponse.status, 200);

    const remotePrefix = `${baseUrl}/manage/docs-test/guid-docs`;
    const indexResponse = await fetch(`${remotePrefix}/`, { headers: { cookie } });
    assert.equal(indexResponse.status, 200);
    assert.match(await indexResponse.text(), /<base href="\/manage\/docs-test\/guid-docs\/">/);

    const reportResponse = await fetch(`${remotePrefix}/reports/sample.html`, { headers: { cookie } });
    assert.equal(reportResponse.status, 200);
    assert.equal(reportResponse.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(reportResponse.headers.get("cache-control"), "no-store");
    assert.match(await reportResponse.text(), /Speech report/);

    const reportHead = await fetch(`${remotePrefix}/reports/sample.html`, { method: "HEAD", headers: { cookie } });
    assert.equal(reportHead.status, 200);
    assert.equal(await reportHead.text(), "");

    const missingResponse = await fetch(`${remotePrefix}/reports/missing.html`, { headers: { cookie } });
    assert.equal(missingResponse.status, 404);
    const traversalResponse = await fetch(`${remotePrefix}/reports/%252e%252e%252findex.html`, { headers: { cookie } });
    assert.equal(traversalResponse.status, 404);
    const anonymousResponse = await fetch(`${remotePrefix}/reports/sample.html`, { redirect: "manual" });
    assert.equal(anonymousResponse.status, 302);
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(stderr.includes("SyntaxError"), false, stderr);
});
