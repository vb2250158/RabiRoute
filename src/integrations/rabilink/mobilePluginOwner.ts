import type http from "node:http";
import path from "node:path";
import { createRabiLinkMobileOwner, type RabiLinkMobileWorker } from "../../manager/rabiLinkMobileOwner.js";
import type { RabiLinkAgentPrincipal } from "../../manager/rabiLinkAgentDevices.js";

export type MobileConnectionPort = Readonly<{
  snapshot(): Readonly<{ deviceId: string; deviceGuid: string; scope: string; generation: string }>;
  authorize(request: http.IncomingMessage): RabiLinkAgentPrincipal | null;
  applicationOwnerTarget(): Promise<string>;
  peers(): Promise<RabiLinkMobileWorker[]>;
}>;

/** Mobile state and APIs belong to the endpoint; shared transport keeps its independent lifetime. */
export function createMobilePluginOwner(options: { rootDir: string; connection(): MobileConnectionPort; assertCurrent(): void }) {
  let key = "";
  let owner: ReturnType<typeof createRabiLinkMobileOwner> | undefined;
  return () => {
    options.assertCurrent();
    const connection = options.connection();
    const snapshot = connection.snapshot();
    const identity = JSON.stringify(snapshot);
    if (owner && key === identity) return owner;
    key = identity;
    owner = createRabiLinkMobileOwner({
      dataDir: path.join(options.rootDir, "data", "rabilink"), sourceDeviceId: snapshot.deviceId,
      authorize: request => connection.authorize(request),
      assertCurrent() {
        options.assertCurrent();
        if (connection !== options.connection() || identity !== JSON.stringify(connection.snapshot())) {
          throw Object.assign(new Error("MOBILE_CONNECTION_CHANGED"), { code: "MOBILE_CONNECTION_CHANGED", statusCode: 401 });
        }
      },
      connectionContextAvailable: () => Boolean(connection.snapshot().scope),
      applicationOwnerTarget: () => connection.applicationOwnerTarget(), peers: () => connection.peers()
    });
    return owner;
  };
}
