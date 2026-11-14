import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";

test("HA prerequisites use the current owner without sending environment credentials", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
  const requests = [];
  let origin, generation = "generation-a", healthStatus = "ready", redirect = false, changeGeneration = false, metaReads = 0;
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (redirect && req.url.endsWith("/health")) { res.writeHead(302, { location: origin + "/unexpected" }); res.end(); return; }
    let body;
    if (req.url === "/meta") {
      metaReads++;
      body = { managerBaseUrl: origin, applicationGenerationId: changeGeneration && metaReads > 1 ? "generation-b" : generation, managerInstanceId: "manager-a", health: { live: true, state: "degraded" } };
    } else if (req.url.endsWith("/health")) {
      body = { code: 0, data: { status: healthStatus, baseUrl: healthStatus === "ready" ? origin : "http://127.0.0.1:1", tokenConfigured: true, credentialSource: "protected", cameraCapture: { enabled: true, ready: true } } };
    } else if (req.url.endsWith("/deployment")) {
      body = { code: 0, data: { state: healthStatus === "ready" ? "ready" : "error", baseUrl: healthStatus === "ready" ? origin : "http://127.0.0.1:8123" } };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const run = async (extra = []) => {
    metaReads = 0;
    const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/Test-XiaomiHomePrerequisites.ps1"), "-ManagerBaseUrl", origin, ...extra], {
      windowsHide: true, timeout: 15000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RABIROUTE_XIAOMI_HOME_HA_TOKEN: "fixture-secret-never-forward", RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN: "fixture-artifact-secret-never-forward" }
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", error => { stderr += error.message; });
    const code = await new Promise(resolve => child.once("close", resolve));
    assert.ok(!stdout.includes("fixture-secret") && !stderr.includes("fixture-secret"));
    return { code, stdout, stderr };
  };
  let result = await run(); assert.equal(result.code, 0, result.stderr);
  let report = JSON.parse(result.stdout);
  assert.equal(report.homeAssistant.baseUrl, origin);
  assert.equal(report.homeAssistant.authenticated, true);
  assert.equal(report.homeAssistant.source, "manager-owner");
  assert.equal(report.cameraArtifacts.ffprobeRequired, false);
  assert.ok(!/environment variable|Create a Home Assistant/.test(report.nextAction));
  assert.ok(requests.every(request => ["/meta", "/api/agent/xiaomi-home/health", "/api/agent/xiaomi-home/deployment"].includes(request.url)));
  assert.ok(requests.every(request => !request.authorization));

  const explicitTarget = http.createServer((_req, res) => { assert.fail("Explicit unrelated HTTP target must not receive a request"); res.end(); });
  await new Promise(resolve => explicitTarget.listen(0, "127.0.0.1", resolve));
  try {
    result = await run(["-HomeAssistantBaseUrl", `http://127.0.0.1:${explicitTarget.address().port}`]);
    assert.equal(result.code, 0, result.stderr); report = JSON.parse(result.stdout);
    assert.equal(report.homeAssistant.reachable, true);
    assert.equal(report.homeAssistant.authenticationChecked, false);
    assert.equal(report.homeAssistant.authenticated, null);
  } finally { await new Promise(resolve => explicitTarget.close(resolve)); }

  healthStatus = "unreachable";
  result = await run(); assert.equal(result.code, 0, result.stderr); report = JSON.parse(result.stdout);
  assert.equal(report.homeAssistant.baseUrl, "");
  assert.equal(report.homeAssistant.reachable, false);
  healthStatus = "ready";
  redirect = true; result = await run(); assert.notEqual(result.code, 0);
  assert.ok(!requests.some(request => request.url === "/unexpected"));
  redirect = false; changeGeneration = true; result = await run(); assert.notEqual(result.code, 0);
  assert.match(result.stderr, /lifecycle changed/);
});
