import type http from "node:http";
import path from "node:path";
import type test from "node:test";
import { createPersonaStorageOperationsContext } from "./controlPlaneRoutes.js";
import { createPersonaIdentityOperations } from "./personaIdentityOperations.js";
import { createPersonaHistoryOperations } from "./personaHistoryOperations.js";
import { PersonaStorageOwner, createPersonaStorageOperations } from "./personaStorageOperations.js";
import { RoleStorageApplication } from "./roleStorageApplication.js";
import { ManagerPluginRouteRegistry } from "./managerPluginRouteRegistry.js";
import { markAuthenticatedConnectionRequest } from "./connectionRequestAccess.js";
import { ManagerEventHub, createManagerEventsOperation } from "./managerEvents.js";

type Context = { rolesRoot?: string; roleDir(roleId: string): string; roleStorageApplication?: () => RoleStorageApplication };
const identity = { applicationGenerationId: "native-integration-generation", managerInstanceId: "native-integration-manager" };

/** Existing integration scenarios execute the same contracts and Manager callbacks as the plugin. */
export function createPersonaStorageTestApi(t: test.TestContext, context: Context) {
  const ownedApplication = context.roleStorageApplication ? undefined : new RoleStorageApplication({
    rolesRoot: context.rolesRoot ?? path.dirname(context.roleDir("Role")), ...identity
  });
  const owner = new PersonaStorageOwner(createPersonaStorageOperationsContext({
    roleDirectory: context.roleDir, application: context.roleStorageApplication ?? (() => ownedApplication!), identity: () => identity
  }));
  const registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("persona-native-integration", createPersonaStorageOperations(owner));
  t.after(async () => { await registration.dispose(); await owner.stop(); await ownedApplication?.stop(); });
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse) => {
    markAuthenticatedConnectionRequest(request);
    return registry.handle(request, url, response);
  };
}

export function createPersonaIdentityTestApi(t: test.TestContext, context: Pick<Context, "roleDir" | "rolesRoot">) {
  const events = new ManagerEventHub(), registry = new ManagerPluginRouteRegistry();
  const registration = registry.registerOperations("identity-native-integration", [
    ...createPersonaIdentityOperations({ roleDirectory: context.roleDir, identity: () => identity, onEvent: (name, payload) => events.publish(name, payload) }),
    ...createPersonaHistoryOperations({ roleDir: context.roleDir, identity: () => identity,
      queryHistory: async () => { throw new Error("This fixture only registers conversation-situation history, not message search."); }
    }).filter(operation => operation.contract.pathTemplate.endsWith("/conversation-situations")),
    createManagerEventsOperation(events)
  ]);
  t.after(async () => { await registration.dispose(); });
  return (request: http.IncomingMessage, url: URL, response: http.ServerResponse) => {
    markAuthenticatedConnectionRequest(request);
    return registry.handle(request, url, response);
  };
}
