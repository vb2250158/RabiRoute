import assert from "node:assert/strict";
import test from "node:test";
import { localKnowledgeRoleIds } from "./rabiLinkKnowledgeCatalog.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

const persona = (rolesRoot: string, roleId: string, isPersona = true): RouteCatalogPersonaPresentation => ({
  rolesRoot, roleId, isPersona, displayName: roleId, avatarConfigured: false, files: [], speech: { voiceReady: false }
});

test("knowledge catalogs exclude custom Route storage instead of addressing a same-name global role", () => {
  const catalog = [persona("C:/fixture/custom-roles", "Shared"), persona("C:/fixture/roles", "Local"), persona("C:/fixture/roles", "Incomplete", false)];
  assert.deepEqual(localKnowledgeRoleIds(catalog, "C:/fixture/roles"), ["Local"]);
  assert.deepEqual(localKnowledgeRoleIds(catalog.filter(item => item.roleId === "Shared"), "C:/fixture/roles"), []);
});

test("knowledge catalogs resolve the exact storage owner and deduplicate its actual personas", () => {
  const catalog = [persona("C:/fixture/custom-roles", "Shared"), persona("C:/FIXTURE/roles", "Shared"), persona("C:/fixture/roles", "Shared")];
  assert.deepEqual(localKnowledgeRoleIds(catalog, "C:\\fixture\\roles"), ["Shared"]);
});
