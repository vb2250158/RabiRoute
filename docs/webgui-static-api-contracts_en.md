English | [简体中文](webgui-static-api-contracts.md)

# WebGUI static contracts and native file streams

Status: native-owner, controller and core-plugin source wiring has been integrated, and the old static branches have been removed. The matching static/final-fallback tests pass 15/15. Unified compilation, installed acceptance and actual remote acceptance remain pending; global coverage remains not-proven. This reference is for Manager maintainers; two resource collection contracts do not establish a global API count or coverage result.

`src/manager/webguiStaticOperations.ts` returns two executable resource collections. `nativeWebguiStaticOwner.ts` owns the actual file descriptors, integrity checks, backpressure and cleanup. Individual hashes and filenames do not become separate business operations.

| Contract | Template | Dispatch requirement |
| --- | --- | --- |
| `manager.webgui-static.release` | `/_rabiroute/web/:resource`, final raw remainder | Normal native HTTP registration; GET/HEAD read files, other methods retain 405 |
| `manager.webgui-static.distribution` | `/:resource`, possibly empty final raw remainder | Final static fallback phase, after business APIs, Host-private protocols and the API 404 decision |

Both use `method:"*"`, `httpProxy` and native response metadata/streams. Distribution explicitly declares `httpProxy.dispatch:"final-fallback"` and uses formal `registerHttpProxies()` registration. Registry runs it after ordinary operations, upgrades and known-path 405 handling, and projects its phase into discovery and OpenAPI. It does not claim private business paths. Do not remove the phase and relax ordinary cross-owner collision checks. A second intersecting final fallback is rejected.

## Native behavior and resource precedence

| Request | Preserved result |
| --- | --- |
| GET `/assets/<single ASCII filename>` | Package `assets/` wins when present: 200, original PNG/SVG media type and no added cache-control. HEAD skips this precedence layer |
| GET/HEAD `/index.html` or extensionless path | If an active Web release exists, use its `web/index.html`, inject the release attribute and rewrite assets URLs; 200, HTML, no-store and revision header |
| Existing dist file | 200 with the original extension mapping; index uses no-store, hashed filenames immutable, other files no-cache |
| Missing extensionless dist path | Use the dist index as the SPA shell |
| Missing dist index or a missing file with an extension | Original 503 text; ordinary API paths retain API 404 |
| Verified `/_rabiroute/web/<sha256>/<web or docs path>` | 200, original media type, immutable, nosniff and revision header; HEAD has no body |
| Invalid patch path / malformed encoding / missing or corrupt file | Retain 404 / 400 / 404 respectively; active-shell integrity failures return 503 |

The native final dist fallback also accepts other HTTP methods. Package asset precedence applies only to GET; active-release shell precedence applies only to GET/HEAD. Patch errors use a generic message without filesystem paths to avoid disclosing private directories.

The old chain does not implement Range, If-None-Match, If-Modified-Since, gzip/br or CSP. Requests still receive a full 200; migration adds no 206/304, ETag, Last-Modified, Content-Encoding or CSP and no separate caching/compression policy.

Ingress retains its existing public-static exceptions and WebGUI/Agent connection authentication. Discovery is not an extra authorization table. Host publication, reconcile and other private protocols remain outside these owners and do not become public.

## Files and lifecycle

- Pin the real roots for dist, package assets and candidates separately. Decode once; reject NUL, escaping paths and escaping links. Revalidate the connection after asynchronous steps and the real root/file identity around reads and writes.
- `WebPatchService` retains revision, manifest and backend compatibility ownership. The static owner creates no active pointer, publication state or manifest cache. It hashes the selected file through the same descriptor, then sends from offset zero.
- File chunks are at most 64 KiB with bounded prefetch under backpressure. HTML rewriting uses a UTF-8 decoder and a 64-character boundary window rather than accumulating the response.
- Cancellation, deadlines, revocation, missing resources, root replacement and registration retirement stop the pipeline. The handler ends only after `FileHandle.close()` completes. `activeFileCount()` exposes the number of active files.
- Initial manifest validation retains the publication owner's existing checks and capacity limits. Concurrent reads create no publication effects.

## Integrated source wiring

1. The owner now directly uses formal `WebPatchService.staticManifest(revision): Promise<Readonly<WebPatchManifest>>`. It awaits initialization, checks closed/faulted state, reuses `compatible()` and returns a detached clone. There is no private access, type bypass or additional manifest cache.
2. `controlPlaneRoutes.ts` now constructs `NativeWebguiStaticOwner` with `packageRoot`, `webuiDistPath`, `isControlPath` and `{ candidates, status, staticManifest }` bound to the original service. The constructor consumes only those three patch-service members.
3. The core plugin now registers both collections through tracked formal `registerHttpProxies([...definitions.resources, definitions.fallback])`, retaining the factory's final-fallback descriptor. Registry owns their active catalog, generation publication and retirement. Existing private handlers run first; the owner excludes API/private paths before static bytes.
4. These five old helpers have been removed from `controlPlaneRoutes.ts`: `contentTypeFor`, `webuiCacheControl`, `staticWebuiResponse`, `htmlResponse`, `assetResponse`. The final package-asset, old GET/HEAD shell and final HTML branches have also been removed. The original API boundary and ingress authentication remain in the controller chain.
5. The `WEB_PATCH_PREFIX` static block and its exclusive media-type helper/imports have been removed from `webPatchRoutes.ts`. The public-core service owner handles status/receipts and Host-private publication/reconcile.
6. The old whole-body `WebPatchService.document()` / `read()` entries have been removed. Static files and shell rewriting use the new owner; module resources retain their native purpose.

These statements describe current source wiring. The index owner checks the developer index and documentation-page group. After unified compilation, verify searchable bilingual pages, root HTML references to the actual revision, readable patch-resource/docs bytes and absence of old runtime references. Do not mark global migration complete before unified compilation, installed acceptance and actual remote acceptance.

## Focused validation

```powershell
node --import tsx --test --test-concurrency=1 src/manager/webguiStaticOperations.test.ts
```

Tests use real temporary files, HTTP, WebPatchService import/publication and formal `staticManifest()`, binding the native owner through `ManagerPluginRouteRegistry.registerHttpProxies()`. They cover public reads, precedence, HEAD, original Range/conditional behavior, media/cache, encoding/traversal, directory-junction escape, root/file removal, revocation, cancellation, deadlines, retirement and actual descriptor cleanup; UTF-8/chunk-boundary HTML rewrites and old-revision files are also covered. This Windows host cannot create ordinary file symlinks, so actual directory junctions exercise the escape boundary; missing privilege is not reported as a successful file-symlink test.

The 13 static-owner tests include business-API precedence across owners, native 405 handling, retained Host-private handlers, rejection of duplicate final fallbacks and phase projection into discovery/OpenAPI. Together with the two formal final-fallback tests, the matching run passes 15/15. Compiled acceptance checks for root HTML, actual-revision resources and docs bytes are prepared. Unified compilation and execution of those checks, installed acceptance and actual remote downloads remain with the root chat.
