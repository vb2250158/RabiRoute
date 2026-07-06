import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  resolveRouteIdentity,
  routeRuntimeParts,
  sanitizeConfigName,
  sanitizeRoleId
} from "./routeIdentity.js";
import {
  adapterConfigPath,
  normalizePersonaFile,
  personaConfigPath,
  resolveRolePaths
} from "./routePaths.js";

test("route identity normalizes legacy runtime ids and explicit config names", () => {
  assert.deepEqual(routeRuntimeParts("Rabi__main-route"), {
    roleId: "Rabi",
    configName: "main-route"
  });
  assert.deepEqual(routeRuntimeParts("main route!!"), {
    roleId: "",
    configName: "main-route"
  });

  assert.deepEqual(resolveRouteIdentity({
    id: "Rabi__old",
    agentRoleId: "RouteRole",
    configName: " new route!! "
  }), {
    roleId: "RouteRole",
    configName: "new-route",
    runtimeId: "new-route"
  });
});

test("explicit empty role id keeps a route persona-free", () => {
  assert.deepEqual(resolveRouteIdentity({
    id: "Rabi__old",
    agentRoleId: ""
  }), {
    roleId: "",
    configName: "old",
    runtimeId: "old"
  });
});

test("route and role path helpers keep ids under configured roots", () => {
  const root = path.join(os.tmpdir(), "rabiroute-route-identity");
  const routeRoot = path.join(root, "data", "route");
  const rolesRoot = path.join(root, "data", "roles");

  assert.equal(
    adapterConfigPath(routeRoot, "../main route!!"),
    path.join(routeRoot, "main-route", "adapterConfig.json")
  );
  assert.equal(
    personaConfigPath(rolesRoot, "Rabi"),
    path.join(rolesRoot, "Rabi", "personaConfig.json")
  );
  assert.throws(() => personaConfigPath(rolesRoot, "../Rabi"), /Missing role folder name/);
});

test("role path resolution sanitizes persona file pointers", () => {
  const rolesRoot = path.join(os.tmpdir(), "rabiroute-roles");

  assert.equal(normalizePersonaFile("prompts/guide.md"), "prompts/guide.md");
  assert.equal(normalizePersonaFile("../secret.md"), "persona.md");

  const resolved = resolveRolePaths({
    agentRoleId: "Rabi",
    agentRoleFile: "../secret.md",
    rolesDir: rolesRoot,
    fallbackDataDir: "data/route/main"
  });

  assert.equal(resolved.roleId, "Rabi");
  assert.equal(resolved.roleDir, path.join(rolesRoot, "Rabi"));
  assert.equal(resolved.rolePath, path.join(rolesRoot, "Rabi", "persona.md"));
});

test("role ids remain strict while route config names can be display-normalized", () => {
  assert.equal(sanitizeRoleId("Rabi Route"), "");
  assert.equal(sanitizeConfigName("Rabi Route"), "Rabi-Route");
});
