import { pathToFileURL } from "node:url";
import type { PluginContribution, PluginEffectDisposer, PluginEffectStarter, PluginIdentity, PluginModule } from "../plugin-kernel/types.js";
import {
  ISOLATED_PLUGIN_PROTOCOL_VERSION,
  parseIsolatedPluginRequest,
  samePluginIdentity,
  type IsolatedPluginRequest,
  type IsolatedPluginResponse,
  type IsolatedPluginState
} from "./protocol.js";

type PendingEffect = { starter: PluginEffectStarter; label: string };
const expectedNonce = String(process.env.RABIROUTE_PLUGIN_HOST_NONCE ?? "");
const expectedIdentity: PluginIdentity = Object.freeze({
  applicationGenerationId: String(process.env.RABIROUTE_PLUGIN_APP_GENERATION_ID ?? ""),
  managerInstanceId: String(process.env.RABIROUTE_PLUGIN_MANAGER_INSTANCE_ID ?? ""),
  activationId: String(process.env.RABIROUTE_PLUGIN_ACTIVATION_ID ?? ""),
  instanceId: String(process.env.RABIROUTE_PLUGIN_INSTANCE_ID ?? ""),
  pluginId: String(process.env.RABIROUTE_PLUGIN_ID ?? ""),
  version: String(process.env.RABIROUTE_PLUGIN_VERSION ?? ""),
  revision: String(process.env.RABIROUTE_PLUGIN_REVISION ?? ""),
  host: String(process.env.RABIROUTE_PLUGIN_HOST ?? "manager") as PluginIdentity["host"]
});
let pendingEffects: PendingEffect[] = [];
let disposers: PluginEffectDisposer[] = [];
let controller = new AbortController();
let state: "idle" | IsolatedPluginState = "idle";
let lastSequence = 0;

function safeSend(response: IsolatedPluginResponse): void {
  try { process.send?.(response, () => {}); } catch { /* The parent heartbeat owns disconnect detection. */ }
}

function response(request: IsolatedPluginRequest, input: Omit<IsolatedPluginResponse, "protocolVersion" | "requestId" | "nonce" | "sequence" | "identity">): IsolatedPluginResponse {
  return Object.freeze({
    protocolVersion: ISOLATED_PLUGIN_PROTOCOL_VERSION,
    requestId: request.requestId,
    nonce: expectedNonce,
    sequence: request.sequence,
    identity: expectedIdentity,
    ...input
  });
}

function cloneable<T>(value: T, field: string): T {
  try { return structuredClone(value); } catch {
    throw new Error(`${field} must be structured-clone serializable in isolated execution.`);
  }
}

async function prepare(request: IsolatedPluginRequest): Promise<IsolatedPluginResponse> {
  if (state !== "idle" || !request.payload) throw new Error("Isolated plugin prepare state is invalid.");
  const payload = request.payload;
  const imported = await import(pathToFileURL(payload.entryPath).href);
  if (!imported || typeof imported.activate !== "function") throw new Error("Isolated plugin entry must export activate(context).");
  const module = Object.freeze({ activate: imported.activate }) as PluginModule;
  const inputServices = new Map(payload.services.map(service => [service.capability, service.value]));
  const provided = new Map<string, unknown>();
  const contributions: PluginContribution[] = [];
  const granted = new Set(payload.permissions);
  pendingEffects = [];
  disposers = [];
  controller = new AbortController();
  await module.activate(Object.freeze({
    identity: request.identity,
    config: payload.config,
    services: Object.freeze({
      require<T>(capability: string): T {
        if (!inputServices.has(capability)) throw new Error(`Required isolated plugin service is unavailable: ${capability}.`);
        return inputServices.get(capability) as T;
      },
      optional<T>(capability: string): T | undefined { return inputServices.get(capability) as T | undefined; },
      provide<T>(capability: string, value: T): void {
        if (provided.has(capability)) throw new Error(`Isolated plugin provided a capability more than once: ${capability}.`);
        provided.set(capability, cloneable(value, `Service ${capability}`));
      }
    }),
    contributions: Object.freeze({ register(value: PluginContribution): void {
      contributions.push(cloneable(value, `Contribution ${value.kind}/${value.id}`));
    } }),
    permissions: Object.freeze({
      has(permission: string): boolean { return granted.has(permission); },
      require(permission: string): void { if (!granted.has(permission)) throw new Error(`Plugin permission is required: ${permission}.`); },
      list(): readonly string[] { return Object.freeze([...granted].sort()); }
    }),
    lifecycle: Object.freeze({
      signal: controller.signal,
      fail(error: unknown): void {
        console.error(`Isolated plugin reported a runtime failure: ${error instanceof Error ? error.message : String(error)}`);
        setImmediate(() => { void disposeResources().finally(() => process.exit(1)); });
      }
    }),
    effects: Object.freeze({
      add(starter: PluginEffectStarter, label = "isolated plugin effect"): void { pendingEffects.push({ starter, label }); },
      adopt(disposer: PluginEffectDisposer): void { disposers.push(disposer); }
    })
  }));
  state = "prepared";
  return response(request, {
    ok: true,
    state,
    services: Object.freeze([...provided].map(([capability, value]) => Object.freeze({ capability, value }))),
    contributions: Object.freeze(contributions)
  });
}

async function commit(request: IsolatedPluginRequest): Promise<IsolatedPluginResponse> {
  if (state !== "prepared") throw new Error("Isolated plugin commit state is invalid.");
  try {
    for (const effect of pendingEffects) {
      const disposer = await effect.starter();
      if (typeof disposer !== "function") throw new Error(`Plugin effect did not return a disposer: ${effect.label}.`);
      disposers.push(disposer);
    }
    pendingEffects = [];
    state = "committed";
    return response(request, { ok: true, state });
  } catch (error) {
    await disposeResources();
    throw error;
  }
}

async function disposeResources(): Promise<void> {
  controller.abort();
  let firstError: unknown;
  for (const disposer of [...disposers].reverse()) {
    try { await disposer(); } catch (error) { firstError ??= error; }
  }
  pendingEffects = [];
  disposers = [];
  state = "disposed";
  if (firstError) throw firstError;
}

async function respond(request: IsolatedPluginRequest): Promise<void> {
  try {
    if (!expectedNonce || request.nonce !== expectedNonce || !samePluginIdentity(request.identity, expectedIdentity)) {
      throw new Error("Isolated plugin protocol identity mismatch.");
    }
    if (request.sequence !== lastSequence + 1) throw new Error("Isolated plugin request sequence mismatch.");
    lastSequence = request.sequence;
    const result = request.command === "prepare" ? await prepare(request)
      : request.command === "commit" ? await commit(request)
      : request.command === "dispose" ? (await disposeResources(), response(request, { ok: true, state: "disposed" }))
      : request.command === "ping" && state === "committed" ? response(request, { ok: true, state })
      : (() => { throw new Error("Unsupported isolated plugin command or state."); })();
    safeSend(result);
    if (request.command === "dispose") setImmediate(() => process.exit(0));
  } catch (error) {
    safeSend(response(request, {
      ok: false,
      error: { code: "isolated_plugin_failed", message: error instanceof Error ? error.message : String(error) }
    }));
    if (request.command !== "prepare" && request.command !== "ping") setImmediate(() => process.exit(1));
  }
}

async function acceptUnknown(message: unknown): Promise<void> {
  try {
    await respond(parseIsolatedPluginRequest(message));
  } catch (error) {
    // Malformed input is never allowed to escape EventEmitter's listener. It has
    // no trusted request identity to which a response could safely be correlated.
    console.error(`Rejected malformed isolated plugin IPC: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!process.send) throw new Error("Isolated plugin host requires an IPC channel.");
process.on("message", message => { void acceptUnknown(message).catch(() => {}); });
process.once("disconnect", () => { void disposeResources().finally(() => process.exit(1)); });
