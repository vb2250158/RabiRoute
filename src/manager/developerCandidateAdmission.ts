import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pluginPackageForCandidate } from "../plugin-kernel/profile.js";
import { hashPluginPackage } from "../plugin-kernel/packageLoader.js";
import type { PluginCandidate } from "../plugin-kernel/types.js";

export type DeveloperPublicationIdentity = Readonly<{ applicationGenerationId: string; managerInstanceId: string; pluginGenerationId: string }>;
type Rule = { packageId: string; candidateRoot: string; verificationConfig: string };
type Configuration = { schemaVersion: 1; plugins?: Rule[]; sourcePatches?: Array<{ moduleId: string; verificationConfig: string }>; web?: { verificationConfig: string } };
function parseConfiguration(text: string): Configuration {
  const value = JSON.parse(text) as Configuration;
  const named = (item: unknown): item is string => typeof item === "string" && item.trim().length > 0;
  if (value?.schemaVersion !== 1
    || value.plugins !== undefined && (!Array.isArray(value.plugins) || value.plugins.some(rule => !rule || !named(rule.packageId) || !named(rule.candidateRoot) || !named(rule.verificationConfig)))
    || value.sourcePatches !== undefined && (!Array.isArray(value.sourcePatches) || value.sourcePatches.some(rule => !rule || !named(rule.moduleId) || !named(rule.verificationConfig))
      || new Set(value.sourcePatches.map(rule => rule.moduleId)).size !== value.sourcePatches.length)
    || value.web !== undefined && (!value.web || typeof value.web !== "object" || !named(value.web.verificationConfig))) throw new Error("Invalid developer verification configuration.");
  return value;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
export type DeveloperPluginAdmission = Readonly<{ mode: "existing-contract" | "verified-development"; candidate: PluginCandidate;
  candidateSha256?: string; packageRevision?: string; diagnostic?: string; assertCurrent(): void }>;

function snapshot(root: string): string {
  const hash = createHash("sha256");
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      if ([".git", "node_modules", ".rabi-runtime"].includes(name)) continue;
      const absolute = path.join(directory, name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("Developer candidate acquired a linked input.");
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) hash.update(path.relative(root, absolute).replaceAll("\\", "/")).update("\0").update(fs.readFileSync(absolute)).update("\0");
      else throw new Error("Developer candidate acquired an unsupported input.");
    }
  }
  visit(root); return hash.digest("hex");
}

async function executeLocalVerification(sourceRoot: string, verification: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "rabi-developer-admission-"));
  try {
    const input = path.join(temp, "verification.json"); await fsp.writeFile(input, JSON.stringify(verification));
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(sourceRoot, "scripts", "verify-plugin-candidate.mjs"), "--config", input],
          { cwd: sourceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        let output = "", diagnostic = "", ready = false;
        const cancel = () => { if (ready && child.connected) child.send({ type: "cancel-verification" }); };
        child.on("message", message => {
          if ((message as { type?: string })?.type === "verification-ready") { ready = true; if (signal?.aborted) cancel(); }
        });
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        child.stdout!.on("data", data => { output += data.toString(); });
        child.stderr!.on("data", data => { diagnostic = (diagnostic + data.toString()).slice(-8192); });
        child.on("error", error => { signal?.removeEventListener("abort", cancel); reject(error); });
        child.on("close", code => { signal?.removeEventListener("abort", cancel); if (code !== 0) reject(new Error("Developer candidate matching verification failed; current version remains active.", { cause: { exitCode: code, diagnostic, receipt: output.slice(-8192) } }));
          else { try { resolve(JSON.parse(output)); } catch { reject(new Error("Developer verifier did not return an actual receipt.")); } } });
      });
    return result;
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
}

/** Config and executable paths originate solely in the Host-bound local source root.
 * No HTTP request supplies commands, tests, paths, classification or a passing result.
 * This owner stores no publication state; the existing generation/receipt owner commits.
 */
export class DeveloperCandidateAdmission {
  constructor(private readonly options: { sourceRoot?: string; identity(): DeveloperPublicationIdentity }) {}

  async prepareSelection(candidates: readonly PluginCandidate[], previous: readonly PluginCandidate[], signal?: AbortSignal) {
    const selected: PluginCandidate[] = [], admitted: DeveloperPluginAdmission[] = [];
    const diagnostics = new Set<string>();
    const failures: Array<{ instanceId: string; reason: string; retained: boolean }> = [];
    for (const candidate of candidates) {
      try {
        const proof = await this.preparePlugin(candidate, signal);
        selected.push(candidate); admitted.push(proof);
        if (proof.diagnostic) diagnostics.add(proof.diagnostic);
      } catch (error) {
        signal?.throwIfAborted();
        const old = previous.find(item => item.instanceId === candidate.instanceId);
        if (old) selected.push(old);
        failures.push({ instanceId: candidate.instanceId, reason: error instanceof Error ? error.message : String(error), retained: Boolean(old) });
      }
    }
    return { candidates: selected, failures, diagnostics: [...diagnostics], assertCurrent: () => { for (const proof of admitted) proof.assertCurrent(); } };
  }

  async prepareManagedCandidate(input: { kind: "source-patch" | "web-patch"; moduleId?: string; sha256: string; candidateRoot: string; originSourceRoot?: string }, signal?: AbortSignal): Promise<Readonly<{ mode: "existing-contract" | "verified-development"; diagnostic?: string; assertCurrent(): void }>> {
    const ordinary = (diagnostic?: string) => ({ mode: "existing-contract" as const, ...(diagnostic ? { diagnostic } : {}), assertCurrent() {} });
    if (!input.originSourceRoot || !this.options.sourceRoot) return ordinary();
    let sourceRoot: string, configurationText: string, configuration: Configuration;
    const configurationPath = path.join(this.options.sourceRoot, "developer-verification.json");
    try {
      sourceRoot = await fsp.realpath(this.options.sourceRoot);
      if (!samePath(sourceRoot, input.originSourceRoot)) return ordinary("Candidate belongs to a different bound development source; existing installation validation remains in force.");
      configurationText = await fsp.readFile(configurationPath, "utf8");
      configuration = parseConfiguration(configurationText);
    } catch { return ordinary("Developer verification configuration is unavailable; existing installation validation remains in force."); }
    const rule = input.kind === "source-patch" ? configuration.sourcePatches?.find(rule => rule.moduleId === input.moduleId) : configuration.web;
    if (!rule) return ordinary();
    const configPath = path.resolve(sourceRoot, rule.verificationConfig);
    const verificationText = await fsp.readFile(configPath, "utf8");
    const verification = JSON.parse(verificationText) as Record<string, unknown>;
    for (const key of ["sourceRoot", "cacheRoot"]) if (typeof verification[key] === "string") verification[key] = path.resolve(path.dirname(configPath), verification[key] as string);
    Object.assign(verification, { artifactKind: input.kind, artifactSha256: input.sha256, candidateRoot: input.candidateRoot });
    const identity = JSON.stringify(this.options.identity());
    const before = input.kind === "source-patch" ? createHash("sha256").update(await fsp.readFile(path.join(input.candidateRoot, `${input.sha256}.json`))).digest("hex") : snapshot(input.candidateRoot);
    if (input.kind === "source-patch" && before !== input.sha256) throw new Error("Managed source candidate hash changed.");
    const result = await executeLocalVerification(sourceRoot, verification, signal);
    if (result.kind !== "publication-verification" || result.status !== "passed" || result.artifactKind !== input.kind || result.candidateSha256 !== input.sha256) throw new Error("Matching verification does not cover the managed candidate.");
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (JSON.stringify(this.options.identity()) !== identity) throw new Error("Developer publication identity changed.");
      if (fs.readFileSync(configurationPath, "utf8") !== configurationText || fs.readFileSync(configPath, "utf8") !== verificationText) throw new Error("Local verification configuration changed.");
      const after = input.kind === "source-patch" ? createHash("sha256").update(fs.readFileSync(path.join(input.candidateRoot, `${input.sha256}.json`))).digest("hex") : snapshot(input.candidateRoot);
      if (before !== after) throw new Error("Verified managed candidate changed before publication.");
    };
    assertCurrent(); return { mode: "verified-development", assertCurrent };
  }

  async preparePlugin(candidate: PluginCandidate, signal?: AbortSignal): Promise<DeveloperPluginAdmission> {
    const ordinary = (diagnostic?: string): DeveloperPluginAdmission => ({ mode: "existing-contract", candidate, ...(diagnostic ? { diagnostic } : {}), assertCurrent() {} });
    if (!this.options.sourceRoot) return ordinary();
    let sourceRoot: string;
    try { sourceRoot = await fsp.realpath(this.options.sourceRoot); }
    catch { return ordinary("Bound developer source root is unavailable; development fast path is unavailable. Existing installation validation remains in force."); }
    const configurationPath = path.join(sourceRoot, "developer-verification.json");
    let configurationText: string;
    try { configurationText = await fsp.readFile(configurationPath, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ordinary();
      return ordinary("Cannot read developer-verification.json; development fast path is unavailable. Existing installation validation remains in force; repair the bound source configuration.");
    }
    let configuration: Configuration;
    try {
      configuration = parseConfiguration(configurationText);
    } catch {
      return ordinary("Invalid developer-verification.json; development fast path is unavailable. Existing installation validation remains in force; fix the bound source configuration.");
    }
    const plugin = pluginPackageForCandidate(candidate);
    if (!plugin) throw new Error("Plugin admission requires the original PackageCatalog candidate.");
    const matching = (configuration.plugins ?? []).filter(rule => rule?.packageId === plugin.manifest.id);
    if (!matching.length) return ordinary();
    const rules: Array<{ rule: Rule; root: string }> = [];
    for (const rule of matching) {
      let root: string;
      try { root = await fsp.realpath(path.resolve(sourceRoot, rule.candidateRoot)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const expected = path.join(root, "packages", plugin.manifest.id, plugin.manifest.version);
      const sourceKey = path.resolve(plugin.sourceRoot), expectedKey = path.resolve(expected);
      if (samePath(sourceKey, expectedKey)) rules.push({ rule, root });
    }
    if (!rules.length) return ordinary(); // A release or tree-external package is not this development source.
    if (rules.length !== 1) throw new Error("Ambiguous developer verification rules for this package source.");
    const { rule, root } = rules[0];
    const identity = JSON.stringify(this.options.identity());
    const configPath = path.resolve(sourceRoot, rule.verificationConfig);
    const verificationText = await fsp.readFile(configPath, "utf8");
    const verification = JSON.parse(verificationText) as Record<string, unknown>;
    const configDirectory = path.dirname(configPath);
    for (const key of ["sourceRoot", "cacheRoot"]) if (typeof verification[key] === "string") verification[key] = path.resolve(configDirectory, verification[key] as string);
    verification.candidateRoot = root;
    const evidence = JSON.parse(await fsp.readFile(path.join(root, "build-evidence.json"), "utf8"));
    const packagePrefix = `packages/${plugin.manifest.id}/${plugin.manifest.version}/`;
    if (!Array.isArray(evidence.artifacts?.files) || !evidence.artifacts.files.some((file: { path?: string }) => file.path === packagePrefix + "rabi.plugin.json")) {
      throw new Error("Build evidence does not cover this developer package; build the matching target first.");
    }
    const expectedArtifact = evidence.artifacts?.sha256;
    if (typeof expectedArtifact !== "string" || !/^[a-f0-9]{64}$/.test(expectedArtifact)) throw new Error("Developer candidate is missing its build evidence.");
    if (await hashPluginPackage(plugin.sourceRoot) !== plugin.revision || await hashPluginPackage(plugin.runtimeRoot) !== plugin.revision) throw new Error("Developer package changed after Loader preparation.");
    const runtimeSnapshot = snapshot(plugin.runtimeRoot);
    const result = await executeLocalVerification(sourceRoot, verification, signal);
      if (result.status !== "passed" || result.kind !== "plugin-verification" || result.candidateSha256 !== expectedArtifact) throw new Error("Developer verification does not cover this candidate.");
      const assertCurrent = () => {
        signal?.throwIfAborted();
        if (JSON.stringify(this.options.identity()) !== identity) throw new Error("Developer publication identity changed; prepare against the current baseline.");
        if (fs.readFileSync(configurationPath, "utf8") !== configurationText || fs.readFileSync(configPath, "utf8") !== verificationText) throw new Error("Local verification configuration changed.");
        if (pluginPackageForCandidate(candidate) !== plugin || snapshot(plugin.runtimeRoot) !== runtimeSnapshot) throw new Error("Verified candidate changed before publication.");
      };
      assertCurrent();
      return Object.freeze({ mode: "verified-development", candidate, candidateSha256: expectedArtifact, packageRevision: plugin.revision, assertCurrent });

  }
}
