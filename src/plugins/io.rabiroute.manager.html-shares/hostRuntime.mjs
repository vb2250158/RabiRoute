import { pluginStorageRoot } from "@rabiroute/host-api/shared/pluginStorage";
import { CompletionHtmlShares } from "./src/manager/completionHtmlShares.js";

/** The complete feature owns its snapshots/resources; Host supplies only existing shared primitives. */
export function createOwnedRuntime(shared, transports, identity, connection) {
  const directory = pluginStorageRoot(identity.pluginId, identity.instanceId);
  return new CompletionHtmlShares(directory, () => ({
    ...shared.rabiLinkRelayConfigForMeta(),
    deviceGuid: connection.snapshot().deviceGuid
  }), transports);
}
