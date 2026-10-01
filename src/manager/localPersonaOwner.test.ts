import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { assertLocalPersonaOwner, localPersonaMessageDirectories, localPersonaRoleForAgentTask, localPersonaRoleForHooks, localPersonaRuntimeForDelivery } from "./localPersonaOwner.js";

const local = { id: "local-route", agentRoleId: "Shared" };
const remote = { id: "remote-route", agentRoleId: "Shared", agentRoleDeviceId: "source-pc" };
const roleId = (definition: { agentRoleId: string }) => definition.agentRoleId;

test("remote gateway diagnostics use local Route audit files without same-named persona files", () => {
  const root = path.resolve("persona-owner-fixture");
  const routeDir = path.join(root, "data", "route", remote.id);
  const profileDir = path.join(root, "data", "route", "profile");
  assert.deepEqual(localPersonaMessageDirectories(root, { ...remote, routeProfiles: [{ agentRoleId: "Shared", dataDir: profileDir }] }, routeDir), [routeDir, profileDir]);
  assert.deepEqual(localPersonaMessageDirectories(root, local, routeDir), [routeDir, path.join(root, "data", "roles", "Shared")]);
  assert.deepEqual(localPersonaMessageDirectories(root, { ...local, routeProfiles: [{ agentRoleId: "Other", agentRoleDeviceId: "source-pc" }] }, routeDir), [routeDir, path.join(root, "data", "roles", "Shared")]);
});

test("local plan deliveries select the local owner and reject explicit remote Routes with the same ID", () => {
  const localRuntime = { definition: local };
  const remoteRuntime = { definition: remote };
  assert.equal(localPersonaRuntimeForDelivery([remoteRuntime, localRuntime], "Shared", "", roleId), localRuntime);
  assert.equal(localPersonaRuntimeForDelivery([remoteRuntime, localRuntime], "Shared", local.id, roleId), localRuntime);
  assert.throws(() => localPersonaRuntimeForDelivery([remoteRuntime, localRuntime], "Shared", remote.id, roleId), /REMOTE_PERSONA_OWNER_REQUIRED/);
  assert.throws(() => localPersonaRuntimeForDelivery([remoteRuntime], "Shared", "", roleId), /No local gateway/);
  assert.throws(() => localPersonaRuntimeForDelivery([localRuntime, { definition: { ...local, id: "second-local" } }], "Shared", "", roleId), /gatewayId is required/);
});

test("remote and mixed-owner Agent Hooks cannot bind the local namesake", () => {
  assert.equal(localPersonaRoleForHooks([local], roleId), "Shared");
  assert.throws(() => localPersonaRoleForHooks([remote], roleId), /REMOTE_PERSONA_OWNER_REQUIRED/);
  assert.throws(() => localPersonaRoleForHooks([local, remote], roleId), /REMOTE_PERSONA_OWNER_REQUIRED/);
  assert.throws(() => localPersonaRoleForHooks([local, { ...local, agentRoleId: "Other" }], roleId), /one local persona/);
  assert.throws(() => assertLocalPersonaOwner(remote, "Role panel messages"), /REMOTE_PERSONA_OWNER_REQUIRED/);
});

test("Agent delivery history rejects remote and mixed owners even with a matching old local Hook binding", () => {
  assert.equal(localPersonaRoleForAgentTask([remote], roleId, "Shared"), undefined);
  assert.equal(localPersonaRoleForAgentTask([local, remote], roleId, "Shared"), undefined);
  assert.equal(localPersonaRoleForAgentTask([local], roleId, "Shared"), "Shared");
  assert.equal(localPersonaRoleForAgentTask([], roleId, "Shared"), "Shared");
  assert.equal(localPersonaRoleForAgentTask([local], roleId, "Other"), undefined);
  assert.equal(localPersonaRoleForAgentTask([], roleId), undefined);
});
