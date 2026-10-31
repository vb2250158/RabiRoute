import http from "node:http";
import { once } from "node:events";
import { Script } from "node:vm";
import { ManagerPluginRouteRegistry } from "../managerPluginRouteRegistry.js";
import { fixtureApiContract } from "../apiOperationContractFixtures.js";
import type { ApiOperationStream } from "../apiOperationContract.js";

const mode = process.argv[2] ?? "";
if (!["capture-loop", "cancel-throw", "expired-getter", "live-getter-budget"].includes(mode) || !process.send) throw new Error("Owned fault fixture arguments required.");
const registry = new ManagerPluginRouteRegistry(undefined, undefined, { maximumActiveOperationsPerOperation: 1 });
const empty = { type: "object", additionalProperties: false, properties: {} } as const;
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
let handlerCalls = 0, cancelCalls = 0, drained = false, currentVmBudget: unknown;
const originalVm = Script.prototype.runInContext;
Script.prototype.runInContext = function (this: Script, ...args: Parameters<Script["runInContext"]>) {
  const previous = currentVmBudget; currentVmBudget = (args[1] as { timeout?: unknown } | undefined)?.timeout;
  try { return Reflect.apply(originalVm, this, args); } finally { currentVmBudget = previous; }
};
const featureContract = fixtureApiContract({ operationId: "fixture.stream.feature", method: "GET", pathTemplate: "/feature",
  request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" }, deadlineMs: 60 },
  responses: { "200": { mediaType: "application/octet-stream", stream: { framing: "bytes", maxFrameBytes: 1024,
    completion: "EOF.", cancellation: "Join actual fixture source." } } } });
const healthContract = fixtureApiContract({ operationId: "fixture.stream.health", method: "GET", pathTemplate: "/health",
  request: { path: empty, query: empty, headers: { type: "object" }, body: { kind: "none" } } });
const registration = registry.registerOperations("manager:fixture-stream", [{ contract: featureContract, handler: async input => {
  handlerCalls++;
  const enteredAt = performance.now();
  if (mode === "expired-getter") {
    await Promise.resolve();
    // Finite after-await fault: return after deadline before its timer gets a turn.
    while (performance.now() - enteredAt < 75) { /* Owned child only. */ }
  } else if (mode === "live-getter-budget") {
    await new Promise(resolve => setTimeout(resolve, 20));
  } else await gate;
  const stream: ApiOperationStream = {
    frames: (async function* () { try { yield Buffer.from("discarded cleanup frame"); } finally { drained = true; } })(),
    cancel() {
      cancelCalls++;
      if (mode === "cancel-throw") throw new Error("A completed synchronous cancellation failure.");
    }
  };
  return { status: 200, get stream() {
    process.send?.({ type: "getter", responseEnded: input.response.writableEnded, budget: currentVmBudget, elapsedSinceHandlerMs: performance.now() - enteredAt });
    if (["capture-loop", "expired-getter", "live-getter-budget"].includes(mode)) { while (true) { /* External child watchdog also owns this fixture. */ } }
    return stream;
  } };
} }, { contract: healthContract, handler: () => ({ status: 200, body: { ok: true, value: 1 } }) }]);
const server = http.createServer((request, response) => { if (!registry.handle(request, new URL(request.url!, "http://127.0.0.1"), response)) response.writeHead(404).end(); });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); if (!address || typeof address === "string") throw Error("Owned fixture did not bind.");
process.send({ type: "ready", url: `http://127.0.0.1:${address.port}`, pid: process.pid });
process.on("message", message => {
  const command = message as { type?: string };
  if (command.type === "release") release();
  if (command.type === "snapshot") process.send?.({ type: "snapshot", pid: process.pid, mode, active: registration.activeOperationCount(), handlerCalls, cancelCalls, drained, diagnostics: registry.streamRetirementDiagnostics() });
  if (command.type === "close-fixture") {
    release();
    // This is an isolated negative fault fixture, not a claim of resource retirement.
    // Closing this whole fixture process is its final containment boundary.
    process.send?.({ type: "closing-fixture", registryRetirementConfirmed: registry.streamRetirementDiagnostics().length === 0 });
    server.closeAllConnections(); server.close(() => { Script.prototype.runInContext = originalVm; process.disconnect?.(); });
  }
});
