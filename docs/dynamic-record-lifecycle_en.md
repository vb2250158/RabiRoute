English | <a href="./dynamic-record-lifecycle.md">简体中文</a>

# Unified Dynamic Record Lifecycle

## Goal

RabiRoute uses one lifecycle decision framework for conversations, logs, ASR/TTS metadata, plans, and memories without forcing semantically different records through the same action.

The shared contract covers classification, time windows, atomicity, indexes, idempotency, recovery, and acceptance:

- Preserve facts, audit streams, and conversation ledgers through lossless archival.
- Consolidate recent memories into stable knowledge.
- Treat date or size files as physical shards only.
- Expire or delete temporary caches only under an explicit retention policy.

## Default two-window policy

Unless a domain explicitly overrides it:

```text
hotWindowHours = 24
triggerAfterHours = 72
```

An item older than 72 hours triggers an organization pass. That pass selects the eligible range older than 24 hours. Every dataset must declare its activity timestamp; file mtime is not a universal default.

## Current RabiRoute mapping

| Data | Source of truth | Current action | Time semantics |
| --- | --- | --- | --- |
| Persona bidirectional ledger | `data/roles/<RoleId>/conversation/current.jsonl` | Dynamic archival | Once any record exceeds 72 hours, move the maximal contiguous prefix older than 24 hours into sequence archives |
| Ledger history | `conversation/archive/<first>~<last>.jsonl` and `index.json` | Retain | Query by stable sequence; never delete at a calendar boundary |
| Recent memory | `memory/recent/*.json` | Consolidate | Activity is the later of `updatedAt` and `viewedAt`; editable and visible by default for 24 hours |
| Consolidated memory | `memory/consolidated/*.json` | Stable retention | Created by an explicit consolidation run; source memories remain marked with the run |
| Host-wide speech messages | `data/speech/messages/YYYY-MM-DD.jsonl` | Date-sharded audit stream | Calendar files are physical shards, not archival or consolidation |
| Host-wide speech Markdown export | `data/speech/exports/transcript-*.md` | On-demand rebuilt view | Generated from public speech messages for an inclusive/exclusive time range; never a source of truth |
| RabiSpeech diagnostic records | `plugin-adapters/rabi-speech/output/records/YYYY-MM-DD.jsonl` | Date-sharded diagnostics | Separate from persona routing records |
| Persona voice compatibility log | `data/roles/<RoleId>/voice-transcripts.jsonl` | Compatibility/audit | Does not replace the bidirectional ledger |
| Completed plans | `plans/items/active/*.json` | Delayed archival | Move to `plans/archive/` after 72 hours from `updatedAt` |
| TTS audio cache | Persona or RabiSpeech audio cache | Expire | Uses an independent retention policy |

## Archival contract

An ordered ledger must:

1. Order records by a stable sequence.
2. Move only the maximal contiguous complete prefix older than the hot window.
3. Atomically persist the archive, then its index, then replace the current file.
4. Use the sequence range as the idempotent archive identity.
5. Preserve content, stable IDs, order, and total record count.
6. Support cross-shard recovery through the archive index.

## Consolidation contract

Memory organization must:

1. Compute activity as `max(updatedAt, viewedAt)`.
2. Start by default only after an explicit request when at least one recent memory exceeds 72 hours.
3. Include unconsolidated recent memories older than 24 hours.
4. Persist the run, input IDs, and output memories.
5. Retain source memories and mark `consolidatedAt` plus `consolidationRunId`.
6. Never move source memories into an archive or overwrite existing consolidated memories.

Elapsed time alone does not currently schedule consolidation. Automatic scheduling remains future work until implemented and accepted.

## Sharding is not archival

A `YYYY-MM-DD.jsonl` file limits append and query scope. It does not mean the data left active context, moved to an archive, became summarized knowledge, expired, or was deleted.

Host-wide ASR may remain date-sharded while persona Routes copy matching records into their own bidirectional ledgers, which apply dynamic archival independently.

## New-dataset checklist

Declare:

- source of truth, derived copies, and consumers;
- stable ID, ordering field, and activity timestamp;
- archive, consolidate, rotate, expire, or rebuild action;
- default 24/72 windows or explicit overrides;
- trigger owner, destination, index, and recovery path;
- idempotency key, locking, and atomic commit order;
- source retention and separate deletion authorization;
- no-loss, no-duplicate, boundary-time, crash-recovery, and retry tests.

Local Codex execution guidance is available through the `$dynamic-record-lifecycle` skill.
