import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginExecutor } from "../plugin-kernel/pluginExecutor.js";
import { pluginPackageForCandidate } from "../plugin-kernel/profile.js";
import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginCandidate, PluginContext, PluginIdentity, PluginModule } from "../plugin-kernel/types.js";
import { ProcessLeaseRegistry, type ProcessLease } from "../runtime/processLeaseRegistry.js";
import { BridgedIsolatedPluginExecutor, type ServiceTransport, type RuntimeObservation } from "./bridge/executor.mjs";
import { asyncPluginServiceTransport, declareAsyncPluginService, scopedAsyncPluginService } from "./asyncServiceTransport.js";
import { AsyncPluginOutcomeArchive, type AsyncMethodEffect } from "./asyncOutcomeArchive.js";

import { clone, TransportError } from "./bridge/protocol.mjs";

export const ASYNC_SERVICE_TRANSPORT_FILE = "rabi.async-services.json";
type TransportSet = Readonly<Record<string, ServiceTransport>>;
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function providedTransports(value: unknown, candidate: PluginCandidate): TransportSet {
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => !["schemaVersion", "provides"].includes(key)) || !object(value.provides)) throw new Error("Invalid immutable async service transport descriptor.");
  const contracts: Record<string, ServiceTransport> = Object.create(null);
  for (const [capability, contract] of Object.entries(value.provides)) {
    if (!candidate.manifest.provides.includes(capability) || !object(contract) || contract.kind !== "async-methods" || Object.keys(contract).some(key => !["kind", "methods", "effects"].includes(key)) || !Array.isArray(contract.methods) || !contract.methods.length || contract.methods.some(name => typeof name !== "string" || !name || ["then", "constructor", "prototype", "__proto__"].includes(name)) || new Set(contract.methods).size !== contract.methods.length) throw new Error(`Invalid provided async transport: ${capability}.`);
    const effects = contract.effects ?? {};
    const methods = contract.methods as string[];
    if (!object(effects) || Object.entries(effects).some(([name, effect]) => !methods.includes(name) || typeof effect !== "string" || !["read", "owned-resource", "mutation", "unknown"].includes(effect))) throw new Error(`Invalid provided method effect semantics: ${capability}.`);
    contracts[capability] = Object.freeze({ kind: "async-methods", methods: Object.freeze([...methods]), effects: Object.freeze({ ...effects }) as Readonly<Record<string, AsyncMethodEffect>> });
  }
  return Object.freeze(contracts);
}

/** Both protocols are real isolated entries. Selection is final before launch;
 * this never falls back to another child after a failure or replays an RPC. */
export class ProtocolSelectingIsolatedExecutor implements PluginExecutor {
  constructor(readonly leases: ProcessLeaseRegistry, private readonly cloneProtocol: PluginExecutor, readonly outcomeArchive?: AsyncPluginOutcomeArchive, readonly recordAsync?: (observation: RuntimeObservation) => void) {}

  /** Diagnostic owner evidence only; no automatic replay or guessed resolution. */
  async readUnknownOutcome(identity: PluginIdentity, requestId: string) { if (!this.outcomeArchive) throw new Error("No Manager-owned async outcome archive."); return this.outcomeArchive.read(identity, requestId); }

  async prepare(candidate: PluginCandidate, identity: PluginIdentity): Promise<PluginModule> {
    const cloneModule = await this.cloneProtocol.prepare(candidate, identity);
    const verifiedPackage = pluginPackageForCandidate(candidate);
    let declared: TransportSet | undefined;
    if (verifiedPackage) {
      if (verifiedPackage.revision !== candidate.revision || verifiedPackage.entryPath !== candidate.entry.path) throw new Error("Plugin candidate no longer matches its normal PackageCatalog proof.");
      try {
        const descriptorPath = path.join(verifiedPackage.runtimeRoot, ASYNC_SERVICE_TRANSPORT_FILE);
        const stat = await fs.lstat(descriptorPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("Async transport descriptor must be a bounded immutable regular package file.");
        declared = providedTransports(JSON.parse(await fs.readFile(descriptorPath, "utf8")) as unknown, candidate);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return Object.freeze({ activate: async context => {
      const contracts: Record<string, ServiceTransport> = Object.create(null);
      let hostAsync = false;
      const boundServices = new Map<string, unknown>();
      for (const capability of new Set([...candidate.manifest.requires, ...candidate.manifest.optional])) {
        const originalValue = candidate.manifest.requires.includes(capability) ? context.services.require(capability) : context.services.optional(capability);
        const factory = scopedAsyncPluginService(originalValue);
        const value = factory ? declareAsyncPluginService(factory.createScope(context), factory.transport.methods, factory.transport.effects) : originalValue;
        if (factory) boundServices.set(capability, value);
        if (value === undefined) continue;
        const transport = asyncPluginServiceTransport(value);
        if (transport) contracts[capability] = transport;
        else {
          try { clone(value, capability); contracts[capability] = Object.freeze({ kind: "data" }); }
          catch (error) {
            if (!(error instanceof TransportError) || error.code !== "UNSUPPORTED_SERVICE_TRANSPORT") throw error;
            contracts[capability] = Object.freeze({ kind: "unsupported" });
          }
        }
        hostAsync ||= Boolean(transport);
      }
      // Existing v1 clone-only packages retain their original restart/heartbeat
      // contract. A v2 failure never reaches this branch or opens a v1 child.
      if (!declared && !hostAsync) { await cloneModule.activate(context); return; }
      if (!verifiedPackage) throw new Error("Async isolated execution requires the original PackageCatalog-owned immutable package proof.");
      const archive = this.outcomeArchive;
      if (!archive) throw new Error("Async IPC requires the real Manager-owned uncertainty archive; ephemeral scope-only evidence is unsupported.");
      if (candidate.policy?.restart.mode === "on_failure") throw new Error("Async IPC protocol v2 cannot replay activation while native outcomes may be unknown; restart policy on_failure needs an explicit outcome-safe owner adapter.");
      for (const capability of candidate.manifest.provides) contracts[capability] = declared?.[capability] ?? Object.freeze({ kind: "data" });
      // The normal catalog may retain a lexical Windows8.3 runtime root while
      // its verified entry has already been canonicalized. Bind both to the same
      // real immutable namespace before computing the proof's relative filename.
      const packageRoot = await fs.realpath(verifiedPackage.runtimeRoot), entryPath = await fs.realpath(verifiedPackage.entryPath);
      const entryRelative = path.relative(packageRoot, entryPath).replace(/\\/g, "/");
      const entryHash = createHash("sha256").update(await fs.readFile(entryPath)).digest("hex");
      const leasesByChild = new WeakMap<ChildProcess, ProcessLease>();
      const bridge = new BridgedIsolatedPluginExecutor({
        contracts: Object.freeze(contracts),
        resolvePackage: async requested => {
          if (requested !== candidate || pluginPackageForCandidate(requested) !== verifiedPackage) throw new Error("Immutable package owner changed.");
          return { root: packageRoot, files: [{ relative: entryRelative, sha256: entryHash }] };
        },
        runWithIdentity: runPluginActivation,
        launch: (entry, originalIdentity) => {
          const lease = this.leases.launch(originalIdentity, "isolated-plugin-runtime-v2", () => fork(entry, [], {
            ...{ windowsHide: true }, serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], env: {}
          }), { maxChildProcesses: candidate.policy?.resources.maxChildProcesses ?? 2 });
          leasesByChild.set(lease.child, lease); return lease.child;
        },
        terminate: async child => { const lease = leasesByChild.get(child); if (!lease) throw new Error("Original child has no process lease."); await this.leases.terminate(lease); },
        joinTermination: async child => { const lease = leasesByChild.get(child); if (!lease) throw new Error("Original child has no process lease."); await lease.settled; },
        requestMs: 60_000,
        shutdownMs: candidate.policy?.resources.shutdownTimeoutMs ?? 5_000,
        reserveCall: (original, requestId, effect) => archive.reserve(original, requestId, effect),
        classifyEffect: (original, capability, method, declared) => archive.methodEffect(original, capability, method, declared),
        // Diagnostics own no plugin outcome; callback failures stay local.
        record: observation => { try { Promise.resolve(this.recordAsync?.(observation)).catch(() => {}); } catch { /* Diagnostic callback is isolated. */ } },
        archiveUnknown: observation => archive.observe(observation),
        joinArchives: original => archive.joinScope(original)
      });
      const module = await bridge.prepare(candidate, identity);
      const bridgeContext: PluginContext = Object.freeze({ ...context, services: Object.freeze({
        ...context.services,
        require: <T>(capability: string): T => boundServices.has(capability) ? boundServices.get(capability) as T : context.services.require<T>(capability),
        optional: <T>(capability: string): T | undefined => boundServices.has(capability) ? boundServices.get(capability) as T : context.services.optional<T>(capability),
        provide: <T>(capability: string, value: T): void => {
          const contract = contracts[capability];
          if (contract?.kind === "async-methods") {
            if (!value || typeof value !== "object") throw new Error("Async provider must be an object.");
            declareAsyncPluginService(value, contract.methods, contract.effects);
          }
          context.services.provide(capability, value);
        }
      }) });
      await module.activate(bridgeContext);
      // Added after bridge commit. Only probes are repeated; prepare/commit or
      // accepted business calls never receive replacement IDs.
      context.effects.add(() => {
        let stopped = false, timer: NodeJS.Timeout | undefined, tick: Promise<void> = Promise.resolve();
        const schedule = () => { if (!stopped) { timer = setTimeout(() => {
          // The bridge reports one original-owner failure. This observer never
          // retries a failed probe or emits a second lifecycle failure.
          tick = bridge.probe(identity).then(schedule, () => { stopped = true; });
        }, 1_000); timer.unref(); } };
        schedule();
        return async () => { stopped = true; clearTimeout(timer); await tick; };
      }, "probe original async isolated child without replay");
    } });
  }
}
