import { runPluginActivation } from "../plugin-kernel/pluginActivationContext.js";
import type { PluginIdentity } from "../plugin-kernel/types.js";
import type { ManagerApiOperationsService } from "./apiOperationContract.js";
import type { ApiExternalListenerRegistration } from "./apiExternalListenerBinding.js";
import type { PeerLanServer, PeerLanStatus } from "./peerLanServer.js";

export type PeerLanListenerMetadataContext = Readonly<{
  identity: PluginIdentity;
  server: Pick<PeerLanServer, "boundAddress" | "subscribeStatus">;
  operations: Pick<ManagerApiOperationsService, "registerExternalListener">;
  refresh(): void;
  reportError?(error: unknown): void;
}>;

/** Metadata only: the original Peer runtime still owns receive, upgrades, authentication and sockets. */
export function createPeerLanListenerMetadata(context: PeerLanListenerMetadataContext) {
  const identity = Object.freeze({ ...context.identity });
  let started = false, stopping = false;
  let unsubscribe: (() => void) | undefined;
  let current: ApiExternalListenerRegistration | undefined, addressKey: string | undefined;
  let stopFlight: Promise<void> | undefined;
  const retiring = new Set<Promise<void>>(), cleanupErrors: unknown[] = [];
  const report = (error: unknown) => {
    try {
      if (context.reportError) context.reportError(error);
      else console.warn("Peer LAN listener metadata unavailable:", error instanceof Error ? error.message : "unknown metadata failure");
    } catch { /* A diagnostic must not change the original Peer listener's lifetime. */ }
  };
  const refresh = () => { try { context.refresh(); } catch (error) { report(error); } };
  const retireCurrent = () => {
    const previous = current; current = undefined; addressKey = undefined;
    if (!previous) return;
    try { previous.stopAccepting(); } catch (error) { cleanupErrors.push(error); report(error); }
    refresh();
    const completion = Promise.resolve().then(() => previous.dispose());
    retiring.add(completion);
    void completion.then(() => retiring.delete(completion), error => {
      retiring.delete(completion); cleanupErrors.push(error); report(error);
    });
  };
  const synchronize = (status?: PeerLanStatus) => {
    if (stopping) return;
    try {
      const address = !status || status.state === "listening" ? context.server.boundAddress() : undefined;
      if (!address) { retireCurrent(); return; }
      const key = JSON.stringify([address.address, address.family, address.port]);
      if (current && addressKey === key) return;
      retireCurrent();
      const hostname = ["0.0.0.0", "::", "[::]"].includes(address.address) ? undefined
        : address.address.includes(":") && !address.address.startsWith("[") ? `[${address.address}]` : address.address;
      current = runPluginActivation(identity, () => context.operations.registerExternalListener({
        listenerId: "manager.rabilink.peer.lan", address: { protocol: "http", port: address.port, ...(hostname ? { hostname } : {}) },
        protocol: "rabilink-peer-lan", invocation: "discovery-only", authentication: { kind: "native",
          description: "One original Peer LAN listener: POST /api/rabilink/peer/receive uses the application's encrypted transport-control protocol; GET Upgrade /api/rabilink/peer/tunnel/socket uses the original application bootstrap and public-key tunnel handshake. Node bearer tokens do not authenticate these protocols; no public business RPC is added." }
      }));
      addressKey = key; refresh();
    } catch (error) { report(error); }
  };
  const stopAccepting = () => {
    if (stopping) return;
    stopping = true;
    try { unsubscribe?.(); } catch (error) { cleanupErrors.push(error); report(error); }
    unsubscribe = undefined; retireCurrent();
  };
  return Object.freeze({
    /** Called only by the published Peer owner after previousRetirement; never starts a server. */
    start(): void {
      if (stopping) throw new Error("Peer LAN metadata owner is stopping.");
      if (started) return;
      started = true;
      unsubscribe = context.server.subscribeStatus(synchronize);
      synchronize();
    },
    stopAccepting,
    stop(): Promise<void> {
      stopAccepting();
      return stopFlight ??= (async () => {
        while (retiring.size) await Promise.allSettled([...retiring]);
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Peer LAN listener metadata cleanup failed.");
      })();
    }
  });
}
