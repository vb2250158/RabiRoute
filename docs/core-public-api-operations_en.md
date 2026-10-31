[English](core-public-api-operations_en.md) | [简体中文](core-public-api-operations.md)

# Manager core public API migration

For integration developers and maintainers. `createCorePublicOperations` declares nine executable operations backed by the original state, delivery reservation and Host reset owners. The declarations install routes and supply discovery, parsing and executable request/response validation. Business methods do not call a legacy HTTP dispatcher.

| Method | Path | Native behavior |
| --- | --- | --- |
| GET | `/health` | Original `managerHealthPayload()`, including application identity, readiness and background health |
| GET | `/api/automatic-updates` | Original `AutomaticCodeService.snapshot()`, retaining the disabled fallback reason |
| GET | `/api/source-patches` | Cached `ManagerSourcePatchService.status()` |
| GET | `/api/source-patches/operations/:operationId` | Original operation without private fingerprint or proof; missing 404, unavailable 503 |
| GET | `/api/web-patches` | Original `WebPatchService.status()`, identity, revision and capacity |
| GET | `/api/web-patches/operations/:operationId` | Committed 200; ready and missing 404/not_started; blocked and missing 503/unknown |
| GET | `/api/agent/delivery-authority` | Exact existing deliveryId/generation reservation proof; retains original endpoints and hashes without disclosing the prompt |
| POST | `/api/rabi/identity/reset-instance-id` | 2048-byte JSON, confirmed=true and UUID operationId/expectedGuid; original exact saved-GUID CAS; 202 means queued |
| GET | `/api/rabi/identity/reset-instance-id/:operationId` | Original Host status; queued status waits for a file event for up to ten seconds; disconnect closes the watcher |

All operations retain connection authentication. Authenticated remote connections that have not been explicitly disabled need no feature allowlist, local-source gate or second key. Reset retains the existing strict local browser exception. Forged proxy headers and unadmitted Agent credentials cannot use that exception.

`prepare` captures the original principal, selected service/methods and copied Manager identity pair before body consumption. A replaced service, method, applicationGenerationId or managerInstanceId returns 409. The outcome is not_started before dispatch and remains unknown after native dispatch; requests never move to a replacement service. Asynchronous operation reads, endpoint refreshes and reset enqueue results revalidate that identity before disclosure. Revocation or replacement cannot adopt an earlier request. The native reset transaction retains its unique operationId file and exact expectedGuid; conflicting payload reuse is rejected and uncertain results require inspecting the original operation. Cancellation never replays an accepted Host command; the registration lease joins its actual Promise. The shared JSON parser returns 413 for oversized bodies and 400 for invalid bodies or repeated reservation query identities, with contract repair metadata.

## Host and asset boundaries

`POST /_rabiroute/host/source-patches` and `/reconcile`, and `POST /_rabiroute/host/web-patches` and `/reconcile`, retain their original private Host publication protocols, identity fences, CAS, durable receipts and limits. `/_rabiroute/web/:revision/...` GET/HEAD assets now belong to the native static owner. The old static route block and buffered document()/read() rendering methods have been removed. WebPatchService modules()/module() retain versioned module mapping/exports; staticManifest() supplies compatible immutable manifests. The public activeReads compatibility field remains 0 because this service no longer owns buffered reads; actual file handles belong to NativeWebguiStaticOwner. These protocols are outside the nine public declarations. No existing public update or reset operation is reclassified as private.

## Control-plane wiring

Call `createCorePublicOperations` once at the unified `ApiOperationDefinition[]` registration point in `controlPlaneRoutes.ts`, after its owners are created. Supply:

- `identity: () => ({ applicationGenerationId: managerHostIdentity?.applicationGenerationId ?? managerInstanceId, managerInstanceId })`;
- `health: managerHealthPayload`;
- `automaticUpdates: () => automaticCodeService?.snapshot() ?? { state: "disabled", reason: "No external source root is configured." }`;
- `sourcePatches: managerSourcePatches`, `webPatches: managerWebPatches`;
- `deliveryAuthority.store: agentRequests`, `deliveryAuthority.managerInstanceId: lanAgentRegistry.localInstanceId`;
- `deliveryAuthority.refreshEndpoints` and `authorize`: the existing `agentEndpointDelivery` callbacks, retaining their unavailable-owner checks;
- `identityReset.service: instanceIdentityReset`, `identityReset.currentGuid: () => rabiGlobalConfig.read().rabiGuid`.

Public requests must reach the registry while preserving the original global read-only, startup-readiness and connection-authentication ordering. Remove direct health, automatic-updates, delivery-authority and reset branches and their old handler imports. Source/Web route handlers now retain only private Host publication branches; their public status branches have been removed.

The old production exports `handleAgentDeliveryAuthority` and `handleInstanceIdentityReset` have been removed. Their HTTP test fixtures now use the same registry. Reset rules have one owner, `createInstanceIdentityResetOwner`; delivery proof has one owner, `readAgentDeliveryAuthority`. Remove the old controller imports and calls in the final integration change without retaining a fallback. Shared controller, policy, build entry and index changes belong to the integration owner.

## Validation boundary

`corePublicOperations.test.ts` uses ephemeral HTTP ports, an enrolled remote credential, a controlled Host driver and temporary request files. It covers all nine method/path combinations, GUID CAS, operation deduplication, distinct receipt states, delivery proof, revocation before body completion, disclosure after awaits and cancellation leases. `identityResetRoutes.test.ts` retains original Host-command, durable-receipt and watcher coverage; `agentDeliveryAuthorityRoutes.test.ts` retains reservation restoration, cancellation and identity-ABA checks.

Run `node --test-concurrency=2 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/manager/corePublicOperations.test.ts src/manager/identityResetRoutes.test.ts src/manager/agentDeliveryAuthorityRoutes.test.ts`.

These tests do not publish or reset through a real Host and do not send real platform or Agent messages. The original root task owns unified compilation, final controller wiring, complete catalog parity and runtime acceptance. The independent audit remains not-proven. Its 91 classified entries and 22 old UI routeIds are neither a global HTTP total nor a count of HTTP gaps.
