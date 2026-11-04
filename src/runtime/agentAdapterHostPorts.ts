import type { AgentAdapterHostPorts } from "@rabiroute/plugin-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeLayout, type RuntimeLayout } from "../shared/runtimeLayout.js";
type Namespace = Readonly<Record<string, unknown>>;
const owners = new Map<string, Promise<Namespace>>();
/** Shared namespaces retain Node's original module identity; platform implementations live in their packages. */
export function createAgentAdapterHostPorts(options: {
    manager?: unknown;
    layout?: RuntimeLayout;
    loaders?: Readonly<Record<string, () => Promise<Namespace>>>;
} = {}): AgentAdapterHostPorts {
    const layout = options.layout ?? resolveRuntimeLayout(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
    const prepared = new Map<string, Namespace>();
    const read = (id: string): Promise<Namespace> => {
        if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(id))
            return Promise.reject(new Error(`Invalid Agent host module: ${id}.`));
        const override = options.loaders?.[id];
        if (override)
            return override();
        let owner = owners.get(id);
        if (!owner) {
            owner = import(`../${id}.js`);
            owners.set(id, owner);
        }
        return owner;
    };
    const host: AgentAdapterHostPorts = Object.freeze({
        environment: Object.freeze({ RABIROUTE_PACKAGE_ROOT: layout.packageRoot, RABIROUTE_STATE_ROOT: layout.stateRoot }),
        ...(options.manager === undefined ? {} : { manager: options.manager }),
        async prepareModules(ids: readonly string[]) { await Promise.all(ids.map(async (id) => { if (!prepared.has(id))
            prepared.set(id, await read(id)); })); },
        assertModules(ids: readonly string[]) { for (const id of ids)
            if (!prepared.has(id))
                throw new Error(`Agent host module has not been prepared: ${id}.`); },
        module<T = Namespace>(id: string): T {
            if (!prepared.has(id))
                throw new Error(`Agent host module has not been prepared: ${id}.`);
            return prepared.get(id) as T;
        },
        forActivation(configuration: unknown) {
            let configOwner: Namespace | undefined;
            const supplied = configuration && typeof configuration === "object" ? (configuration as {
                __agentConfiguration?: Record<string, unknown>;
            }).__agentConfiguration : undefined;
            const environment = configuration && typeof configuration === "object" ? (configuration as {
                __agentEnvironment?: Record<string, string | undefined>;
            }).__agentEnvironment : undefined;
            return Object.freeze({ ...host, environment: Object.freeze({ ...host.environment, ...environment }), module<T = Namespace>(id: string): T {
                    const owner = host.module<Namespace>(id);
                    if (id !== "config")
                        return owner as T;
                    // Original accepted work keeps this activation's transport/binding view.
                    const originalLayout = owner.runtimeLayout as RuntimeLayout | undefined;
                    const relocated = options.layout && originalLayout?.stateRoot !== layout.stateRoot
                        ? { dataDir: path.join(layout.stateRoot, "data"), memoryDataDir: path.join(layout.stateRoot, "data") } : {};
                    configOwner ??= Object.freeze({ ...owner, runtimeLayout: layout,
                        config: { ...structuredClone(owner.config as object), ...relocated, ...structuredClone(supplied ?? {}) } });
                    return configOwner as T;
                } });
        }
    });
    return host;
}
