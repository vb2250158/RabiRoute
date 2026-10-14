import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptLinuxNapcatLaunch,
  detectLinuxNapcatQqRoots,
  filterLinuxNapcatProcesses,
  linuxNapcatConfigDir,
  napcatHostMode,
  validateExternalNapcatEndpoint
} from "./napcatPlatform.js";

test("instances without launch command are external NapCat (Docker/remote)", () => {
  assert.equal(napcatHostMode({}), "external");
  assert.equal(napcatHostMode({ launchCommand: "  " }), "external");
  assert.equal(napcatHostMode({ launchCommand: "/opt/QQ/qq" }), "local-shell");
});

test("Linux QQ root detection requires both qq binary and napcat entry", () => {
  const files = new Set([
    "/home/u/Napcat/opt/QQ/qq",
    "/home/u/Napcat/opt/QQ/resources/app/app_launcher/napcat/napcat.mjs",
    "/opt/QQ/qq"
  ]);
  const roots = detectLinuxNapcatQqRoots("/home/u", "/srv/rabi", file => files.has(file));
  assert.deepEqual(roots, ["/home/u/Napcat/opt/QQ"]);
  assert.equal(linuxNapcatConfigDir("/opt/QQ"), "/opt/QQ/resources/app/app_launcher/napcat/config");
});

test("Linux QQ launch adds sandbox flag, quick login and xvfb wrapper when headless", () => {
  const plan = adaptLinuxNapcatLaunch({ commandPath: "/opt/QQ/qq", args: [], botUserId: "10000", xvfbRun: "/usr/bin/xvfb-run" });
  assert.equal(plan.commandPath, "/usr/bin/xvfb-run");
  assert.deepEqual(plan.args, ["-a", "/opt/QQ/qq", "--no-sandbox", "-q", "10000"]);
  assert.deepEqual(plan.warnings, []);
});

test("Linux QQ launch keeps existing args and skips xvfb with a display", () => {
  const plan = adaptLinuxNapcatLaunch({ commandPath: "qq", args: ["--no-sandbox", "-q", "10000"], botUserId: "10000", hasDisplay: true });
  assert.equal(plan.commandPath, "qq");
  assert.deepEqual(plan.args, ["--no-sandbox", "-q", "10000"]);
});

test("Linux QQ launch warns when headless without xvfb-run", () => {
  const plan = adaptLinuxNapcatLaunch({ commandPath: "/opt/QQ/qq", args: [] });
  assert.equal(plan.commandPath, "/opt/QQ/qq");
  assert.equal(plan.warnings.length, 1);
});

test("non-QQ commands pass through unchanged", () => {
  const plan = adaptLinuxNapcatLaunch({ commandPath: "/usr/bin/docker", args: ["compose", "up", "-d"], botUserId: "10000" });
  assert.deepEqual(plan, { commandPath: "/usr/bin/docker", args: ["compose", "up", "-d"], warnings: [] });
});

test("Linux process filter picks QQ and NapCat processes only", () => {
  const found = filterLinuxNapcatProcesses([
    { pid: 1, cmdline: "/sbin/init", exe: "/sbin/init" },
    { pid: 2, cmdline: "/opt/QQ/qq --no-sandbox -q 10000", exe: "/opt/QQ/qq" },
    { pid: 3, cmdline: "node napcat.mjs", exe: "/usr/bin/node" },
    { pid: 4, cmdline: "bash", exe: "/usr/bin/bash" }
  ]);
  assert.deepEqual(found.map(item => item.pid), ["2", "3"]);
});

test("external endpoint validation", () => {
  assert.equal(validateExternalNapcatEndpoint({ httpUrl: "http://127.0.0.1:3000" }).ok, true);
  assert.equal(validateExternalNapcatEndpoint({}).ok, false);
  assert.equal(validateExternalNapcatEndpoint({ httpUrl: "ftp://x" }).ok, false);
  assert.equal(validateExternalNapcatEndpoint({ httpUrl: "http://a", wsUrl: "http://b" }).ok, false);
  const remote = validateExternalNapcatEndpoint({ httpUrl: "http://napcat:3000" });
  assert.equal(remote.ok, true);
  assert.equal(remote.warnings.length, 1);
  assert.equal(validateExternalNapcatEndpoint({ httpUrl: "http://napcat:3000", accessToken: "x" }).warnings.length, 0);
});
