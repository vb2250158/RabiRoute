import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { automaticCodeRuntime, type AutomaticCodeDefinition } from "../plugin-kernel/automaticCodeRuntime.js";
import { AutomaticUpdateQueue } from "./automaticUpdateQueue.js";
import { writeWebPatchJson, WEB_PATCH_HASH } from "./webPatchCatalog.js";
import type { WebPatchService } from "./webPatchService.js";

type WebCandidate = { workspace: string; directory: string; revision: string };
type Prepared = { state: string; definitions?: AutomaticCodeDefinition[]; digest?: string; webInputDigest?: string; web?: WebCandidate; changedFiles?: string[]; reasons?: unknown[] };
type Candidate = { schemaVersion: 1; baseline: string; digest: string; webInputDigest: string; definitions: AutomaticCodeDefinition[] };

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export class AutomaticCodeService {
  private watcher?: fs.FSWatcher;
  private worker?: Worker;
  private readonly queue: AutomaticUpdateQueue;
  private readonly baselineReady: Promise<void>;
  private baseline = "";
  private digest = "";
  private webInputDigest = "";
  private definitions: AutomaticCodeDefinition[] = [];
  private stopped = false;
  private state: Prepared = { state: "starting" };

  constructor(private readonly options: Readonly<{
    packageRoot: string; sourceRoot?: string; stateRoot: string; watch: boolean;
    publication: WebPatchService; onError: (error: unknown) => void;
  }>) {
    this.baselineReady = this.loadBaseline();
    void this.baselineReady.catch(() => {});
    options.publication.registerCodePublication(revision => this.prepareSaved(revision));
    this.queue = new AutomaticUpdateQueue((_sequence, isCurrent) => this.update(isCurrent), error => {
      this.state = { state: options.publication.status().state === "blocked" ? "requires_recovery" : "failed", reasons: [String(error)] };
      options.onError(error);
    });
  }

  private async loadBaseline(): Promise<void> {
    const bytes = await fsp.readFile(path.join(this.options.packageRoot, "dist/automatic-code/catalog.json"));
    this.baseline = hash(bytes);
    const catalog = JSON.parse(bytes.toString()) as { modules: Array<{ definition?: AutomaticCodeDefinition }>; webInputDigest: string };
    this.definitions = catalog.modules.flatMap(entry => entry.definition ? [entry.definition] : []);
    this.digest = hash(JSON.stringify(this.definitions));
    if (!WEB_PATCH_HASH.test(catalog.webInputDigest)) throw new Error("The installed automatic update baseline has no Web input inventory.");
    this.webInputDigest = catalog.webInputDigest;
    const legacy = await fsp.readFile(path.join(this.options.stateRoot, "active.json"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (legacy !== undefined) throw new Error("A development-era automatic-code pointer exists. Its unpublished or active effects require explicit migration before automatic updates can start.");
  }

  async start(): Promise<void> {
    try {
      await this.baselineReady;
      await this.options.publication.ready;
      if (this.options.publication.status().state !== "ready") throw new Error("The unified publication owner requires recovery.");
      if (!this.options.watch) { this.state = { state: "disabled" }; return; }
      if (!this.options.sourceRoot) {
        this.state = { state: "disabled", reasons: ["No source root is configured for this automatic code and Web watcher. Source-patch module status is reported separately by /api/source-patches."] };
        return;
      }
      this.watcher = fs.watch(this.options.sourceRoot, { recursive: true }, (_event, name) => {
        const relative = name?.toString().replaceAll("\\", "/");
        if (relative?.split("/").some(part => ["dist", "node_modules", ".git", ".web-patch-build.lock"].includes(part))) return;
        if (!relative || ["src/", "ribiwebgui/", "docs/", "assets/", "scripts/", "source-patches/"].some(prefix => relative.startsWith(prefix))
          || ["src", "ribiwebgui", "docs", "assets", "package.json", "package-lock.json", "tsconfig.json"].includes(relative)) this.queue.schedule();
      });
      this.watcher.on("error", error => { this.state = { state: "failed", reasons: [String(error)] }; this.options.onError(error); });
      this.state = { state: "ready" };
      this.queue.schedule();
    } catch (error) { this.state = { state: "requires_recovery", reasons: [String(error)] }; throw error; }
  }

  snapshot() {
    return { ...this.state, digest: this.digest, webInputDigest: this.webInputDigest,
      publication: this.options.publication.status(), runtime: automaticCodeRuntime.snapshot() };
  }

  private validate(candidate: Candidate): void {
    if (candidate.schemaVersion !== 1 || candidate.baseline !== this.baseline || !WEB_PATCH_HASH.test(candidate.webInputDigest)
      || hash(JSON.stringify(candidate.definitions)) !== candidate.digest || candidate.definitions.length !== this.definitions.length) {
      throw new Error("Automatic candidate differs from its installed baseline or content hash.");
    }
    const baseline = new Map(this.definitions.map(definition => [definition.moduleId, definition]));
    for (const definition of candidate.definitions) {
      const original = baseline.get(definition.moduleId);
      if (!original || original.shapeHash !== definition.shapeHash
        || Object.keys(original.implementations).sort().join("\0") !== Object.keys(definition.implementations).sort().join("\0")) {
        throw new Error(`Automatic candidate is incompatible with its installed module: ${definition.moduleId}`);
      }
      baseline.delete(definition.moduleId);
    }
  }

  private async prepareSaved(revision: string): Promise<() => void> {
    await this.baselineReady;
    if (!WEB_PATCH_HASH.test(revision)) throw new Error("Invalid automatic code revision.");
    const filename = path.join(this.options.stateRoot, "candidates", `${revision}.json`);
    if ((await fsp.stat(filename)).size > 16 * 1024 * 1024) throw new Error("Automatic candidate exceeds its byte budget.");
    const bytes = await fsp.readFile(filename);
    if (hash(bytes) !== revision) throw new Error("Automatic candidate content hash mismatch.");
    const candidate = JSON.parse(bytes.toString()) as Candidate;
    this.validate(candidate);
    const commit = this.digest === candidate.digest ? undefined : automaticCodeRuntime.prepareBatch(candidate.definitions, automaticCodeRuntime.snapshot().revision);
    return () => {
      commit?.();
      this.digest = candidate.digest;
      this.webInputDigest = candidate.webInputDigest;
    };
  }

  private compile(): Promise<Prepared> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(this.options.packageRoot, "scripts/automatic-update-worker.mjs"), {
        workerData: { sourceRoot: this.options.sourceRoot, packageRoot: this.options.packageRoot, webInputDigest: this.webInputDigest,
          workRoot: path.join(this.options.stateRoot, "builds") }, execArgv: []
      });
      this.worker = worker;
      let settled = false;
      let cancellation: NodeJS.Timeout | undefined;
      const finish = (error?: unknown, result?: Prepared) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (cancellation) clearTimeout(cancellation);
        void worker.terminate().then(() => {
          if (this.worker === worker) this.worker = undefined;
          if (error) reject(error); else resolve(result!);
        }, reject);
      };
      const timeout = setTimeout(() => {
        void worker.terminate().finally(() => finish(new Error("Automatic compilation exceeded its deadline; the old version remains active.")));
      }, 120000);
      worker.once("error", error => finish(error));
      worker.once("exit", code => finish(new Error(`Automatic compiler exited without a result (${code}).`)));
    });
  }

  private async discard(web?: WebCandidate): Promise<void> {
    if (!web) return;
    const root = await fsp.realpath(path.join(this.options.stateRoot, "builds"));
    const workspace = await fsp.realpath(web.workspace);
    if (path.dirname(workspace) !== root || !path.basename(workspace).startsWith("web-build-")) throw new Error("Isolated Web workspace is outside its owner.");
    const link = path.join(workspace, "package/node_modules");
    if ((await fsp.lstat(link).catch(() => undefined))?.isSymbolicLink()) await fsp.unlink(link);
    await fsp.rm(workspace, { recursive: true, force: true });
  }

  private async update(isCurrent: () => boolean): Promise<void> {
    if (this.stopped || this.options.publication.status().state !== "ready") return;
    this.state = { state: "building" };
    const result = await this.compile();
    try {
      if (!isCurrent()) return;
      if (result.state !== "prepared") { this.state = result; return; }
      if (result.digest === this.digest && result.webInputDigest === this.webInputDigest) { this.state = { state: "ready" }; return; }
      const candidate: Candidate = { schemaVersion: 1, baseline: this.baseline, digest: result.digest!, webInputDigest: result.webInputDigest!, definitions: result.definitions! };
      this.validate(candidate);
      const revision = hash(JSON.stringify(candidate));
      const directory = path.join(this.options.stateRoot, "candidates");
      const retained = await fsp.readdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
        throw error;
      });
      if (!retained.includes(`${revision}.json`) && retained.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length >= 64) throw new Error("Automatic candidate retention limit reached.");
      await writeWebPatchJson(path.join(directory, `${revision}.json`), candidate);
      if (result.web) await this.options.publication.importCandidate(result.web.directory, result.web.revision);
      if (!isCurrent() || this.stopped) return;
      const current = this.options.publication.status();
      await this.options.publication.publish({ ...current.identity, operationId: randomUUID(),
        candidate: result.web?.revision ?? current.active!, expectedRevision: current.revision! }, revision);
      this.state = { state: "ready", changedFiles: result.changedFiles };
    } finally { await this.discard(result.web); }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.worker?.postMessage("cancel");
    await this.queue.stop();
  }
}


