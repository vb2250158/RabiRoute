import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DSH_BASE_URL, discoverLocalDsh, resolveDshBaseUrl } from "./dshDiscovery.js";

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-discovery-"));
}

test("DSH discovery reads the current launch log and strips the login token", () => {
  const homeDir = tempHome();
  fs.mkdirSync(path.join(homeDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, "profiles", "web", "package.json"), "{}\n");
  fs.writeFileSync(
    path.join(homeDir, "logs", "web-host.stdout.log"),
    "dsh web: http://127.0.0.1:3180/?token=secret-login-token\n"
  );

  const discovery = discoverLocalDsh({ homeDir, env: {} });
  assert.equal(discovery.installed, true);
  assert.deepEqual(discovery.discoveredBaseUrls, ["http://127.0.0.1:3180"]);
  assert.equal(discovery.installCandidates.some((item) => item.path?.includes("profiles")), true);
  assert.doesNotMatch(JSON.stringify(discovery), /secret-login-token/);
});

test("DSH discovery prefers the current log over an older default-port banner", () => {
  const homeDir = tempHome();
  const logsDir = path.join(homeDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "dsh-web-20260829-001218.stdout.log"), "dsh web: http://127.0.0.1:3080\n");
  fs.writeFileSync(path.join(logsDir, "web-host.stdout.log"), "dsh web: http://127.0.0.1:3180\n");

  const discovery = discoverLocalDsh({ homeDir, env: {} });
  assert.deepEqual(discovery.discoveredBaseUrls, ["http://127.0.0.1:3180", "http://127.0.0.1:3080"]);
  assert.equal(resolveDshBaseUrl(undefined, discovery), "http://127.0.0.1:3180");
  assert.equal(resolveDshBaseUrl("http://127.0.0.1:3080/", discovery), "http://127.0.0.1:3080");
});

test("DSH discovery treats a present Home as installed even when no owner is listening", () => {
  const homeDir = tempHome();
  fs.mkdirSync(path.join(homeDir, "profiles", "web"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, "profiles", "web", "package.json"), "{}\n");

  const discovery = discoverLocalDsh({ homeDir, env: {} });
  assert.equal(discovery.installed, true);
  assert.deepEqual(discovery.discoveredBaseUrls, []);
  assert.equal(resolveDshBaseUrl(undefined, discovery), DEFAULT_DSH_BASE_URL);
});

test("DSH discovery ignores non-loopback launch banners", () => {
  const homeDir = tempHome();
  fs.mkdirSync(path.join(homeDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, "logs", "web-host.stdout.log"), "dsh web: http://192.168.1.8:3180/?token=nope\n");

  const discovery = discoverLocalDsh({ homeDir, env: {} });
  assert.deepEqual(discovery.discoveredBaseUrls, []);
});
