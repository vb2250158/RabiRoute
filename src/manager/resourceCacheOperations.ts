import type { ApiOperationDefinition } from "./apiOperationContract.js";
import { ResourceCache, runResourceCacheOperation, type ResourceCacheOptions } from "./resourceCache.js";
import type { RecordingArchiveRuntime } from "./recordingArchiveRuntime.js";
import { runRecordingArchiveAdminOperation, type RecordingArchiveAdminOptions } from "./recordingArchiveAdminOperation.js";
import { RESOURCE_API_ROUTES, resourceApiContract } from "./resourceApiContract.js";
import { readResourceBytes, type ResourceApiInput } from "./resourceApiRequest.js";

export type ResourceApiOwners = { cache: ResourceCache; cacheOptions: ResourceCacheOptions;
  archive: RecordingArchiveRuntime; admin: RecordingArchiveAdminOptions };

/** All resources routes share one published table; each operation awaits the real state owner. */
export function createResourceCacheOperations(owners: ResourceApiOwners): readonly ApiOperationDefinition[] {
  return RESOURCE_API_ROUTES.map(route => {
    const contract = resourceApiContract(route);
    return { contract, handler: async input => {
      let bytes: Promise<Buffer> | undefined;
      const invocation: ResourceApiInput = { route, path: input.path, request: input.request, url: input.url,
        ...(contract.request.body.kind === "json" ? { parsed: { value: input.body } } : {}),
        readBytes: limit => bytes ??= readResourceBytes(input.request.iterator({ destroyOnReturn: false }), limit) };
      if (route.family === "admin") return runRecordingArchiveAdminOperation(owners.admin, invocation);
      if (route.family === "archive" || route.family === "object") {
        const result = await owners.archive.operation(invocation);
        if (result) return result;
        if (route.family !== "object") throw new Error("Archive operation owner did not return a result.");
      }
      // Only an explicitly unbound object owner uses legacy storage. Any archive
      // denial, namespace failure or uncertain commit is already a concrete result.
      return runResourceCacheOperation(owners.cache, owners.cacheOptions, invocation);
    } };
  });
}
