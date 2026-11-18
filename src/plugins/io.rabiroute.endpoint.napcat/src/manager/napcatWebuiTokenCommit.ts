import { normalizeNapCatInstances, type GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { ManagementError, napcatWebuiDigest as digest, type NapcatWebuiManagementSelection } from "./napcatWebuiManagementOperations.js";
type TokenSource = {
    credentialSource: "config" | "provided";
    nativeConfigMatches: boolean;
    configuredValueMatches: boolean;
    explicitTokenSource?: "instance" | "legacy";
};
export type NapcatWebuiTokenCommitPorts = {
    assertCurrent(): void;
    readRoutes(): GatewayDefinition[];
    routeVersion(): string;
    writeRoute(id: string, definition: GatewayDefinition, expectedHash: string, operationId: string): Promise<void>;
    resolveRouteMutation(operationId: string): Promise<{
        state: "committed" | "not_committed";
    }>;
    syncRoutes(): void | Promise<void>;
    inspectSource(binding: NapcatWebuiManagementSelection, token?: string): Promise<TokenSource>;
};
/** Prepares only the original token field, then uses the original single-Route persisted CAS and original mutation ID. */
export async function prepareNapcatWebuiTokenCommit(ports: NapcatWebuiTokenCommitPorts, binding: NapcatWebuiManagementSelection, operationId: string) {
    ports.assertCurrent();
    binding.assertCurrent();
    const revision = ports.routeVersion(), routes = ports.readRoutes();
    if (ports.routeVersion() !== revision)
        throw new ManagementError("TOKEN_CONFIGURATION_CHANGED", 409);
    const matches = routes.filter(r => r.id === binding.routeId);
    if (matches.length !== 1)
        throw new ManagementError("ROUTE_UNAVAILABLE", 409);
    const original = matches[0]!, source = await ports.inspectSource(binding);
    binding.assertCurrent();
    const readPersistedRoute = () => {
        const routes = ports.readRoutes().filter(route => route.id === binding.routeId);
        if (routes.length !== 1)
            throw new ManagementError("ROUTE_UNAVAILABLE", 409);
        return routes[0]!;
    };
    const identity = (definition: GatewayDefinition) => {
        const value = structuredClone(definition);
        // The original schema may materialize legacy defaults. Compare their original normalized meaning,
        // while keeping URL, HTTP/WebUI origin, working directory, instance list and every unrelated field exact.
        value.napcatInstances = normalizeNapCatInstances(value);
        return digest(value);
    };
    const currentToken = (definition: GatewayDefinition): string | undefined => source.explicitTokenSource === "instance" ? definition.napcatInstances?.find(i => i.id === binding.instanceId)?.webuiToken : definition.napcatWebuiToken;
    if (source.credentialSource === "provided") {
        const expected = currentToken(original);
        if (typeof expected !== "string" || !expected.trim() || !(await ports.inspectSource(binding, expected)).configuredValueMatches)
            throw new ManagementError("TOKEN_CONFIGURATION_SOURCE_MISMATCH", 409);
    }
    return { commit: async (newToken: string) => {
            ports.assertCurrent();
            binding.assertCurrent();
            const before = readPersistedRoute();
            if (ports.routeVersion() !== revision || identity(before) !== identity(original))
                throw new ManagementError("TOKEN_CONFIGURATION_CHANGED", 409);
            if (source.credentialSource === "config") {
                const proof = await ports.inspectSource(binding, newToken);
                if (proof.credentialSource !== "config" || !proof.nativeConfigMatches)
                    throw new ManagementError("NATIVE_TOKEN_SOURCE_UNCONFIRMED");
                return {
                    state: "committed" as const, operationId, revision, assertCurrent: () => {
                        ports.assertCurrent();
                        binding.assertCurrent();
                    }
                };
            }
            const replacement = structuredClone(original);
            if (source.explicitTokenSource === "instance")
                replacement.napcatInstances!.find(i => i.id === binding.instanceId)!.webuiToken = newToken;
            else
                replacement.napcatWebuiToken = newToken;
            let committed = false;
            try {
                await ports.writeRoute(binding.routeId, replacement, revision, operationId);
                committed = true;
            }
            catch {
                try {
                    committed = (await ports.resolveRouteMutation(operationId)).state === "committed";
                }
                catch { /* Keep the original CAS unresolved; no second native rotation or replacement ID. */
                }
            }
            try {
                await ports.syncRoutes();
            }
            catch { /* Persisted CAS and current runtime adoption are separate; the caller still verifies the replacement native session. */
            }
            const persisted = readPersistedRoute(), actualToken = currentToken(persisted);
            const fullyCommitted = committed && actualToken === newToken;
            const expectedIdentity = identity(replacement), originalIdentity = identity(original);
            // Only the exact original definition or this precise original-field/normalized-legacy own-write may
            // retain an uncertain receipt. Same QQ with a changed URL/source/other field is never a replacement owner.
            const assertCurrent = () => {
                ports.assertCurrent();
                const route = readPersistedRoute();
                if (route.enabled !== true)
                    throw new ManagementError("ROUTE_UNAVAILABLE", 409);
                const instance = normalizeNapCatInstances(route).find(i => i.id === binding.instanceId), qq = String(instance?.botUserId ?? "");
                if (qq !== binding.expectedUserId || !(fullyCommitted ? [expectedIdentity] : [expectedIdentity, originalIdentity]).includes(identity(route)))
                    throw new ManagementError("TOKEN_CONFIGURATION_CHANGED", 409);
            };
            assertCurrent();
            return {
                state: fullyCommitted ? "committed" as const : "uncertain" as const, operationId, revision: ports.routeVersion(), assertCurrent
            };
        } };
}
