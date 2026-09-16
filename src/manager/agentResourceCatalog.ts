import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type AgentResourceCatalogOptions = {
  rootDir: string;
  /** Explicit paths relative to docs/, not request-controlled paths. */
  publicDocs?: readonly string[];
  maxResourceBytes?: number;
  maxEntries?: number;
};
export type AgentResourceContent = { id: string; content: string; sha256: string; sizeBytes: number };
export type AgentResourceMetadata = {
  id: string;
  kind: "skill" | "document";
  name: string;
  description: string;
  sha256: string;
  sizeBytes: number;
  references: string[];
};
export type AgentResourceErrorCode = "invalid_id" | "not_found" | "unsafe_resource" | "too_large" | "catalog_limit";
export class AgentResourceCatalogError extends Error {
  constructor(readonly code: AgentResourceErrorCode) {
    super(`Agent resource catalog: ${code}.`);
    this.name = "AgentResourceCatalogError";
  }
}

const defaultPublicDocs = [
  "rabi-agent-interfaces.md", "plan-and-memory-model.md", "agent-context-injection.md", "lan-rabi-agent-bootstrap.md",
  "rabi-agent-interfaces_en.md", "plan-and-memory-model_en.md", "agent-context-injection_en.md", "lan-rabi-agent-bootstrap_en.md",
];
const textExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv", ".ts", ".js", ".mjs", ".cjs", ".py", ".ps1", ".sh", ".bat", ".cmd", ".sql", ".xml"]);
const reservedSegment = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function resourceId(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\\%:#?\x00-\x20\x7f<>"|*]/.test(value)
    || value.split("/").some(segment => !segment || segment.startsWith(".") || segment.endsWith(".")
      || reservedSegment.test(segment) || /^(?:data|home|node_modules)$/i.test(segment))) {
    throw new AgentResourceCatalogError("invalid_id");
  }
  return value;
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new AgentResourceCatalogError("catalog_limit");
  return result;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** A deliberately non-executable subset of Skill frontmatter: scalar and folded name/description. */
function skillMetadata(content: string, fallback: string): { name: string; description: string } {
  const result = { name: fallback, description: "" };
  const frontmatter = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return result;
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^(name|description):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as "name" | "description";
    let value = match[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) block.push(lines[++index].trim());
      value = block.join(value.startsWith("|") ? "\n" : " ");
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function skillReferences(content: string, skillDirectory: string, maximum: number): string[] {
  const references = new Set<string>();
  // Markdown destinations, inline code and bare support-directory paths. No URL decoding or external fetches.
  const candidates = [
    ...content.matchAll(/\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g),
    ...content.matchAll(/`([^`\r\n]+)`/g),
    ...content.matchAll(/(?:^|\s)((?:references|scripts|assets)\/[^\s`<>"')]+)/gm),
  ];
  for (const match of candidates) {
    let relative = match[1];
    if (relative.startsWith("./")) relative = relative.slice(2);
    // Anchors identify sections, never alternate filenames.
    relative = relative.split("#")[0];
    try { resourceId(relative); } catch { continue; }
    if (!textExtensions.has(path.posix.extname(relative).toLowerCase()) || relative === "SKILL.md") continue;
    references.add(`${skillDirectory}/${relative}`);
    if (references.size > maximum) throw new AgentResourceCatalogError("catalog_limit");
  }
  return [...references].sort();
}

/**
 * Read-only projection of shipped public resources. No business storage, script execution, HTTP or cache.
 * rootDir and publication options belong to trusted startup configuration; callers only supply relative IDs.
 * Package files must not be concurrently writable by an untrusted local principal (Node has no portable openat).
 */
export class AgentResourceCatalog {
  private readonly rootDir: string;
  private readonly publicDocs: ReadonlySet<string>;
  private readonly maxResourceBytes: number;
  private readonly maxEntries: number;

  constructor(options: AgentResourceCatalogOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.maxResourceBytes = positiveLimit(options.maxResourceBytes, 512 * 1024, 8 * 1024 * 1024);
    this.maxEntries = positiveLimit(options.maxEntries, 1024, 8192);
    const documents = options.publicDocs ?? defaultPublicDocs;
    if (documents.length > this.maxEntries) throw new AgentResourceCatalogError("catalog_limit");
    this.publicDocs = new Set(documents.map(document => `docs/${resourceId(document)}`));
  }

  private async checkedPath(id: string, directory = false) {
    resourceId(id);
    const root = await fs.realpath(this.rootDir);
    let filename = root;
    const segments = id.split("/");
    for (let index = 0; index < segments.length; index++) {
      filename = path.join(filename, segments[index]);
      const stat = await fs.lstat(filename);
      if (stat.isSymbolicLink() || (index < segments.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) {
        throw new AgentResourceCatalogError("unsafe_resource");
      }
      const real = await fs.realpath(filename);
      const relative = path.relative(root, real);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        throw new AgentResourceCatalogError("unsafe_resource");
      }
    }
    return { filename, stat: await fs.lstat(filename) };
  }

  private async readText(id: string): Promise<AgentResourceContent> {
    if (!textExtensions.has(path.posix.extname(id).toLowerCase())) throw new AgentResourceCatalogError("unsafe_resource");
    try {
      const checked = await this.checkedPath(id);
      if (checked.stat.size > this.maxResourceBytes) throw new AgentResourceCatalogError("too_large");
      const handle = await fs.open(checked.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.ino !== checked.stat.ino || before.dev !== checked.stat.dev) {
          throw new AgentResourceCatalogError("unsafe_resource");
        }
        if (before.size > this.maxResourceBytes) throw new AgentResourceCatalogError("too_large");
        const bytes = Buffer.alloc(this.maxResourceBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > this.maxResourceBytes) throw new AgentResourceCatalogError("too_large");
        const after = await handle.stat();
        const current = await this.checkedPath(id);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || current.stat.ino !== before.ino || current.stat.dev !== before.dev) throw new AgentResourceCatalogError("unsafe_resource");
        const body = bytes.subarray(0, length);
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); }
        catch { throw new AgentResourceCatalogError("unsafe_resource"); }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new AgentResourceCatalogError("unsafe_resource");
        return { id, content, sha256: createHash("sha256").update(body).digest("hex"), sizeBytes: length };
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof AgentResourceCatalogError) throw error;
      throw new AgentResourceCatalogError(isMissing(error) ? "not_found" : "unsafe_resource");
    }
  }

  private async skill(directory: string, verifyReferences = true): Promise<AgentResourceMetadata> {
    // Manifest failures are authoritative; only optional support references may be omitted.
    const resource = await this.readText(`${directory}/SKILL.md`);
    const candidates = skillReferences(resource.content, directory, this.maxEntries);
    const references: string[] = [];
    for (const id of candidates) {
      if (verifyReferences) {
        try { await this.readText(id); }
        catch (error) {
          if (error instanceof AgentResourceCatalogError
            && ["not_found", "unsafe_resource", "too_large"].includes(error.code)) continue;
          throw error;
        }
      }
      references.push(id);
    }
    return { id: resource.id, kind: "skill", ...skillMetadata(resource.content, directory.slice("skills/".length)),
      sha256: resource.sha256, sizeBytes: resource.sizeBytes, references };
  }

  /** Lists immediate skills/<package>/SKILL.md manifests and explicitly published documents; missing files are omitted. */
  async list(): Promise<AgentResourceMetadata[]> {
    const result: AgentResourceMetadata[] = [];
    try {
      const { filename } = await this.checkedPath("skills", true);
      const directory = await fs.opendir(filename);
      let visited = 0;
      for await (const entry of directory) {
        if (++visited > this.maxEntries) throw new AgentResourceCatalogError("catalog_limit");
        if (entry.isSymbolicLink()) throw new AgentResourceCatalogError("unsafe_resource");
        if (!entry.isDirectory()) continue;
        try { result.push(await this.skill(`skills/${resourceId(entry.name)}`)); }
        catch (error) { if (!(error instanceof AgentResourceCatalogError && error.code === "not_found")) throw error; }
      }
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof AgentResourceCatalogError) throw error;
        throw new AgentResourceCatalogError("unsafe_resource");
      }
    }
    for (const id of this.publicDocs) {
      try {
        const resource = await this.readText(id);
        result.push({ id, kind: "document", name: id.slice("docs/".length), description: "",
          sha256: resource.sha256, sizeBytes: resource.sizeBytes, references: [] });
      } catch (error) { if (!(error instanceof AgentResourceCatalogError && error.code === "not_found")) throw error; }
    }
    if (result.length > this.maxEntries) throw new AgentResourceCatalogError("catalog_limit");
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Reads only a listed manifest/document or a direct manifest reference within the same skill package. */
  async read(id: string): Promise<AgentResourceContent> {
    resourceId(id);
    if (this.publicDocs.has(id)) return this.readText(id);
    const segments = id.split("/");
    if (segments[0] !== "skills" || segments.length < 3) throw new AgentResourceCatalogError("not_found");
    const directory = segments.slice(0, 2).join("/");
    if (id !== `${directory}/SKILL.md` && !(await this.skill(directory, false)).references.includes(id)) {
      throw new AgentResourceCatalogError("not_found");
    }
    return this.readText(id);
  }
}
