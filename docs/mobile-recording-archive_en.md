English | [简体中文](mobile-recording-archive.md)

# Phone recordings: PC archival and long-term NAS storage

> **Status: in development, not deployed.** This page describes implemented module contracts and integration work, not an operational feature that can already be enabled. Automatic eviction is not enabled. LAN, P2P and Relay have not each passed physical-device acceptance, and isolated NAS mechanism tests have passed, but directory fsync returned `EPERM`; this neither proves power-loss durability nor permits enabling eviction. Earlier device evidence does not validate this feature. See [current mobile recording and review](rabilink-mobile-recording-ui_en.md).

## Goal and three independent state axes

The phone captures, reliably uploads and reviews recordings. The target PC owns long-term archival, directory queries and asynchronous transcription. Raw audio has one authoritative copy in a controlled NAS namespace; the phone retains unarchived originals, a lightweight index and replaceable playback cache. NAS originals have no TTL or capacity-based automatic deletion.

- **Archive:** `pending → uploading → committed`, with independent retry-wait or blocked failures. Archive confirmation does not imply successful transcription.
- **ASR:** queued, running, completed, failed, model-blocked and `ambiguous` are distinct. Empty text can be a successful result and does not invalidate audio.
- **Phone-original eviction:** `present → eviction_pending → evicted`. Verify and durably save a strong archive receipt before a serialized writer transaction and reader-pin protection permit eviction. Transport ACK, successful ASR and legacy `durable:true` are not deletion authority.

The intended final flow releases phone space after archival without waiting for ASR. Remote history, playback and recovery are still undergoing integration validation, so **the eviction gate is hardcoded to `false` and remains closed**. An unavailable model must not keep otherwise archivable audio at the head of a phone processing queue.

## Identity, storage and immutable contracts

The authenticated owner is the phone installation's stable device identity, verified by tunnel handshake and public key, not a token-derived scope. Credential rotation requires renewed authorization, not reassignment of recordings. A new identity after reinstall cannot automatically inherit the old one. The target worker uses the stable PC device ID, not a temporary Manager generation ID.

Only restricted local PC configuration establishes `owner → role → archiveRoot`. Existing configuration resolves the role directory; the domain-relative path is `all-day-recording/media-archive`. Deployment paths and role values are not protocol defaults. Upload bodies cannot choose an owner, role or arbitrary path. A persistent UUID identifies the namespace. Missing NAS storage, a disabled binding or a mismatching marker fails closed, without substituting local cache storage.

The protocol stores raw `pcm_s16le`, 16 kHz, mono PCM. Playback synthesizes a WAV header as needed, rather than retaining WAV and PCM as two authoritative media copies. Limits are independent:

| Item | Limit |
| --- | --- |
| Media object | 1 MiB |
| HTTP manifest body | 1 MiB |
| Total audio per manifest | 128 MiB |
| Segment / object arrays | At most 4096 items each |

A manifest freezes record identity, source, time basis, processing policy, original segment order and hashes, object offsets, gaps and total bytes. Canonical JSON recursively sorts keys and preserves array order, using UTF-8 SHA-256. The shared PC TypeScript / Android Java golden fixture has this fixed hash:

```text
c272627f1bec72e289cdd190fdf3534229e8b8a1062d11c28631b7339abc7a7b
```

A strong receipt exactly binds worker, namespace, recordId, manifestHash, totalBytes and segmentCount, and requires `durability=archived` and `retention=indefinite`. The server also requires the manifest device identity to match the authenticated owner. Replaying the same record and hash is idempotent; conflicts cannot overwrite an existing record.

The store publishes manifest and receipt in one immutable envelope to avoid a two-file commit gap. After object and original-segment hash verification, it flushes a temporary file and uses same-filesystem hard-link **no-overwrite** publication. NAS/SMB systems without hard-link support fail closed. Isolated tests on the target NAS have verified file fsync, hard-link no-overwrite publication, concurrent publication and reopening for reads; directory fsync returned `EPERM`. These establish file-operation mechanisms, not hardware power-loss durability, and cannot justify enabling phone-original eviction.

## Network order and uncertain requests

Uploads, directory queries and playback share the existing `resources` tunnel: **LAN direct → P2P → server Relay**, preserving authentication and encryption. There is no separate upload path that defaults to server transit.

Initial authorization may use server signaling to obtain a grant or public key; that does not require subsequent media to use Relay. Source inspection confirms connection ordering, but all three paths and their failure transitions still need physical-device acceptance. After a write timeout, do not blindly switch paths and replay: first query the strong receipt for the same owner, worker, namespace, recordId and manifestHash. Changing networks must not change historical ownership.

## PC model selection and asynchronous jobs

Source changes now make ordinary batch transcription without an explicit model/provider use the PC's current microphone ASR configuration. Explicit API parameters retain general override behavior. The phone neither selects nor sends a model name. The PC resolver checks availability and freezes the effective selection. Its configuration fingerprint is a derived hash, not an official revision. Unavailable models block the job without silently falling back.

The new source endpoint `POST /v1/archive/transcriptions` is **loopback-only and compute-only**. It requires `job_key`, returns transcription results, and does not write speech-library records, bind speakers or deliver to an Agent. Temporary uploads are removed after success or failure. `job_key` is a correlation identifier, **not computation idempotency**. Archive jobs must use a fixed local client, never follow the GUI's selected remote PC.

Jobs freeze their model in a durable NAS intent and use stable job keys, single concurrency and lease fencing for result publication. An unknown outcome after dispatch becomes `ambiguous` and is not automatically retranscribed; explicit recomputation creates a new processing version. Empty text is a valid result. Only `transcribe` runs automatically; historical `agent` policies are not replayed automatically.

## Module status and remaining work

| Module | Current scope and gaps |
| --- | --- |
| Contract / Android `RecordingArchiveContract` | Strict validation and cross-language golden hash implemented; not proof of working device uploads |
| Store | Objects, immutable envelopes, strong receipts and namespace fencing implemented; isolated NAS file-mechanism tests passed; directory fsync `EPERM` and power-loss durability remain acceptance boundaries |
| Bindings | Controlled role bindings and configuration CAS implemented; shares `resource-cache.json`; legacy directory updates must preserve bindings and share its lock |
| Routes | Archive capabilities, objects, manifests, receipts and PC administration are wired in source; management writes are local-only and require a strong ETag and Idempotency-Key |
| Catalog | Explicit rebuild, replaceable local cache and snapshot-bound cursors implemented; ordinary paging does not scan NAS, and not-ready does not masquerade as empty history |
| Runtime | Manager runtime entry, administration API, lifecycle, catalog and ASR hooks are wired in source; installation/deployment acceptance is pending |
| Jobs | State machine, frozen selection and the actual processing call chain are wired; source integration does not establish real-audio, NAS-failure or recovery acceptance |
| Phone Coordinator / playback core | Android Session, Backend, Service, remote UI and settings panel are wired and covered by the latest full Gradle validation; the remote page always offers the complete local view (including `local_only` and video), eviction candidates are separate, and lazy background PCM reads do not block the writer |

Phone settings select from a computer list only, without model selection. Only newly authorized captures enter the new archive flow; legacy-history migration is not complete. The pending-upload preview shows at most 32 items, not the complete backlog or proof of full migration coverage. The original-eviction gate is hardcoded to `false`; settings must not be interpreted as having enabled cleanup.

Keep evidence separate: the earlier **41 passing module integration tests** exclude subsequent Runtime and other integration work. Later full Manager TypeScript checking and build passed. Independent review after three P1 fixes passed, and the latest full Android Gradle validation includes the settings panel. The complete PC 0.3.15 release build and smoke checks passed, but it has not been deployed. The release package is already frozen; this documentation update belongs to a subsequent package and is not claimed to be included in the current installer. No phone is currently connected, so device and LAN/P2P/Relay acceptance remain pending. Do not add counts from different snapshots or rounds, or count historical recording fixtures as separate tests.

Historical metadata preflight has been performed, but the strong-integrity evidence required for migration is still missing; no migration has occurred. Readable metadata is not proof that audio was verified or archived. The eviction gate remains `false`.

## Safe migration and operational sequence

This is the future acceptance sequence, **not a set of commands that can currently enable the unfinished feature**:

1. Preserve configuration and original audio; produce a read-only migration inventory and verify stable owner, target worker, role binding and namespace.
2. In an isolated test location, verify NAS no-overwrite publication, restart recovery, disconnection and hash corruption. On failure, retain local originals instead of substituting storage and claiming success.
3. Use synthetic audio first to connect upload, receipt lookup, directory and chunked playback; then separately validate LAN, P2P, Relay and disconnect recovery.
4. Test lost ACKs, post-commit crashes, receipt-persistence failures, pinned-reader eviction, deletion-transaction recovery, weak-receipt rejection, unavailable models and uncertain ASR outcomes.
5. Only after updated packages, managed deployment, actual device readback and a rollback build that understands the new states should strong-receipt-controlled phone eviction be enabled in batches.

Legacy global mobile events and weak resource receipts are compatibility reads or migration inputs only. They prove neither NAS archival nor deletion authority and must not remain a second authority for new records. `local_only`, quarantined, incomplete and unattributed history is excluded by default; never guess the currently selected PC as its owner. Preserve originals and old transcripts while checking bytes, hashes and receipts batch by batch. Empty transcription is not a deletion criterion.
