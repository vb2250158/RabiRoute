import fs from "node:fs";
import path from "node:path";
import { sanitizeRoleId } from "../shared/routeIdentity.js";
import { roleFilePath, roleFolderPath } from "../shared/routePaths.js";

export type PersonaCatalogEntry = {
  personaId: string;
  roleDir: string;
  rolePath: string;
  roleFileName: string;
  title: string;
  content?: string;
  error?: string;
};

export type PersonaCatalogListOptions = {
  preferredFileName?: string;
  includeContents?: boolean;
};

export function personaMarkdownTitle(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim().replace(/^\uFEFF/, "");
    if (text.startsWith("# ")) return text.slice(2).trim();
    if (text) return "";
  }
  return "";
}

export function readPersonaMarkdownTitle(filePath: string): string {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(8192);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    return personaMarkdownTitle(buffer.toString("utf8", 0, bytesRead));
  } catch {
    return "";
  } finally {
    if (handle != null) fs.closeSync(handle);
  }
}

export class PersonaCatalog {
  private readonly cachedLists = new Map<string, PersonaCatalogEntry[]>();

  list(rolesDir: string, options: PersonaCatalogListOptions = {}): PersonaCatalogEntry[] {
    const resolvedRolesDir = path.resolve(rolesDir);
    const preferredFileName = options.preferredFileName?.trim() || "persona.md";
    const includeContents = options.includeContents === true;
    const cacheKey = `${resolvedRolesDir}\u0000${preferredFileName}\u0000${includeContents ? "detail" : "summary"}`;
    const cached = this.cachedLists.get(cacheKey);
    if (cached) return cached;

    const entries: PersonaCatalogEntry[] = [];
    if (fs.existsSync(resolvedRolesDir)) {
      for (const directoryEntry of fs.readdirSync(resolvedRolesDir, { withFileTypes: true })) {
        if (!directoryEntry.isDirectory() || !sanitizeRoleId(directoryEntry.name)) continue;
        const roleDir = roleFolderPath(resolvedRolesDir, directoryEntry.name);
        let markdownFiles: string[] = [];
        try {
          markdownFiles = fs.readdirSync(roleDir)
            .filter(file => file.toLowerCase().endsWith(".md"))
            .sort((left, right) => left.localeCompare(right));
        } catch {
          // The entry remains queryable with its canonical preferred path.
        }
        const roleFileName = markdownFiles.includes(preferredFileName)
          ? preferredFileName
          : markdownFiles[0] ?? preferredFileName;
        const rolePath = roleFilePath(resolvedRolesDir, directoryEntry.name, roleFileName);
        if (includeContents) {
          try {
            const content = fs.readFileSync(rolePath, "utf8");
            entries.push({
              personaId: directoryEntry.name,
              roleDir,
              rolePath,
              roleFileName,
              title: personaMarkdownTitle(content),
              content,
              error: ""
            });
          } catch (error) {
            entries.push({
              personaId: directoryEntry.name,
              roleDir,
              rolePath,
              roleFileName,
              title: "",
              content: "",
              error: error instanceof Error ? error.message : String(error)
            });
          }
        } else {
          entries.push({
            personaId: directoryEntry.name,
            roleDir,
            rolePath,
            roleFileName,
            title: readPersonaMarkdownTitle(rolePath)
          });
        }
      }
    }
    entries.sort((left, right) => (left.title || left.personaId).localeCompare(right.title || right.personaId, "zh-CN"));
    this.cachedLists.set(cacheKey, entries);
    return entries;
  }

  invalidate(rolesDir?: string): void {
    if (!rolesDir) {
      this.cachedLists.clear();
      return;
    }
    const prefix = `${path.resolve(rolesDir)}\u0000`;
    for (const key of this.cachedLists.keys()) {
      if (key.startsWith(prefix)) this.cachedLists.delete(key);
    }
  }
}
