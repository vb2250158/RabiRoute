# Recovering installation-only files

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
