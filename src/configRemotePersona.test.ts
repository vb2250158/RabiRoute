import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, rolePathsForRoute } from "./config.js";

test("remote persona paths stay in the Route data directory even with a matching local role", () => {
  const paths = rolePathsForRoute({
    agentRoleId: "Shared",
    agentRoleDeviceId: "remote-pc",
    agentRoleFile: "persona.md",
    rolesDir: "/local-personas",
    dataDir: "/route-data"
  });
  assert.deepEqual(paths, {
    roleId: "Shared", roleDir: "", rolePath: "", routeDataDir: "/route-data", personaDataDir: "/route-data"
  });
  const fallback = rolePathsForRoute({ agentRoleId: "Shared", agentRoleDeviceId: "remote-pc", agentRoleFile: "persona.md", rolesDir: "/local-personas" });
  assert.equal(fallback.personaDataDir, config.baseDataDir);
  assert.equal(fallback.rolePath, "");
});

test("invalid remote references fail without falling back to the local persona", () => {
  assert.throws(() => rolePathsForRoute({ agentRoleDeviceId: "remote-pc", agentRoleFile: "persona.md", rolesDir: "/local-personas" }), /valid role ID/);
  assert.throws(() => rolePathsForRoute({ agentRoleId: "Shared", agentRoleDeviceId: "../remote", agentRoleFile: "persona.md", rolesDir: "/local-personas" }), /device ID/);
});

function configProcess(environment: Record<string, string>): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ deviceId: config.agentRoleDeviceId, roleDir: config.agentRoleDir, rolePath: config.agentRolePath, profiles: config.routeProfiles.map(p => ({deviceId:p.agentRoleDeviceId, roleId:p.agentRoleId})) }));"
  ], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, ...environment }, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

test("Gateway process environment preserves remote references without resolving local role files", () => {
  const output = configProcess({ AGENT_ROLE_DEVICE_ID: "pc-target", AGENT_ROLE_ID: "Shared", ROUTE_PROFILES: JSON.stringify([{
    id: "remote-route", agentRoleId: "Shared", agentRoleDeviceId: "pc-target", notificationRules: [{ id: "input", routeKinds: ["private"], template: "" }]
  }]) });
  const result = JSON.parse(output.trim());
  assert.deepEqual(result, { deviceId: "pc-target", roleDir: "", rolePath: "", profiles: [{ deviceId: "pc-target", roleId: "Shared" }] });
});

test("malformed remote Route profile environment terminates instead of restoring a local fallback", () => {
  assert.throws(() => configProcess({ AGENT_ROLE_DEVICE_ID: "", AGENT_ROLE_ID: "Shared", ROUTE_PROFILES: JSON.stringify([{
    id: "remote-route", agentRoleDeviceId: "pc-target", notificationRules: [{ id: "input", routeKinds: ["private"], template: "" }]
  }]) }), /valid role ID/);
});
