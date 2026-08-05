import fs from "node:fs";
import path from "node:path";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import { personaAvatarPresentation } from "./personaAvatarRoutes.js";
import { PersonaCatalog, readPersonaMarkdownTitle } from "./personaCatalog.js";

export type RoleInfoGatewayDefinition = {
  rolesDir?: string;
  agentRoleFile?: string;
  agentRoleId?: string;
};

export type RoleInfoPayloadOptions = {
  includeContents?: boolean;
  catalogCache?: Map<string, Array<Record<string, unknown>>>;
  personaCatalog?: PersonaCatalog;
};

export function roleInfoPayload(
  rootDir: string,
  definition: RoleInfoGatewayDefinition,
  options: RoleInfoPayloadOptions = {}
): Record<string, unknown> {
  const includeContents = options.includeContents !== false;
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleFileName = definition.agentRoleFile ?? "persona.md";
  const selectedRoleId = sanitizeRoleId(definition.agentRoleId);
  const catalogKey = `${rolesDir}\u0000${roleFileName}\u0000${includeContents ? "detail" : "summary"}`;
  const cachedRoleOptions = options.catalogCache?.get(catalogKey);
  const roleOptions: Array<Record<string, unknown>> = cachedRoleOptions ?? [];

  if (!cachedRoleOptions) {
    const personaCatalog = options.personaCatalog ?? new PersonaCatalog();
    for (const entry of personaCatalog.list(rolesDir, { preferredFileName: roleFileName, includeContents })) {
      const roleOption: Record<string, unknown> = {
        label: entry.personaId,
        value: entry.personaId,
        rolePath: entry.rolePath,
        dataDir: entry.roleDir,
        ...personaAvatarPresentation(entry.personaId, entry.roleDir)
      };
      if (includeContents) {
        roleOption.roleTitle = entry.title;
        roleOption.roleContent = entry.content ?? "";
        roleOption.roleError = entry.error ?? "";
      } else {
        roleOption.roleTitle = entry.title;
      }
      roleOptions.push(roleOption);
    }
  }
  if (!cachedRoleOptions) options.catalogCache?.set(catalogKey, roleOptions);

  const selectedDir = selectedRoleId ? roleFolderPath(rolesDir, selectedRoleId) : "";
  const selectedRolePath = selectedRoleId ? roleFilePath(rolesDir, selectedRoleId, roleFileName) : "";
  const payload: Record<string, unknown> = {
    rolesDir,
    selectedRoleId,
    selectedRolePath,
    selectedRoleDataDir: selectedDir,
    options: roleOptions
  };

  if (includeContents) {
    const selectedOption = roleOptions.find((item) => item.value === selectedRoleId && item.rolePath === selectedRolePath);
    if (selectedOption) {
      payload.selectedRoleContent = selectedOption.roleContent ?? "";
      payload.selectedRoleError = selectedOption.roleError ?? "";
    } else if (selectedRolePath) {
      try {
        payload.selectedRoleContent = fs.readFileSync(selectedRolePath, "utf8");
        payload.selectedRoleError = "";
      } catch (error) {
        payload.selectedRoleContent = "";
        payload.selectedRoleError = error instanceof Error ? error.message : String(error);
      }
    } else {
      payload.selectedRoleContent = "";
      payload.selectedRoleError = "";
    }
    payload.selectedRoleTitle = selectedOption?.roleTitle
      ?? (selectedRolePath ? readPersonaMarkdownTitle(selectedRolePath) : "");
  } else {
    const selectedOption = roleOptions.find((item) => item.value === selectedRoleId && item.rolePath === selectedRolePath);
    payload.selectedRoleTitle = selectedOption?.roleTitle
      ?? (selectedRolePath ? readPersonaMarkdownTitle(selectedRolePath) : "");
  }

  return payload;
}
