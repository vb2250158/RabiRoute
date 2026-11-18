import path from "node:path";
import { ManagementError, callNapcatWebuiManagement as call, checkNapcatWebuiManagementAccount as account, napcatWebuiDigest as digest, type NapcatWebuiManagementContext, type NapcatWebuiManagementSelection } from "./napcatWebuiManagementOperations.js";
import { resolveNapcatWebuiNativeFileReference } from "./napcatWebuiResources.js";
export type NapcatNativeDirectorySelection = {
    routeId: string;
    instanceId: string;
    botUserId: string;
    onebotHttpUrl: string;
    onebotAccessToken: string;
    fileRef: string;
};
/** Internal egress bridge. The caller supplies its original OneBot admission closure, never a fabricated HTTP request. */
export async function resolveNapcatWebuiNativeDirectory(context: NapcatWebuiManagementContext, selection: NapcatNativeDirectorySelection, signal: AbortSignal, authorize: () => void): Promise<{
    nativePath: string;
    name: string;
    snapshotDigest: string;
    assertCurrent(): void;
    release(): void;
}> {
    authorize();
    signal.throwIfAborted();
    if (!context.acquireNativeFileLease)
        throw new ManagementError("NATIVE_FILE_LEASE_OWNER_UNAVAILABLE");
    const lease = context.acquireNativeFileLease();
    let released = false;
    const release = () => {
        if (!released) {
            released = true;
            lease.release();
        }
    };
    try {
        const binding: NapcatWebuiManagementSelection = {
            routeId: selection.routeId, instanceId: selection.instanceId, expectedUserId: selection.botUserId, assertCurrent: () => {
                authorize();
                lease.assertCurrent();
                signal.throwIfAborted();
            }
        };
        const session = await context.openManagementSession(binding, signal);
        const status = await account(session, binding, signal);
        if (!status.loggedIn)
            throw new ManagementError("LOGIN_REQUIRED", 409);
        if (!session.sourceIdentity)
            throw new ManagementError("NATIVE_FILE_SOURCE_UNAVAILABLE");
        const directory = await resolveNapcatWebuiNativeFileReference(context, binding, session.sourceIdentity, selection.fileRef);
        if (!directory.isDirectory)
            throw new ManagementError("NATIVE_DIRECTORY_REQUIRED", 400);
        const config = await call(session, binding, "GET", "/api/OB11Config/GetConfig", {}, signal) as {
            network?: {
                httpServers?: unknown;
            };
        };
        const endpoint = new URL(selection.onebotHttpUrl), port = Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80));
        if (!Array.isArray(config?.network?.httpServers))
            throw new ManagementError("NATIVE_ONEBOT_SOURCE_UNAVAILABLE");
        const servers = config.network.httpServers.filter(server => server && typeof server === "object" && server.enable === true && Number(server.port) === port && String(server.token ?? "") === selection.onebotAccessToken);
        if (servers.length !== 1)
            throw new ManagementError("NATIVE_ONEBOT_SOURCE_MISMATCH", 409);
        // This is the original configured instance's live OneBot config, not a hostname guess.
        // Successful readdir proves a current native directory. External clients may still change it after this snapshot.
        const entries = await call(session, binding, "GET", "/api/File/list", { path: directory.nativePath }, signal);
        if (!Array.isArray(entries))
            throw new ManagementError("NATIVE_DIRECTORY_UNAVAILABLE", 409);
        await account(session, binding, signal);
        const assertCurrent = () => {
            if (released)
                throw new ManagementError("NATIVE_DIRECTORY_LEASE_RELEASED", 409);
            binding.assertCurrent();
            session.assertCurrent();
        };
        assertCurrent();
        const syntax = directory.platform === "win32" ? path.win32 : path.posix;
        return {
            nativePath: directory.nativePath, name: syntax.basename(directory.nativePath) || "root", snapshotDigest: digest(entries), assertCurrent, release
        };
    }
    catch (error) {
        release();
        throw error;
    }
}
