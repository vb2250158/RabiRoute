import type { IncomingMessage } from "node:http";
import { PeerTunnelRuntime } from "../peerTunnel/runtime.js";
import { createPeerRuntimeOwner } from "../peerTunnel/pluginRuntime.js";
import { createPeerControlOperations } from "../peerTunnel/apiControlOperations.js";
import { createPeerProxyHttpOperations } from "../peerTunnel/apiProxyHttpOperations.js";
import { createPeerProxyUpgradeOperation } from "../peerTunnel/apiProxyUpgradeOperation.js";
import { createRabiPeerRuntime } from "./rabiPeerRoutes.js";
import { createDevicePeerBootstrapOperation, type DevicePeerBootstrapOptions } from "./devicePeerBootstrapRoutes.js";
import { createPersonaBootstrapOperation } from "./remotePersonaRoutes.js";
import { createPeerLanListenerMetadata, type PeerLanListenerMetadataContext } from "./peerLanListenerMetadata.js";
import type { PeerLanServer } from "./peerLanServer.js";

export type ManagerPeerPublication = {
  tunnel?: PeerTunnelRuntime;
  runtime?: ReturnType<typeof createRabiPeerRuntime>;
};

export type ManagerPeerRuntimeOptions = {
  peer: Omit<Parameters<typeof createRabiPeerRuntime>[0], "tunnelOffer">;
  tunnel: Omit<ConstructorParameters<typeof PeerTunnelRuntime>[0], "signal">;
  metadata: PeerLanListenerMetadataContext & { server: Pick<PeerLanServer, "boundAddress" | "subscribeStatus" | "status"> };
  bootstrap: {
    current: DevicePeerBootstrapOptions["current"];
    allowed: Parameters<typeof createPersonaBootstrapOperation>[0]["allowed"];
    identity: Parameters<typeof createPersonaBootstrapOperation>[0]["identity"];
  };
  publication: {
    current(): ManagerPeerPublication;
    set(value: ManagerPeerPublication): void;
  };
  admitUpgrade(request: IncomingMessage, url: URL): boolean;
};

/** Composes one plugin candidate; the Manager retains the published pointers and shared LAN listener. */
export async function createManagerPeerRuntime(options: ManagerPeerRuntimeOptions) {
  let tunnel!: PeerTunnelRuntime;
  let metadata: ReturnType<typeof createPeerLanListenerMetadata> | undefined;
  const runtime = createRabiPeerRuntime({ ...options.peer, tunnelOffer: input => tunnel.offer(input) });
  const isPublished = () => options.publication.current().tunnel === tunnel;
  try {
    tunnel = new PeerTunnelRuntime({ ...options.tunnel, signal: (call, signal) => runtime.signal(call, signal) });
    metadata = createPeerLanListenerMetadata(options.metadata);
    let accepting = true;
    const deviceBootstrap = createDevicePeerBootstrapOperation({
      current: () => {
        const current = options.bootstrap.current();
        return { ...current, scope: isPublished() && !options.tunnel.readOnly ? current.scope : "" };
      },
      bootstrap: async (input, authority) => {
        if (!isPublished()) throw new Error("Peer tunnel is stopping.");
        authority.assertCurrent();
        return tunnel.grantDeviceConnection(input, authority);
      }
    });
    const personaBootstrap = createPersonaBootstrapOperation({
      allowed: (request, url) => accepting && !options.tunnel.readOnly && options.bootstrap.allowed(request, url),
      identity: options.bootstrap.identity,
      ensure: async deviceId => {
        if (!isPublished()) throw new Error("Peer tunnel is stopping.");
        await tunnel.ensureApplicationConnection(deviceId);
      }
    });
    let previous: ManagerPeerPublication;
    const owner = createPeerRuntimeOwner({
      publish() { previous = options.publication.current(); options.publication.set({ tunnel, runtime }); },
      rollback() {
        const current = options.publication.current();
        options.publication.set({
          tunnel: current.tunnel === tunnel ? previous.tunnel : current.tunnel,
          runtime: current.runtime === runtime ? previous.runtime : current.runtime
        });
      },
      unpublish() {
        const current = options.publication.current();
        options.publication.set({
          tunnel: current.tunnel === tunnel ? undefined : current.tunnel,
          runtime: current.runtime === runtime ? undefined : current.runtime
        });
      },
      stopAccepting() { accepting = false; deviceBootstrap.stop(); metadata?.stopAccepting(); },
      async stop() {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => tunnel.stop()), Promise.resolve().then(() => runtime.stop()),
          Promise.resolve().then(() => metadata?.stop())
        ]);
        const failed = results.find(result => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      }
    });
    return { ...owner,
      start() {
        const current = options.publication.current();
        if (current.tunnel !== tunnel || current.runtime !== runtime) throw new Error("Peer runtime is no longer published.");
        const lan = options.metadata.server.status();
        if (lan.state === "listening") tunnel.startLanDiscovery(lan.port || 0);
        metadata?.start();
      },
      operations: [...createPeerControlOperations(tunnel), runtime.discoveryOperation, runtime.receiveOperation, deviceBootstrap.operation, personaBootstrap],
      httpOperations: createPeerProxyHttpOperations(tunnel),
      upgradeOperation: createPeerProxyUpgradeOperation(tunnel, options.admitUpgrade)
    };
  } catch (error) {
    // Preparation owns only these candidate resources; a published predecessor remains active.
    await Promise.allSettled([
      Promise.resolve().then(() => tunnel?.stop()), Promise.resolve().then(() => runtime.stop()),
      Promise.resolve().then(() => metadata?.stop())
    ]);
    throw error;
  }
}
