import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayDefinition } from "../src/types";
import { personaMessagesLocation, routesForPersona } from "../src/persona/personaMessageRoutes";

const route = (id: string, agentRoleId?: string, agentRoleDeviceId?: string) => ({ id, agentRoleId, agentRoleDeviceId }) as GatewayDefinition;

test("message routes belong to an exact persona and source PC, including multiple routes", () => {
  const routes = [route("first", "Example"), route("second", "Example"), route("remote", "Example", "peer"), route("other", "Other"), route("unassigned")];
  assert.deepEqual(routesForPersona(routes, "Example").map(item => item.id), ["first", "second"]);
  assert.deepEqual(routesForPersona(routes, "Example", "peer").map(item => item.id), ["remote"]);
  assert.deepEqual(routesForPersona(routes, "No routes"), []);
  assert.deepEqual(routesForPersona(routes, ""), []);
});

test("old links retain the exact route and source when opening the persona message tab", () => {
  assert.deepEqual(personaMessagesLocation(route("second", "Example role")), {
    path: "/roles/Example%20role/config", query: { tab: "messages", route: "second" }
  });
  assert.deepEqual(personaMessagesLocation(route("remote", "Example", "peer")), {
    path: "/roles/Example/config", query: { tab: "messages", route: "remote", source: "peer" }
  });
});
