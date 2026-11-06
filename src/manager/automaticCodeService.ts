import { getTimeoutMs } from "../shared/timeoutSettings.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { ChildProcess } from "node:child_process";
import { launchProtectedProcess, type ProtectedProcessTree } from "../runtime/protectedProcessLauncher.mjs";
import { createHash, randomUUID } from "node:crypto";
import { automaticCodeRuntime, type AutomaticCodeDefinition } from "../plugin-kernel/automaticCodeRuntime.js";
import { AutomaticUpdateQueue } from "./automaticUpdateQueue.js";
import { writeWebPatchJson, WEB_PATCH_HASH } from "./webPatchCatalog.js";
import type { WebPatchService } from "./webPatchService.js";
import { stopChildProcessTree } from "../runtime/windowsProcessTree.js";

type WebCandidate = { workspace: string; directory: string; revision: string };
type Prepared = { state: string; definitions?: AutomaticCodeDefinition[]; digest?: string; webInputDigest?: string; web?: WebCandidate; changedFiles?: string[]; reasons?: unknown[] };
type Candidate = { schemaVersion: 1; baseline: string; digest: string; webInputDigest: string; definitions: AutomaticCodeDefinition[] };
type CompileCommand = { type: "run-node"; id: number; root: string; arguments: string[] };

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export class AutomaticCodeService {
  private watcher?: fs.FSWatcher;
  private worker?: Worker;
  private cancelCompilation?: () => Promise<void>;
  private retryCompilationRetirement?: () => Promise<void>;
  private readonly queue: AutomaticUpdateQueue;
  private readonly baselineReady: Promise<void>;
  private baseline = "";
  private digest = "";
  private webInputDigest = "";
  private definitions: AutomaticCodeDefinition[] = [];
  private stopped = false;
  private sourceRoot?: string;
  private inputHashes: Readonly<Record<string, string>> = {};
  private startupDirtyInputs: string[] = [];
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
    const catalog = JSON.parse(bytes.toString()) as { modules: Array<{ definition?: AutomaticCodeDefinition }>; webInputDigest: string; inputHashes?: Record<string, string> };
    this.inputHashes = catalog.inputHashes ?? {};
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
      if (this.stopped) return;
      await this.options.publication.ready;
      if (this.stopped) return;
      if (this.options.publication.status().state !== "ready") throw new Error("The unified publication owner requires recovery.");
      if (!this.options.watch) { this.state = { state: "disabled" }; return; }
      const candidateRoot = await fsp.realpath(this.options.sourceRoot ?? this.options.packageRoot);
      if (this.stopped) return;
      const [sourceDirectory, sourceConfig] = await Promise.all([
        fsp.stat(path.join(candidateRoot, "src")).catch(() => undefined),
        fsp.stat(path.join(candidateRoot, "tsconfig.json")).catch(() => undefined)
      ]);
      if (this.stopped) return;
      if (!sourceDirectory?.isDirectory() || !sourceConfig?.isFile()) {
        this.state = { state: "source_unavailable", reasons: ["The running package has no compiler source inventory; native hot-patching is available, but an actual source owner is required."] };
        return;
      }
      this.sourceRoot = candidateRoot;
      for (const [relative, expected] of Object.entries(this.inputHashes)) {
        const actual = await fsp.readFile(path.join(candidateRoot, relative)).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (this.stopped) return;
        if (!actual || hash(actual) !== expected) this.startupDirtyInputs.push(relative);
      }
      this.watcher = fs.watch(candidateRoot, { recursive: true }, (_event, name) => {
        const relative = name?.toString().replaceAll("\\", "/");
        if (relative?.split("/").some(part => ["dist", "node_modules", ".git", ".web-patch-build.lock"].includes(part))) return;
        if (!relative || ["src/", "ribiwebgui/", "docs/", "assets/", "scripts/", "source-patches/"].some(prefix => relative.startsWith(prefix))
          || ["src", "ribiwebgui", "docs", "assets", "package.json", "package-lock.json", "tsconfig.json"].includes(relative)) this.queue.schedule();
      });
      this.watcher.on("error", error => { this.state = { state: "failed", reasons: [String(error)] }; this.options.onError(error); });
      // Discovery is native and automatic; old shared edits are not a new
      // publication transaction. Keep their ownership boundary visible.
      this.state = this.startupDirtyInputs.length
        ? { state: "requires_review", reasons: [{ reason: "Source inputs already differ from the running baseline; do not publish unowned shared edits.", files: this.startupDirtyInputs }] }
        : { state: "ready" };
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

  private async compile(): Promise<Prepared> {
    if (this.stopped) throw new Error("The automatic source owner has stopped.");
    if (this.worker) {
      if (!this.retryCompilationRetirement) throw new Error("The previous automatic compiler still owns active work.");
      // Only a new actual compilation request retries the failed original
      // retirement. Never cancel legitimate in-flight compilation or start a
      // successor until the previous process tree is confirmed gone.
      await this.retryCompilationRetirement();
    }
    if (this.stopped) throw new Error("The automatic source owner has stopped.");
    if (this.worker) throw new Error("The previous automatic compiler still owns active work.");
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(this.options.packageRoot, "scripts/automatic-update-worker.mjs"), {
        workerData: { sourceRoot: this.sourceRoot ?? this.options.sourceRoot, packageRoot: this.options.packageRoot, webInputDigest: this.webInputDigest,
          workRoot: path.join(this.options.stateRoot, "builds") }, execArgv: []
      });
      this.worker = worker;
      let settled = false, workerExited = false, cancelled = false;
      let acknowledgeWorker!: () => void;
      const workerCompleted = new Promise<void>(resolve => { acknowledgeWorker = resolve; });
      type Owned = { child: ChildProcess; tree?: ProtectedProcessTree; closed: Promise<void>; closing?: Promise<void> };
      const children = new Set<Owned>();
      const bounded = async <T>(operation: Promise<T>, message: string): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), getTimeoutMs("worker.terminate", 5000));
        })]); } finally { if (timer) clearTimeout(timer); }
      };
      const closeChild = (owned: Owned): Promise<void> => {
        if (owned.closing) return owned.closing;
        const attempt = (async () => {
          if (owned.tree) { owned.tree.terminate(); owned.tree.refresh(); }
          else if (owned.child.exitCode === null && owned.child.signalCode === null) await stopChildProcessTree(owned.child);
          await bounded(Promise.all([owned.closed, owned.tree?.settled]), "Automatic compiler process tree retirement remains unconfirmed.");
          children.delete(owned);
        })();
        owned.closing = attempt;
        void attempt.then(() => {}, () => { if (owned.closing === attempt) owned.closing = undefined; });
        return attempt;
      };
      let closing: Promise<void> | undefined;
      const closeCompiler = (knownChildFailure?: unknown): Promise<void> => {
        if (closing) return closing;
        const attempt = (async () => {
          const errors = knownChildFailure === undefined
            ? (await Promise.allSettled([...children].map(closeChild))).flatMap(result => result.status === "rejected" ? [result.reason] : [])
            : [knownChildFailure];
          if (cancelled && !errors.length && !workerExited) {
            // Let the cancelled worker discard its workspace only after its
            // actual command trees have closed; then retain the hard-stop bound.
            await bounded(workerCompleted, "Automatic compiler cancellation acknowledgement timed out.").catch(() => {});
          }
          try { await bounded(worker.terminate(), "Automatic compiler worker exit remains unconfirmed."); }
          catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, "Automatic compiler retirement remains unconfirmed; original owners and workspace were retained.");
          if (this.worker === worker) { this.worker = undefined; this.cancelCompilation = undefined; this.retryCompilationRetirement = undefined; }
        })();
        closing = attempt;
        void attempt.then(() => {}, () => {
          if (closing === attempt) closing = undefined;
          if (this.worker === worker) this.retryCompilationRetirement = () => closeCompiler();
        });
        return attempt;
      };
      let finishCleanup: Promise<void>;
      const finish = (error?: unknown, result?: Prepared, cancel = Boolean(error), knownChildFailure?: unknown) => {
        if (settled) return;
        settled = true; cancelled = cancel;
        clearTimeout(timeout);
        if (cancel && !workerExited) { try { worker.postMessage("cancel"); } catch { /* terminate still owns this worker */ } }
        finishCleanup = closeCompiler(knownChildFailure);
        void finishCleanup.then(() => { if (error) reject(error); else resolve(result!); }, cleanupError => {
          reject(error ? new AggregateError([error, cleanupError], String(error instanceof Error ? error.message : error) + "; compiler cleanup remains unconfirmed.") : cleanupError);
        });
      };
      const post = (message: unknown) => {
        if (workerExited) return;
        try { worker.postMessage(message); } catch (error) { finish(error, undefined, true); }
      };
      this.cancelCompilation = () => {
        if (!settled) { finish(new Error("Automatic build cancelled."), undefined, true); return finishCleanup; }
        return closeCompiler();
      };
      const timeout = setTimeout(() => {
        finish(new Error("Automatic compilation exceeded its deadline; the old version remains active."), undefined, true);
      }, getTimeoutMs("deadline.manager.automaticCodeService.compile", 120000));
      worker.on("message", (result: Prepared | CompileCommand) => {
        if (result && typeof result === "object" && "type" in result && result.type === "run-node") {
          if (settled) { post({ type: "run-node-result", id: result.id, error: "Automatic build cancelled." }); return; }
          let launched: ReturnType<typeof launchProtectedProcess>;
          try { launched = launchProtectedProcess({ kind: "spawn", command: process.execPath, args: result.arguments,
            options: { cwd: result.root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] } }); }
          catch (error) { finish(error); return; }
          const { child, tree } = launched;
          let close!: () => void;
          const owned: Owned = { child, tree, closed: new Promise<void>(resolve => { close = resolve; }) };
          children.add(owned);
          let output = "", failure: Error | undefined;
          const append = (bytes: Buffer) => { output = (output + bytes.toString()).slice(-32768); };
          child.stdout?.on("data", append); child.stderr?.on("data", append);
          child.once("error", error => { failure = error; });
          child.once("close", (code, signal) => {
            close();
            // Root/stream close never retires a still-live descendant tree.
            void closeChild(owned).then(() => post({ type: "run-node-result", id: result.id,
              ...(code === 0 && !signal && !failure && !settled ? {} : { error: failure?.message ?? `Isolated Web build failed (${code ?? signal}): ${output}` }) }),
            error => finish(error, undefined, true, error));
          });
          return;
        }
        acknowledgeWorker();
        if (settled) return;
        if (!result || typeof result !== "object" || !("state" in result) || typeof result.state !== "string") finish(new Error("Automatic compiler returned an invalid receipt."));
        else finish(undefined, result);
      });
      worker.once("error", error => { acknowledgeWorker(); finish(error); });
      worker.once("exit", code => { workerExited = true; acknowledgeWorker(); finish(new Error(`Automatic compiler exited without a result (${code}).`)); });
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
    if (this.startupDirtyInputs.length) {
      this.state = { state: "requires_review", reasons: [{ reason: "Unowned changes existed when this source owner started; preserve the running service until an exact candidate is reviewed.", files: this.startupDirtyInputs }] };
      return;
    }
    this.state = { state: "building" };
    let result: Prepared;
    try {
      result = await this.compile();
    } catch (error) {
      this.state = { state: "failed", reasons: [String(error)] };
      return;
    }
    try {
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
      if (result.web) await this.options.publication.importLocalCandidate(result.web.directory, result.web.revision, this.sourceRoot!);
      if (!isCurrent() || this.stopped) return;
      const current = this.options.publication.status();
      await this.options.publication.publish({ ...current.identity, operationId: randomUUID(),
        candidate: result.web?.revision ?? current.active!, expectedRevision: current.revision! }, revision);
      this.state = { state: "ready", changedFiles: result.changedFiles };
    } catch (error) {
      this.state = { state: "failed", reasons: [String(error)] };
    } finally { await this.discard(result.web); }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    const retirement = this.cancelCompilation?.();
    const results = await Promise.allSettled([this.queue.stop(), ...(retirement ? [retirement] : [])]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Automatic compiler stop remains unconfirmed; its original owner was retained.");
  }
}


