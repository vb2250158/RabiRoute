<!-- docs-language-switch -->
<div align="center">English | <a href="./rabilink-mobile-owner-api.md">简体中文</a></div>
<!-- /docs-language-switch -->

# RabiLink mobile state API contracts

This page is for Manager and remote client developers. `src/manager/rabiLinkMobileOperations.ts` owns the executable definitions; `src/manager/rabiLinkMobileOwner.ts` owns business behavior and persistence. The same definitions install routes and publish discovery records.

## Operations

| Operation ID (prefix `manager.rabilink.`) | Method and path | Result |
| --- | --- | --- |
| `mobile.asr-settings.read` | `GET /api/rabilink/mobile/asr-settings` | Priority, current ASR workers and first online selection |
| `mobile.asr-settings.save` | `PATCH /api/rabilink/mobile/asr-settings` | Save `{priority: string[]}` and render against current workers |
| `mobile.device-status.read` | `GET /api/rabilink/mobile/device-status` | Latest report and freshness derived from receipt time |
| `mobile.device-status.record` | `POST /api/rabilink/mobile/device-status` | Save reported battery and charging status |
| `mobile.proof.record` | `POST /api/rabilink/mobile/proof` | Save a report with a stable UUID |
| `mobile.proofs.list` | `GET /api/rabilink/mobile/proofs?limit=20` | Recent reports in reverse order |
| `devices.health-capabilities.read` | `GET /api/rabilink/devices/health-capabilities` | Declare the wearable observation processing contract |

The last operation retains its native business function and now shares the executable registration path. The declaration does not prove device availability or physical acceptance.

## Identity and ownership

Authenticated enabled connections can use these public operations by default, without an additional persona, plan or feature grant. Preparation captures the original connection scope, source device and Manager owner before body parsing. The owner rechecks identity after awaited assignment/worker reads and before persistence or disclosure. Missing connection configuration is a context-unavailable result; failed authentication and a different owner PC have separate errors.

The original PC's `RabiLinkOwnerStore` owns ASR settings, status, proofs and operation receipts, isolated by connection scope. Mobile state requests also confirm the application remains assigned to this PC; the capability declaration only needs the original connection identity. Neither Relay nor clients create another authoritative business store. These APIs do not start ASR workers, execute Agent prompts or operate physical devices.

## Writes and recovery

The three writes require `Idempotency-Key`: 1–128 ASCII letters, digits, colons, periods, underscores or hyphens. The native fingerprint is `SHA256(JSON.stringify([action, body]))`. The same key and original intent replay the receipt; changed intent returns 409. Unknown fields are ignored for business values but remain in the fingerprint. Each scope holds at most 2048 receipts and rejects new operations at capacity without evicting old receipts.

An empty HTTP body retains the production decoder's `{}` default. It is a different intent from explicit JSON `null`. After upgrading, an empty body can still replay the historical `{}` receipt with its original key.

ASR replay retains the saved priority and observes current workers. Status replay retains the original `receivedAt` and recomputes `ageMs`; reports become stale after 180000 milliseconds. Proof replay retains the original UUID and time without appending a duplicate. For uncertain results, preserve the original scope, key and body for reconciliation/replay; a missing current value cannot prove the request never executed. Identity changes or exceptions after persistence starts retain `uncertain: true`.

## Damaged record isolation

Persisted raw records remain available for recovery; reads and normal writes do not delete damaged rows. Proof lists skip individual malformed records and return their count as `invalidRecords`; healthy proofs remain readable and new proofs can be appended. A damaged current mobile status makes only that status read or new write return `503 MOBILE_STATUS_RECORD_INVALID`, without blocking ASR settings or proofs.

Operation receipts are checked by the original `Idempotency-Key`. A damaged receipt with an identifiable key blocks only that key. If a damaged receipt has no identifiable key, new writes that require proof of absence are rejected. Complete existing receipts still replay with their original key and body, and healthy reads remain available. Even when current status is damaged, a previous successful status receipt can replay without overwriting the damaged data. Do not change keys to bypass a record awaiting recovery.

## Native parameter semantics

ASR accepts at most 100 unique IDs of currently ASR-capable workers. Battery input uses `batteryLevel ?? level`, preserving `Number` coercion, the 0–100 range and rounding; `charging` must be boolean. A valid `observedAt` is normalized to ISO time; otherwise receipt time is used.

Proofs retain existing field aliases and truncation at 80/120/220 UTF-16 units, with a 50000-record capacity. The `limit` query retains `Number` conversion, default 20 for invalid/zero values, clamping to 1–100 and native fractional `slice` semantics. Writes retain JSON decoding without an application-level byte cap; contracts do not narrow native permissive fields.

## Verification scope

Source tests cover real temporary-file persistence and owner recreation, receipt replay/conflicts, scope isolation, capacity, pagination, cancellation and identity changes during awaited work, plus successful status reporting and rejection of a subsequent revoked proof through the real LAN Agent identity ingress. Reports are synthetic and do not establish phone, glasses, microphone or ASR physical acceptance. See the [target architecture](./api-contract-discovery-target-architecture_en.md) for the complete objective and remaining work.
