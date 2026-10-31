import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type DeveloperArtifactKind = "source-patch" | "web-patch";
/** Candidate origin facts owned by the existing managed candidate store. No publication state. */
export class DeveloperCandidateProvenance {
  constructor(private readonly options: { stateRoot: string; sourceRoot?: string }) {}
  private filename(kind: DeveloperArtifactKind, sha256: string): string {
    if (!["source-patch", "web-patch"].includes(kind) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid managed developer candidate identity.");
    return path.join(this.options.stateRoot, "developer-provenance", `${kind}-${sha256}.json`);
  }
  /** Called only by the in-process local compiler/import owner, never an HTTP route. */
  async record(kind: DeveloperArtifactKind, sha256: string, actualSourceRoot: string): Promise<void> {
    if (!this.options.sourceRoot) return;
    const [bound, actual] = await Promise.all([fs.realpath(this.options.sourceRoot), fs.realpath(actualSourceRoot)]);
    if (process.platform === "win32" ? bound.toLowerCase() !== actual.toLowerCase() : bound !== actual) throw new Error("Local candidate was built outside the Host-bound source root.");
    const filename = this.filename(kind, sha256);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = filename + `.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, kind, sha256, sourceRoot: bound }), { flag: "wx" });
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async source(kind: DeveloperArtifactKind, sha256: string): Promise<string | undefined> {
    const filename = this.filename(kind, sha256);
    let text: string;
    try { text = await fs.readFile(filename, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const saved = JSON.parse(text);
    if (saved.schemaVersion !== 1 || saved.kind !== kind || saved.sha256 !== sha256 || typeof saved.sourceRoot !== "string") throw new Error("Managed developer candidate origin metadata is invalid.");
    return saved.sourceRoot;
  }
}
