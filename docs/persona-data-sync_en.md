<!-- docs-language-switch -->
<div align="center">
English | <a href="./persona-data-sync.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Multi-PC persona data synchronization

> Status: experimental. The code now provides same-application peer discovery, LAN-first transfer, restricted Relay fallback, manifests, bidirectional merge, archives, conflict evidence, a persona-page control panel, and event-driven automatic reconciliation. Real multi-PC, disconnect, and large-data endurance acceptance is still required.

## Boundary

Each Rabi PC keeps its persona folder as a local file source of truth. RabiLink Relay performs discovery and request transit; it does not own a server-side master persona and does not apply last-writer-wins replacement across PCs.

PCs using the same RabiLink application token form one trusted synchronization group. Remote persona-sync APIs require that token. A local Agent may call the loopback Manager API directly.

## Transport order

1. When Relay is enabled, each PC starts a dedicated LAN persona-sync listener and registers its stable device ID, GUID, capabilities, and listener URL with Relay.
2. `GET /api/persona-sync/peers` lists the other PCs in the same application.
3. The coordinator first tries a peer's advertised LAN URL. The listener uses an OS-assigned port by default and exposes only the `manifest`, `files`, and `merge` data-plane APIs; it does not expose the complete Manager/WebGUI control plane to the LAN.
4. If direct LAN access fails, it uses the restricted Relay `/api/rabilink/persona-sync/proxy`; the target's existing global worker forwards the request to its loopback Manager.
5. Both transports are restricted to persona-sync manifest, file, and merge paths. They cannot proxy arbitrary local URLs.

An active `/api/rabilink/events` SSE connection is direct online-presence evidence and does not require a periodic heartbeat query. A peer remains online while such a connection exists even if `lastSeenAt` is old. If reconnect overlap temporarily creates multiple connections for one PC, it becomes offline only when the last connection closes. Only legacy clients without SSE use bounded recent-request activity as a compatibility fallback.

Relay `ready`, same-application PC availability, and local persona-file events only wake `PersonaSyncAutoReconciler`. It then asks the existing Coordinator to perform one manifest reconciliation, preferring LAN and falling back to Relay; the SSE event itself is never treated as file truth. Unfinished scope is persisted in `data/persona-sync/auto-sync-state.json`, so a disconnect, Relay reconnect, or Manager restart does not lose the fact that catch-up remains required. A temporarily failing online target receives at most three one-shot retries with 1–30 second backoff. An offline target stops retrying and waits for the next peer/Relay event instead of running a fixed business-polling loop.

Stopping Manager immediately invalidates the current automatic-reconciliation lifecycle. Already issued file requests may finish safely, but their stale results cannot clear durable pending work, overwrite the `stopped` state, or schedule another retry after shutdown; the next start still recovers through one full manifest reconciliation. An automated integration regression also takes the target persona node offline, writes a local file, and then uses only the peer-reconnect event to converge real `PersonaSyncService + PersonaSyncCoordinator + LAN listener` instances—the test never calls the synchronization API explicitly.

Relay fallback is request transit, not server-side persona storage. File content passes through Relay during the request. There is no additional end-to-end encryption layer yet, so the application token must only be shared by mutually trusted devices.

## Merge rules

| File | Behavior |
| --- | --- |
| `*.jsonl` | Union by stable record identity or content hash, then order by record time. Different bodies using the same stable ID become a conflict. |
| Ordinary file | Identical files are skipped. A one-sided change relative to the common base fast-forwards. Two-sided changes preserve local content and create conflict evidence. Common baselines are scoped by an application-token hash and the peer's stable device GUID, so they are never reused across RabiLink applications. |
| Exists on one side only | With no common first-sync baseline, treat it as a new file and create it on the other side. After both sides previously shared the same baseline, a missing side becomes a deletion that propagates bidirectionally. |
| Concurrent delete and edit | Never silently delete or resurrect the file. Preserve current local content and create conflict evidence carrying `remoteDeleted`, the peer, and the common-base hash. |
| Locks, temporary files, symlinks | Excluded. |
| `voice/cache/tts-audio/` | Excluded because it is a rebuildable speech cache. |
| Single file over 16 MiB | Rejected by the current implementation. |

The persona-owned voice relationship source `voice/voice-identities.jsonl` also uses append events and tombstones, so JSONL union merge applies naturally. Each identity is scoped by `sourceHostId + voiceprintId`; RabiSpeech/Manager host-diagnostic names never enter this file. New relationship events automatically record the parent heads they converge. Concurrent edits of one identity on two PCs therefore retain multiple heads and expose `conflicted/conflictFields/conflictCandidates` instead of applying last-writer-wins replacement. A later persona update supersedes all current heads with its explicit final interpretation, allowing subsequent synchronization to converge.

Before replacing or deleting a file, the old version is archived under runtime `data/persona-sync/archive/`. Unsafe divergent content or a deletion intent is written under `data/persona-sync/conflicts/` instead of contaminating the active persona folder. A local Agent or user can explicitly keep the local file, adopt the remote result (which confirms deletion for a deletion conflict), or submit merged content. Resolution checks the current local hash to prevent stale overwrites. Original evidence and metadata move to `data/persona-sync/resolved-conflicts/` with a `.resolution.json` audit record.

Concurrent `sync` calls for the same peer/persona in one process share a single flight. Cross-process file merges and peer baseline state use locks plus atomic writes. Merges under `conversation/` reuse the context ledger's own `.message-context.lock`, while files such as `voice-transcripts.jsonl` and `voice/voice-identities.jsonl` reuse their file locks, so synchronization replacement cannot interleave with a live Agent conversation or voice-relationship append. File reads and merges inspect the complete parent chain under the persona directory and reject symbolic links or Windows junctions, preventing the synchronization API from escaping the persona folder.

## Event-maintained manifest index

The persona directory remains the only source of truth. `data/persona-sync/manifest-index.json` is a disposable, rebuildable derived index. After Manager starts, one asynchronous tree reconciliation compares file size, mtime, ctime, and file identity with the previous index. Unchanged entries reuse their SHA-256 value; only new or changed files are read and rehashed. After reconciliation, recursive filesystem events maintain the index. A concrete file event rehashes only that path; only directory events or ambiguous events without a filename trigger one persona-level or full one-shot reconciliation.

`GET /api/persona-sync/manifest` waits for startup reconciliation and then passes through one 50 ms filesystem-event delivery barrier. This lets an edit completed immediately before a sync enter the pending event queue before the in-memory index is read. The one-shot settle reads no business state and does not walk or hash the complete persona tree. Index changes are emitted on Manager `/api/events` as `persona_sync_manifest_changed` and mark only the affected persona as pending; several nearby file events coalesce into one synchronization. If the filesystem, network share, or host cannot provide reliable recursive events, function takes priority: each manifest/sync query performs one reconciliation, with no fixed-interval polling loop. Loopback-only `GET /api/persona-sync/index-status` reports `ready/fallback`, event mode, file count, and rehash counters. `GET /api/persona-sync/auto-status` returns only automatic-reconciliation state, pending counts, and sanitized outcome counts. Neither diagnostic endpoint is exposed by the dedicated LAN listener or Relay proxy.

## Manager API

```text
GET  /api/persona-sync/peers
GET  /api/persona-sync/manifest?roleId=Rabi
GET  /api/persona-sync/index-status
GET  /api/persona-sync/auto-status
GET  /api/persona-sync/files/<roleId>/<relativePath>
POST /api/persona-sync/merge
POST /api/persona-sync/sync
GET  /api/persona-sync/conflicts?roleId=Rabi
GET  /api/persona-sync/conflicts/content?conflictId=<id>
POST /api/persona-sync/conflicts/resolve
```

Synchronize with one PC:

```json
{
  "peerId": "office-pc",
  "roleId": "Rabi"
}
```

Omit `roleId` to synchronize every persona. The response reports `pull`, `push`, `converged`, and `conflict` per file. `fileConflicts` counts file-level failures; `semanticConflicts` reports persona voice-relationship branches that remain after successful JSONL union, and `conflicts` is their combined total. Each semantic item includes persona, processing host, voiceprint ID, conflicting fields, and candidate event IDs, so the initiating Agent receives it in the same response instead of polling afterward. HTTP returns `409` when `conflicts > 0`, and an Agent must not claim completion while conflicts remain.

Conflict inspection and resolution are loopback-only. They are not exposed by the dedicated LAN listener and are not included in the Relay proxy allowlist. After listing conflicts, retain the returned `localHash`, inspect the remote evidence, and submit one resolution action:

```json
{
  "conflictId": "Rabi/persona.md/2026-07-23T01-02-03-000Z-office-pc-abc123",
  "action": "use_remote",
  "expectedLocalHash": "<sha256>"
}
```

`action` is `keep_local`, `use_remote`, or `use_merged`. `use_merged` also requires `contentBase64`. JSONL targets are validated for parseable rows and consistent stable record IDs before commit. If the current local hash has changed, Manager refuses the stale resolution and the Agent must reload the conflict instead of overwriting newer content.

After local resolution succeeds, Manager immediately uses the peer and remote hash captured in the evidence to publish the selected local, remote, merged, or deleted result back to the source PC. LAN remains preferred and Relay is the fallback. The response exposes `publish.status` as `published` or `not_published`. Publication is allowed only while the peer still matches the captured evidence and the local file still matches the just-resolved result. If the peer is offline or either side changed, the local resolution audit remains valid but Manager does not claim convergence. The file change retains a new pending marker, and the next connection/peer event or manual sync compares current versions and recreates evidence when required; no fixed polling loop repeatedly overwrites a conflict.

## WebGUI and automatic recovery

The **Multi-PC persona sync** panel on the persona page can:

- show same-application PCs, online state, LAN/Relay capability, and the local manifest-index mode;
- show whether automatic reconciliation is waiting for Relay, waiting for a peer, queued, syncing, converged, awaiting confirmation, or temporarily failed;
- immediately synchronize the current persona and show pull, push, converged, transport, and conflict counts;
- preview local and remote evidence, then keep local, accept remote, or confirm remote deletion; advanced `use_merged` content remains an Agent/API operation;
- direct persona voice-relationship semantic branches back to **Persona voiceprint classification**, where the persona explicitly converges identity instead of letting synchronization decide who is the user.

Page entry, SSE reconnection, and synchronization-status events each perform only one presentation catch-up query. The backend durable reconciler owns real automatic convergence even when WebGUI is closed; Vue stores no peer, manifest, conflict, or pending-sync fact.

## Built Manager read-only smoke test

Before exercising two physical PCs, verify that the current TypeScript build actually exposes the persona-sync, voice-relationship, and host-speech read boundaries:

```powershell
npm run build:backend
npm run check:built-manager
```

The smoke test uses a temporary loopback port plus `RABIROUTE_MANAGER_READ_ONLY=1`. It does not restart the existing Manager on port 8790 and starts no Gateway, Relay worker, LAN discovery, Route watcher, persona-file watcher, or microphone reconciliation. Child-process stdout readiness events replace status polling. It also reads loopback `index-status` to prove that the built manifest index finished reconciliation; read-only mode does not write the cache. Sanitized evidence is atomically written to Git-ignored `data/acceptance/built-manager-readonly-<timestamp>.json` by default. It stores only build hashes, HTTP statuses, index mode, and counts, never persona names/IDs, file paths/bodies, transcripts, people, tokens, Relay URLs, or ports.

## Local dual-node built-artifact acceptance

Before physical-machine acceptance, run:

```powershell
npm run build:backend
npm run check:persona-sync:dual-node
```

`src/acceptance/personaSyncDualNode.ts` creates two isolated persona roots and starts the real RabiLink Relay child process, a target-PC worker/Manager data plane, and a dedicated LAN listener. The current built `PersonaSyncCoordinator` first has to use LAN and prove JSONL union, one-sided file transfer, concurrent persona-voice relationship branches, explicit semantic convergence, common-base deletion in both directions, ordinary-file conflict evidence, and publication of a chosen resolution over LAN. The second phase changes only the advertised peer URL to an unreachable address while keeping the target worker online. This forces the same Coordinator through the real Relay `/api/rabilink/persona-sync/proxy` for file transfer, conflict creation, and publication of the resolved version back to the target node.

Relay and worker readiness come from stdout/SSE status events. Synchronization remains a one-shot request with no status polling, background schedule, or automatic conflict decision. Tokens, ports, persona IDs, file bodies, and temporary paths exist only inside the isolated fixture and are deleted afterward; sanitized evidence defaults to `data/persona-sync/acceptance/dual-node-<timestamp>.json`. This proves that the current build and real Relay protocol converge in a local dual-node environment, but it does not replace final acceptance with two network interfaces, real firewalls, real disconnects, and two physical PCs.

## Two-physical-PC acceptance tool

First confirm that the running Manager on both PCs includes the current persona-sync API and that both use the same RabiLink application token. Read-only discovery and readiness inspection:

```powershell
node scripts/test-rabi-persona-sync.mjs --inspect
```

`--peer` may be omitted only when exactly one eligible peer exists in the same application. Otherwise provide its peer ID or GUID. Run one persona synchronization, require the real LAN data plane, and explicitly confirm that this run really crossed two distinct physical PCs:

```powershell
node scripts/test-rabi-persona-sync.mjs --peer <PEER_ID> --role Rabi --require-lan --confirm-distinct-physical-hosts
```

Without `--require-lan`, Relay fallback is accepted when LAN access fails. The tool performs one explicit synchronization only: it creates no background schedule, performs no polling, and never resolves conflicts automatically. Evidence is atomically written under Git-ignored `data/persona-sync/acceptance/` by default. It stores only peer counts/selection presence, persona and file counts, synchronization scope, transport, per-direction/status file counts, and conflict-type counts. It omits host names, Manager URLs, peer IDs/GUIDs/names, persona IDs, tokens, Relay/LAN addresses, file paths, bodies, and conflict content.

Exit code `0` means only that the functional one-shot synchronization was conflict-free, or that `--inspect` found the unique/requested eligible peer. Codes `1` through `4` retain the request, peer-selection, conflict, and LAN-required meanings above. The report separates `syncPassed` from `formalAcceptanceEligible`: only a terminally successful sync invoked with `--confirm-distinct-physical-hosts` can become candidate evidence for the physical two-PC aggregate. It still does not replace separate operator observations for disconnects, conflicts, Relay fallback, and endurance.

## Current limitations

- Automatic reconciliation and the WebGUI panel are implemented but remain experimental. Real two-PC disconnects, LAN firewall behavior, Relay fallback, and long-running high-frequency conversation synchronization still require acceptance.
- The dedicated LAN listener uses an ephemeral port by default. Set `RABILINK_PERSONA_SYNC_LAN_PORT` when a fixed firewall rule is required. Relay fallback remains available when no private IPv4 address can be advertised, binding fails, or the LAN path is unreachable.
- A one-sided deletion propagates only for a file with a known common baseline. First-sync absence remains an addition, while concurrent delete-versus-edit requires explicit resolution instead of last-writer-wins replacement.
- Two unrelated versions of an ordinary file have no common first-sync base and conservatively produce a conflict.
- Conversation JSONL is mergeable, while runtime locks, the rebuildable manifest index, and TTS cache files are excluded.
- This remains experimental and does not replace independent backup or Git/SVN source control.
