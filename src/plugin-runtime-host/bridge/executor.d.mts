import type { ChildProcess } from "node:child_process";
import type { PluginCandidate, PluginContext, PluginIdentity, PluginModule } from "../../plugin-kernel/types.js";
import type { AsyncMethodEffect, OutcomeObservation } from "../asyncOutcomeArchive.js";
export type ServiceTransport = Readonly<{ kind: "unsupported" }> | Readonly<{ kind: "data" }> | Readonly<{ kind: "async-methods"; methods: readonly string[]; effects?: Readonly<Record<string, AsyncMethodEffect>> }>;
export type PackageProof = Readonly<{ root: string; files: readonly Readonly<{ relative: string; sha256: string }>[] }>;
export type ChildObservation = Readonly<{ code: number | null; signal: NodeJS.Signals | null; observedAt: number }>;
export type RuntimeObservation = Readonly<{ identity: PluginIdentity; state: string; pid: number | null; firstFailure?: unknown; firstUnknownObservation?: unknown; calls: readonly unknown[]; observation: { exit: ChildObservation | null; close: ChildObservation | null }; pending: readonly string[] }>;
export class BridgedIsolatedPluginExecutor {
  constructor(options: Readonly<{
    contracts: Readonly<Record<string, ServiceTransport>>;
    resolvePackage(candidate: PluginCandidate): Promise<PackageProof>;
    runWithIdentity<T>(identity: PluginIdentity, operation: () => T): T;
    launch?(entry: string, identity: PluginIdentity, candidate: PluginCandidate): ChildProcess;
    terminate?(child: ChildProcess): Promise<void>;
    joinTermination?(child: ChildProcess): Promise<void>;
    requestMs?: number; shutdownMs?: number;
    record?(observation: RuntimeObservation): void;
    reserveCall?(identity: PluginIdentity, requestId: string, effect: AsyncMethodEffect): () => void;
    classifyEffect?(identity: PluginIdentity, capability: string, method: string, declared: AsyncMethodEffect): AsyncMethodEffect;
    archiveUnknown?(observation: OutcomeObservation): Promise<void>;
    joinArchives?(identity: PluginIdentity): Promise<void>;
  }>);
  prepare(candidate: PluginCandidate, identity: PluginIdentity): Promise<PluginModule>;
  probe(identity: PluginIdentity): Promise<void>;
  observations(): readonly RuntimeObservation[];
  uncertainObservations(): readonly unknown[];
}
