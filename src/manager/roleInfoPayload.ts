import path from "node:path";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { normalizePersonaFile, roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import type {
  RouteCatalogPersonaFilePresentation,
  RouteCatalogPersonaPresentation
} from "./routeCatalogTransaction.js";

export type RoleInfoGatewayDefinition = {
  rolesDir?: string;
  agentRoleFile?: string;
  agentRoleId?: string;
};

export type RoleInfoPayloadOptions = {
  includeContents?: boolean;
  personaPresentations?: readonly RouteCatalogPersonaPresentation[];
};

function rootKey(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").toLowerCase();
}

function avatarPresentation(item: RouteCatalogPersonaPresentation): Record<string, unknown> {
  const version = item.avatarVersion;
  return {
    avatarConfigured: item.avatarConfigured,
    ...(version ? {
      avatarUrl: `/api/roles/${encodeURIComponent(item.roleId)}/avatar?v=${encodeURIComponent(version)}`,
      avatarVersion: version
    } : {})
  };
}

function preferredFile(
  item: RouteCatalogPersonaPresentation,
  preferredFileName: string
): RouteCatalogPersonaFilePresentation {
  return item.files.find(file => file.fileName === preferredFileName && file.exists)
    ?? item.files.find(file => file.fileName.toLowerCase() === "persona.md" && file.exists)
    ?? item.files.find(file => file.fileName === preferredFileName)
    ?? {
      fileName: preferredFileName,
      exists: false,
      title: "",
      content: "",
      contentTruncated: false,
      errorCode: "PERSONA_FILE_UNAVAILABLE"
    };
}

function publicRoleError(file: RouteCatalogPersonaFilePresentation): string {
  return file.errorCode ? "Persona file is unavailable." : "";
}

export function roleInfoPayload(
  rootDir: string,
  definition: RoleInfoGatewayDefinition,
  options: RoleInfoPayloadOptions = {}
): Record<string, unknown> {
  const includeContents = options.includeContents !== false;
  const rolesDir = path.resolve(rootDir, definition.rolesDir ?? path.join("data", "roles"));
  const roleFileName = normalizePersonaFile(definition.agentRoleFile ?? "persona.md");
  const selectedRoleId = sanitizeRoleId(definition.agentRoleId);
  const activeRoot = rootKey(rolesDir);
  const roleOptions = (options.personaPresentations ?? [])
    .filter(item => item.isPersona && rootKey(item.rolesRoot) === activeRoot)
    .map(item => {
      const file = preferredFile(item, roleFileName);
      const rolePath = roleFilePath(rolesDir, item.roleId, file.fileName);
      const roleOption: Record<string, unknown> = {
        label: item.roleId,
        value: item.roleId,
        rolePath,
        dataDir: roleFolderPath(rolesDir, item.roleId),
        roleTitle: file.title,
        ...avatarPresentation(item)
      };
      if (includeContents) {
        roleOption.roleContent = file.content;
        roleOption.roleContentTruncated = file.contentTruncated;
        roleOption.roleError = publicRoleError(file);
      }
      return roleOption;
    })
    .sort((left, right) => String(left.roleTitle || left.value).localeCompare(
      String(right.roleTitle || right.value),
      "zh-CN"
    ));

  const selectedDir = selectedRoleId ? roleFolderPath(rolesDir, selectedRoleId) : "";
  const selectedRolePath = selectedRoleId ? roleFilePath(rolesDir, selectedRoleId, roleFileName) : "";
  const selectedOption = roleOptions.find(item => item.value === selectedRoleId);
  const payload: Record<string, unknown> = {
    rolesDir,
    selectedRoleId,
    selectedRolePath,
    selectedRoleDataDir: selectedDir,
    options: roleOptions,
    selectedRoleTitle: selectedOption?.roleTitle ?? ""
  };

  if (includeContents) {
    payload.selectedRoleContent = selectedOption?.roleContent ?? "";
    payload.selectedRoleContentTruncated = selectedOption?.roleContentTruncated ?? false;
    payload.selectedRoleError = selectedOption?.roleError
      ?? (selectedRolePath ? "Persona file is unavailable." : "");
  }
  return payload;
}
