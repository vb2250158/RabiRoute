// Plugin-owned feature construction. Shared state enters through host ports.
import { createVideoOperations } from "./src/manager/videoOperations.js";
import { createVideoRuntime } from "./src/manager/videoRuntime.js";
export function createOwnedRuntime(ports) {
    return Object.freeze({
        createOperations: createVideoOperations,
        createRuntime: (identity) => createVideoRuntime(ports.rootDir, identity, ports.managerPluginProcessLeases, ports.managerReadOnly, async (deviceId, pathname, init) => {
            if (!ports.activePeerTunnel)
                throw new Error("Peer tunnel is not ready.");
            await ports.activePeerTunnel.ensureApplicationConnection(deviceId);
            return ports.activePeerTunnel.fetch(deviceId, "manager", pathname, init);
        })
    });
}
