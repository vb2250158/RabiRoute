import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  createBuiltinPluginExecutor,
  RoutingPluginExecutor,
  type PluginExecutor
} from "../plugin-kernel/pluginExecutor.js";
import type { PluginCandidate, PluginContext, PluginIdentity, PluginModule } from "../plugin-kernel/types.js";
import { ProcessLeaseRegistry, type ProcessLease, type ProcessLeaseOwner } from "../runtime/processLeaseRegistry.js";
import {
  ISOLATED_PLUGIN_PROTOCOL_VERSION,
  parseIsolatedPluginResponse,
  samePluginIdentity,
  type IsolatedPluginCommand,
  type IsolatedPluginPreparePayload,
  type IsolatedPluginResponse
} from "./protocol.js";

function hostEntryPath(): string {
  return fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.js", import.meta.url));
}

function owner(identity: PluginIdentity): ProcessLeaseOwner {
  return Object.freeze({
    applicationGenerationId: identity.applicationGenerationId,
    managerInstanceId: identity.managerInstanceId,
    activationId: identity.activationId,
    instanceId: identity.instanceId,
    revision: identity.revision
  });
}

class IsolatedClient {
  readonly #pending = new Map<string, { sequence: number; resolve(value: IsolatedPluginResponse): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  #sequence = 0;
  constructor(readonly child: ChildProcess, readonly nonce: string, readonly identity: PluginIdentity) {
    child.on("message", message => this.#receive(message));
    const fail = (): void => this.#failAll(new Error("Isolated plugin host exited."));
    child.once("exit", fail);
    child.once("error", fail);
  }

  request(command: IsolatedPluginCommand, payload?: IsolatedPluginPreparePayload, timeoutMs = 60_000): Promise<IsolatedPluginResponse> {
    if (!this.child.connected || this.child.exitCode !== null) return Promise.reject(new Error("Isolated plugin host is unavailable."));
    const requestId = randomUUID();
    const sequence = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`Isolated plugin ${command} timed out.`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { sequence, resolve, reject, timer });
      this.child.send({
        protocolVersion: ISOLATED_PLUGIN_PROTOCOL_VERSION,
        requestId,
        nonce: this.nonce,
        sequence,
        identity: this.identity,
        command,
        ...(payload === undefined ? {} : { payload })
      }, error => {
        if (!error) return;
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  startHeartbeat(intervalMs: number, timeoutMs: number, onFailure: (error: Error) => void): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const schedule = (): void => {
      if (stopped) return;
      timer = setTimeout(() => { void tick(); }, intervalMs);
      timer.unref?.();
    };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const response = await this.request("ping", undefined, timeoutMs);
        if (!response.ok || response.state !== "committed") throw new Error("Isolated plugin heartbeat state mismatch.");
        schedule();
      } catch (error) {
        if (stopped) return;
        stopped = true;
        onFailure(error instanceof Error ? error : new Error(String(error)));
      }
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  #receive(value: unknown): void {
    let response: IsolatedPluginResponse;
    try { response = parseIsolatedPluginResponse(value); } catch (error) {
      this.#failAll(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (response.nonce !== this.nonce || !samePluginIdentity(response.identity, this.identity)) {
      this.#failAll(new Error("Isolated plugin response identity mismatch."));
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    if (response.sequence !== pending.sequence) {
      this.#failAll(new Error("Isolated plugin response sequence mismatch."));
      return;
    }
    this.#pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response);
    else pending.reject(new Error(response.error?.message ?? "Isolated plugin request failed."));
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

type ActiveIsolatedHost = Readonly<{
  lease: ProcessLease;
  client: IsolatedClient;
  published: Readonly<{
    services: readonly unknown[];
    contributions: readonly unknown[];
  }>;
  stopHeartbeat?: () => void;
  runtimeFailure?: Promise<Readonly<{ error: Error; termination: Promise<void> }>>;
}>;

export type IsolatedPluginExecutorOptions = Readonly<{
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  terminationTimeoutMs?: number;
}>;

function restartDelay(
  candidate: PluginCandidate,
  attempts: number[],
  now = Date.now()
): number | undefined {
  const policy = candidate.policy?.restart;
  if (!policy || policy.mode !== "on_failure" || policy.maxAttempts === 0) return undefined;
  while (attempts.length && attempts[0]! < now - policy.windowMs) attempts.shift();
  if (attempts.length >= policy.maxAttempts) return undefined;
  const attempt = attempts.length;
  attempts.push(now);
  return Math.min(policy.maximumBackoffMs, policy.initialBackoffMs * (2 ** attempt));
}

function waitForRestart(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export class IsolatedPluginExecutor implements PluginExecutor {
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #terminationTimeoutMs: number;
  constructor(readonly leases = new ProcessLeaseRegistry(), options: IsolatedPluginExecutorOptions = {}) {
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 3_000;
    this.#terminationTimeoutMs = options.terminationTimeoutMs ?? 5_000;
  }

  async prepare(candidate: PluginCandidate, identity: PluginIdentity): Promise<PluginModule> {
    if (candidate.entry.execution !== "isolated") {
      throw new Error(`IsolatedPluginExecutor cannot execute ${candidate.entry.execution} plugins.`);
    }
    return Object.freeze({ activate: context => this.#activate(candidate, identity, context) });
  }

  async #terminateBounded(lease: ProcessLease): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const completed = await Promise.race([
      this.leases.terminate(lease).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.#terminationTimeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
    if (!completed && lease.child.exitCode === null) lease.child.kill("SIGKILL");
  }

  async #activate(candidate: PluginCandidate, identity: PluginIdentity, context: PluginContext): Promise<void> {
    const processOwner = owner(identity);
    const shutdownTimeoutMs = candidate.policy?.resources.shutdownTimeoutMs ?? 5_000;
    const maxChildProcesses = candidate.policy?.resources.maxChildProcesses ?? 2;
    const dependencyServices = [...candidate.manifest.requires, ...candidate.manifest.optional].flatMap(capability => {
      const value = candidate.manifest.requires.includes(capability)
        ? context.services.require(capability)
        : context.services.optional(capability);
      if (value === undefined) return [];
      try {
        return [{ capability, value: structuredClone(value) }];
      } catch {
        throw new Error(`Isolated capability has no structured-clone transport contract: ${capability}.`);
      }
    });
    const launch = async (): Promise<ActiveIsolatedHost> => {
      const nonce = randomUUID();
      const lease = this.leases.launch(processOwner, "isolated-plugin-host", () => fork(hostEntryPath(), [], {
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", "tsx"] : [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          RABIROUTE_PLUGIN_HOST_NONCE: nonce,
          RABIROUTE_PLUGIN_APP_GENERATION_ID: identity.applicationGenerationId,
          RABIROUTE_PLUGIN_MANAGER_INSTANCE_ID: identity.managerInstanceId,
          RABIROUTE_PLUGIN_ACTIVATION_ID: identity.activationId,
          RABIROUTE_PLUGIN_INSTANCE_ID: identity.instanceId,
          RABIROUTE_PLUGIN_ID: identity.pluginId,
          RABIROUTE_PLUGIN_VERSION: identity.version,
          RABIROUTE_PLUGIN_HOST: identity.host,
          RABIROUTE_PLUGIN_REVISION: identity.revision
        }
      }), { maxChildProcesses });
      const client = new IsolatedClient(lease.child, nonce, identity);
      try {
        const prepared = await client.request("prepare", {
          entryPath: candidate.entry.path,
          config: structuredClone(candidate.config),
          permissions: context.permissions.list(),
          services: dependencyServices
        });
        return Object.freeze({
          lease,
          client,
          published: Object.freeze({
            services: Object.freeze([...(prepared.services ?? [])]),
            contributions: Object.freeze([...(prepared.contributions ?? [])])
          })
        });
      } catch (error) {
        await this.leases.terminate(lease).catch(() => {});
        throw error;
      }
    };

    let stopping = false;
    const armHeartbeat = (host: ActiveIsolatedHost): ActiveIsolatedHost => {
      let publishFailure!: (failure: Readonly<{ error: Error; termination: Promise<void> }>) => void;
      const runtimeFailure = new Promise<Readonly<{ error: Error; termination: Promise<void> }>>(
        resolve => { publishFailure = resolve; }
      );
      const stopHeartbeat = host.client.startHeartbeat(
        this.#heartbeatIntervalMs,
        this.#heartbeatTimeoutMs,
        error => {
          const termination = this.#terminateBounded(host.lease).catch(() => {});
          publishFailure(Object.freeze({
            error: new Error(`Isolated plugin heartbeat failed: ${error.message}`),
            termination
          }));
        }
      );
      return Object.freeze({ ...host, stopHeartbeat, runtimeFailure });
    };

    let active = await launch();
    context.effects.adopt(async () => {
      stopping = true;
      await this.leases.terminateOwner(processOwner);
      if (!this.leases.list(processOwner).length) this.leases.releaseOwner(processOwner);
    }, "terminate isolated plugin host");
    for (const service of active.published.services as readonly { capability: string; value: unknown }[]) {
      context.services.provide(service.capability, service.value);
    }
    for (const contribution of active.published.contributions as readonly { kind: string; id: string; value: unknown }[]) {
      context.contributions.register(contribution);
    }
    context.effects.add(async () => {
      await active.client.request("commit", undefined, shutdownTimeoutMs);
      active = armHeartbeat(active);
      const attempts: number[] = [];
      const monitor = (async () => {
        let lastFailure = new Error("Isolated plugin host exited after commit.");
        while (!stopping && !context.lifecycle.signal.aborted) {
          const observed = active;
          const failureEvent = await Promise.race([
            observed.lease.settled.then(() => Object.freeze({
              error: new Error(
                `Isolated plugin host exited after commit (code=${observed.lease.child.exitCode ?? "none"}, signal=${observed.lease.child.signalCode ?? "none"}).`
              ),
              termination: Promise.resolve()
            })),
            observed.runtimeFailure ?? new Promise<Readonly<{ error: Error; termination: Promise<void> }>>(() => {})
          ]);
          await failureEvent.termination;
          observed.stopHeartbeat?.();
          if (stopping || context.lifecycle.signal.aborted || active !== observed) continue;
          lastFailure = failureEvent.error;
          while (!stopping && !context.lifecycle.signal.aborted) {
            const delayMs = restartDelay(candidate, attempts);
            if (delayMs === undefined) {
              context.lifecycle.fail(lastFailure);
              return;
            }
            await waitForRestart(delayMs, context.lifecycle.signal);
            if (stopping || context.lifecycle.signal.aborted) return;
            let replacement: ActiveIsolatedHost | undefined;
            try {
              replacement = await launch();
              if (!isDeepStrictEqual(replacement.published, observed.published)) {
                await this.leases.terminate(replacement.lease).catch(() => {});
                replacement = undefined;
                throw new Error("Restarted isolated plugin changed its published services or contributions.");
              }
              await replacement.client.request("commit", undefined, shutdownTimeoutMs);
              active = armHeartbeat(replacement);
              replacement = undefined;
              break;
            } catch (error) {
              if (replacement) await this.#terminateBounded(replacement.lease).catch(() => {});
              lastFailure = error instanceof Error ? error : new Error(String(error));
            }
          }
        }
      })();
      return async () => {
        stopping = true;
        const observed = active;
        observed.stopHeartbeat?.();
        if (observed.lease.child.exitCode === null) {
          await observed.client.request("dispose", undefined, shutdownTimeoutMs).catch(() => {});
        }
        await this.leases.terminate(observed.lease).catch(() => {});
        await monitor;
      };
    }, "commit isolated plugin host");
  }
}

export function createFullPluginExecutor(leases = new ProcessLeaseRegistry()): PluginExecutor {
  const builtin = createBuiltinPluginExecutor();
  return new RoutingPluginExecutor({
    in_process: builtin,
    declarative: builtin,
    isolated: new IsolatedPluginExecutor(leases)
  });
}
