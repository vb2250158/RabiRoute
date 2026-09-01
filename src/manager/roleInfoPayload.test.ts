import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { roleInfoPayload } from "./roleInfoPayload.js";
import type { RouteCatalogPersonaPresentation } from "./routeCatalogTransaction.js";

function persona(
  rolesRoot: string,
  content = "# Rabi\n\nPersona preview."
): RouteCatalogPersonaPresentation {
  return {
    rolesRoot,
    roleId: "Rabi",
    isPersona: true,
    displayName: "Rabi",
    avatarConfigured: true,
    avatarVersion: "1-2",
    files: [{
      fileName: "persona.md",
      exists: true,
      title: "Rabi",
      content,
      contentTruncated: false
    }],
    speech: { voiceReady: false }
  };
}

test("gateway summary role info is derived only from the immutable child presentation", () => {
  const rootDir = path.resolve("C:\\app");
  const rolesRoot = path.join(rootDir, "data", "roles");
  const roleDir = path.join(rolesRoot, "Rabi");
  const payload = roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, {
    includeContents: false,
    personaPresentations: [persona(rolesRoot)]
  });
  const role = (payload.options as Array<Record<string, unknown>>)[0];

  assert.equal("roleContent" in role, false);
  assert.equal("roleError" in role, false);
  assert.equal("selectedRoleContent" in payload, false);
  assert.equal(role.roleTitle, "Rabi");
  assert.equal(payload.selectedRoleTitle, "Rabi");
  assert.equal(role.value, "Rabi");
  assert.equal(payload.selectedRoleDataDir, roleDir);
  assert.equal(role.avatarUrl, "/api/roles/Rabi/avatar?v=1-2");
});

test("full gateway role info returns bounded child content and stable unavailable errors", () => {
  const rootDir = path.resolve("C:\\app");
  const rolesRoot = path.join(rootDir, "data", "roles");
  const payload = roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, {
    personaPresentations: [persona(rolesRoot)]
  });
  assert.equal(payload.selectedRoleContent, "# Rabi\n\nPersona preview.");
  assert.equal(payload.selectedRoleContentTruncated, false);
  assert.equal(payload.selectedRoleError, "");

  const missing: RouteCatalogPersonaPresentation = {
    ...persona(rolesRoot),
    files: [{
      fileName: "persona.md",
      exists: false,
      title: "",
      content: "",
      contentTruncated: false,
      errorCode: "PERSONA_FILE_UNAVAILABLE"
    }]
  };
  const unavailable = roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, {
    personaPresentations: [missing]
  });
  assert.equal(unavailable.selectedRoleError, "Persona file is unavailable.");
  assert.equal(JSON.stringify(unavailable).includes("nas"), false);
});

test("formal role info parent module contains no roles-root filesystem access", () => {
  const source = fs.readFileSync(new URL("./roleInfoPayload.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|PersonaCatalog|readFileSync|readdirSync|statSync|existsSync/);
  assert.match(source, /personaPresentations/);
});
