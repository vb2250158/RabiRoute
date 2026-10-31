import type { ApiHttpProxyDefinition } from "./apiOperationContract.js";
import { NativeWebguiStaticOwner } from "./nativeWebguiStaticOwner.js";

/** A collection contract covers every resource in the original namespace, not each content hash. */
function collection(operationId: string, pathTemplate: string, description: string, handler: ApiHttpProxyDefinition["handler"], finalFallback = false): ApiHttpProxyDefinition {
  return { contract: {
    operationId, contractVersion: "1.0.0", method: "*", pathTemplate, exposure: "public", transport: "http", description,
    httpProxy: { wire: { dataFrameBytes: 64 * 1024, streamWindowBytes: 128 * 1024, maxConcurrentStreams: 32 },
      ...(finalFallback ? { dispatch: "final-fallback" as const } : {}),
      completion: "The original HTTP response and its file descriptor close. No whole-file response cache is created.",
      cancellation: "Abort or retirement stops the producer, joins pipeline cleanup and closes the real file descriptor before releasing the request lease." },
    request: { path: { type: "object", required: ["resource"], properties: { resource: { type: "string" } }, additionalProperties: false },
      pathRemainder: "resource", query: { type: "object", additionalProperties: true }, headers: { type: "object", additionalProperties: true }, body: { kind: "passthrough" } },
    responses: { default: { mediaType: "*/*", passthrough: true } },
    effects: { mode: "resource-read", description: "Reads only the configured package assets/dist or manifest-verified immutable Web release root. Existing ingress authentication and public-static exceptions apply; no new credential, pairing or persona grant." },
    recovery: { strategy: "repeatable-read", description: "Retain the requested immutable revision for old pages. A missing or corrupt resource fails before response bytes. Retry ordinary reads only after rediscovering a changed Manager identity." },
    validators: [{ id: "manager.webgui-static.native-owner", description: "Retains native media/cache/status/HEAD behavior, package asset priority, active-release shell rewriting and API/Host-private exclusions. Range, conditional validators, compression and CSP are not implemented by the original static chain and remain ignored/absent." },
      { id: "manager.webgui-static.root-and-integrity", description: "Decode once; reject NUL, traversal, escaping links, replaced roots/files and manifest/hash mismatch. Revalidate connection authority and resource identity after every asynchronous read and before each response chunk." }]
  }, handler };
}

export function createWebguiStaticOperations(owner: NativeWebguiStaticOwner): {
  resources: readonly ApiHttpProxyDefinition[];
  /** Install in the final static fallback phase, after business/API and private-protocol resolution.
   * A broad collection cannot be installed as an ordinary overlapping API route. */
  fallback: ApiHttpProxyDefinition;
} {
  return { resources: [collection("manager.webgui-static.release", "/_rabiroute/web/:resource",
    "Read an immutable Web release file or versioned documentation. GET/HEAD preserve revision/hash/root checks; other methods return native 405.", input => owner.patch(input))],
  fallback: collection("manager.webgui-static.distribution", "/:resource",
    "Final public static resource collection: package assets, WebGUI files and SPA shell. Invoked only after public APIs and Host-private paths have resolved. Existing method and 503 fallback behavior is retained.", input => owner.fallback(input), true) };
}
