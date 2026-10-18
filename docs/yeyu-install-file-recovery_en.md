# Recovering installation-only files

## Installation gate review, 2026-10-19

Baseline: `fe8faba91d748441c01f7f723a1bd7054aeb6b3e`. For each file below, raw and path-filtered `git hash-object` outputs were compared against historical `<commit>:<path>` blobs from `git log --all -- <path>`. None matched, even after Git line-ending normalization.

| File | Raw installed blob | Git-filtered blob |
| --- | --- | --- |
| `src/agentAdapters/yeyuGamerManagerApi.test.ts` | `16cb794eecea4bb8e68eba8c315cc946b468a592` | `16cb794eecea4bb8e68eba8c315cc946b468a592` |
| `src/agentAdapters/yeyuGamerManagerApi.ts` | `986db734db190128033fcf216e1018b2b4532314` | `986db734db190128033fcf216e1018b2b4532314` |
| `scripts/extract-mgq-dialogue-candidates.mjs` | `32206e4ec9bd6560d28daa525083d231400f3442` | `48336386aeded243670d5d10ee96498f06db608d` |
| `scripts/extract-rgss-dialogue-events.mjs` | `12abdcc6968724729ef74d25fd092516441d96b4` | `8a22e706539f8280bb02e8709a19a954296bb013` |

Installed API copies retain the full legacy client and enabled tests; main only re-exports the canonical integrations implementation and verifies identity. Extractor differences are machine-specific default paths; main requires explicit arguments. PR #16 (`88dc43d38a3120f29d5410a93161a63125678670`) generalized these files, but a semantic explanation does not satisfy an exact-blob gate.

Sanitized decision evidence only: no legacy behavior or private defaults restored. Installation remains blocked. No build, install, Host restart, send-format acceptance, or backup deletion was performed. An explicit decision is needed before continuing; this is not deployment acceptance.


English | [简体中文](yeyu-install-file-recovery.md)

This PR recovers manual installation-directory edits only. It does not install, deploy, control Host or Manager, or operate game tools.

## API files

The old `src/agentAdapters/yeyuGamerManagerApi.ts` implementation already moved to `src/integrations/yeyuGamer/managerApi.ts`. The recovered path only re-exports that single implementation for external installation-directory imports that have not migrated. It registers no routes and does not restore the old client enabled flag. Enablement remains owned by the plugin Profile; current request authorization and timeout handling remain unchanged. Remove this compatibility path once all external imports migrate. Repository runtime entry points continue to use integrations directly.

The canonical tests already cover the valid legacy contracts. The recovered-path test checks export identity rather than copying outdated schema and configuration assertions.

## Offline extraction scripts

Use only legally obtained local files. Neither script contacts Manager or starts a game. All paths are explicit; machine-specific defaults from the installation copies were removed.

```powershell
node scripts/extract-mgq-dialogue-candidates.mjs ./translation.json ./reports/candidates
node scripts/extract-rgss-dialogue-events.mjs ./Data ./translation.json ./reports/events
```

The first script extracts Alice / Ilias labels, subsequent windows, and name mentions from a translation dictionary. The second reads event text from already extracted Ruby Marshal 4.8 `.rvdata2` files; it does not unpack games. JSONL output and summaries stay local; do not commit source text or reports.

These research candidates are not reliable complete speaker attribution. The event script recognizes only target labels; other labels and event branches can cause attribution to carry over. Parse failures appear in an error report. Do not directly treat candidates as a production persona or complete corpus.
