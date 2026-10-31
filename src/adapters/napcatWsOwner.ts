import http from "node:http";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { ManagerPluginRouteRegistry } from "../manager/managerPluginRouteRegistry.js";
import type { ManagerApiOperationsService } from "../manager/apiOperationContract.js";
import type { ApiExternalListenerPublication, ApiExternalListenerRegistration } from "../manager/apiExternalListenerBinding.js";
import { createNapCatNativeOperations, napcatListenerBinding } from "./platformNativeOperations.js";
import { getGatewayListenerRuntime } from "../runtime/gatewayListenerRuntime.js";

export type NapCatFrameContext = Readonly<{ data: RawData; isBinary: boolean; signal: AbortSignal }>;
export type NapCatTaskLease = (operation: () => unknown | Promise<unknown>) => Promise<void>;
export type NapCatWsOwnerContext = Readonly<{
  instanceId: string;
  port: number;
  server: WebSocketServer;
  operations?: Pick<ManagerApiOperationsService, "registerExternalListener"> | ManagerPluginRouteRegistry;
  connected(socket: WebSocket, request: http.IncomingMessage, track: NapCatTaskLease): (frame: NapCatFrameContext) => Promise<void>;
  reportError(error: Error): void;
  publish?(publication: ApiExternalListenerPublication | undefined): void;
}>;

/** Owns the original loopback listener and accepted callbacks; it never calls the platform HTTP API. */
export async function startNapCatWsOwner(context: NapCatWsOwnerContext) {
  const server = context.server;
  const runtime = context.operations ? undefined : getGatewayListenerRuntime();
  const reportError = (error: Error) => {
    try { context.reportError(error); } catch (reportFailure) { console.error("NapCat owner diagnostic failed", reportFailure); }
  };
  const pending = new Set<Promise<void>>();
  const run: NapCatTaskLease = operation => {
    const task = Promise.resolve().then(operation).then(() => undefined, error => reportError(error instanceof Error ? error : new Error(String(error))));
    pending.add(task);
    void task.then(() => pending.delete(task));
    return task;
  };
  let binding: ApiExternalListenerRegistration | undefined;
  const listener = http.createServer((_request, response) => response.writeHead(426, { "content-type": "text/plain", "content-length": "16" }).end("Upgrade Required"));
  listener.on("upgrade", (request, socket, head) => {
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { url = new URL("http://127.0.0.1/"); } // The native ws owner has no pathname filter or URL-decoding requirement.
    if (!binding?.handleUpgrade(request, url, socket, head)) socket.destroy();
  });
  const onError = (error: Error) => reportError(error);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    binding?.stopAccepting();
    try { context.publish?.(undefined); } catch (error) { reportError(error instanceof Error ? error : new Error(String(error))); }
    const httpClosed = !listener.listening ? Promise.resolve() : new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    listener.closeAllConnections();
    for (const socket of server.clients) socket.terminate();
    const wsClosed = new Promise<void>(resolve => server.close(() => resolve()));
    const closed = await Promise.allSettled([Promise.resolve().then(() => binding?.dispose()), httpClosed, wsClosed]);
    while (pending.size) await Promise.allSettled([...pending]);
    listener.off("error", onError);
    const errors = closed.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "NapCat listener cleanup failed.");
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { listener.off("listening", ready); reject(error); };
      const ready = () => { listener.off("error", failed); resolve(); };
      listener.once("error", failed); listener.once("listening", ready);
      listener.listen(context.port, "127.0.0.1");
    });
    listener.on("error", onError);
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("NapCat listener has no TCP address.");
    const registry = context.operations ?? { registerExternalListener: (definition: Parameters<ManagerApiOperationsService["registerExternalListener"]>[0]) => runtime!.registerExternalListener(`platform.napcat.${context.instanceId}`, definition) };
    const nativeDefinition = napcatListenerBinding(context.instanceId, address.port);
    const operationId = runtime?.operationId(nativeDefinition.listenerId) ?? nativeDefinition.listenerId;
    const definition = { ...nativeDefinition, listenerId: operationId };
    binding = registry instanceof ManagerPluginRouteRegistry
      ? registry.registerExternalListener(`gateway.napcat.${context.instanceId}`, definition)
      : registry.registerExternalListener(definition);
    binding.registerUpgrades(createNapCatNativeOperations(context.instanceId, address.port, async input => {
      input.prepareHandshake({});
      let upgraded = false;
      server.handleUpgrade(input.request, input.socket, Buffer.from(input.head), socket => {
        upgraded = true;
        const tasks = new Set<Promise<void>>();
        const track: NapCatTaskLease = operation => {
          const work = run(operation); tasks.add(work); void work.then(() => tasks.delete(work)); return work;
        };
        let resolveClosed!: () => void;
        const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
        socket.once("close", () => { void (async () => {
          while (tasks.size) await Promise.allSettled([...tasks]);
          resolveClosed();
        })(); });
        input.accept({ closed, close: () => { socket.terminate(); return closed; } });
        // Install the error owner before invoking callback code; a failed callback still owns the socket.
        socket.on("error", reportError);
        const frame = context.connected(socket, input.request, track);
        socket.on("message", (data, isBinary) => { void track(() => frame({ data, isBinary, signal: input.signal })); });
        server.emit("connection", socket, input.request);
      });
      // ws has already written its native handshake rejection. Join its close rather than append another response.
      if (!upgraded && !input.socket.destroyed) await new Promise<void>(resolve => input.socket.once("close", resolve));
    }, server.options.maxPayload, operationId));
    context.publish?.(binding.publication());
    return { listener, server, binding, run, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "NapCat startup and listener cleanup failed."); }
    throw error;
  }
}

export type NapCatWsOwner = Awaited<ReturnType<typeof startNapCatWsOwner>>;
