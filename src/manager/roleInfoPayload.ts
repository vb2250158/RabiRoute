import fs from "node:fs";
import path from "node:path";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFilePath, roleFolderPath } from "../shared/routePaths.js";
import { personaAvatarPresentation } from "./personaAvatarRoutes.js";

export type RoleInfoGatewayDefinition = {
  rolesDir?: string;
  agentRoleFile?: string;
  agentRoleId?: string;
};

export type RoleInfoPayloadOptions = {
  includeContents?: boolean;
  catalogCache?: Map<string, Array<Record<string, unknown>>>;
};

function markdownTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim().replace(/^\uFEFF/, "");
    if (text.startsWith("# ")) return text.slice(2).trim();
    if (text) return "";
  }
  return "";
}

function readMarkdownTitle(filePath: string): string {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(8192);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return markdownTitle(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return "";
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

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

  if (!cachedRoleOptions && fs.existsSync(rolesDir)) {
    for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !sanitizeRoleId(entry.name)) continue;

      const roleDir = roleFolderPath(rolesDir, entry.name);
      const markdownFiles = fs.readdirSync(roleDir)
        .filter((file) => file.toLowerCase().endsWith(".md"))
        .sort((left, right) => left.localeCompare(right));
      const preferredFile = markdownFiles.includes(roleFileName) ? roleFileName : markdownFiles[0] ?? roleFileName;
      const rolePath = roleFilePath(rolesDir, entry.name, preferredFile);
      const roleOption: Record<string, unknown> = {
        label: entry.name,
        value: entry.name,
        rolePath,
        dataDir: roleDir,
        ...personaAvatarPresentation(entry.name, roleDir)
      };
      if (includeContents) {
        try {
          const roleContent = fs.readFileSync(rolePath, "utf8");
          roleOption.roleTitle = markdownTitle(roleContent);
          roleOption.roleContent = roleContent;
          roleOption.roleError = "";
        } catch (error) {
          roleOption.roleTitle = "";
          roleOption.roleContent = "";
          roleOption.roleError = error instanceof Error ? error.message : String(error);
        }
      } else {
        roleOption.roleTitle = readMarkdownTitle(rolePath);
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
      ?? (selectedRolePath ? readMarkdownTitle(selectedRolePath) : "");
  } else {
    const selectedOption = roleOptions.find((item) => item.value === selectedRoleId && item.rolePath === selectedRolePath);
    payload.selectedRoleTitle = selectedOption?.roleTitle
      ?? (selectedRolePath ? readMarkdownTitle(selectedRolePath) : "");
  }

  return payload;
}
