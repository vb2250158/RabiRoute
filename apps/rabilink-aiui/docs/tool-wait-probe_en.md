English | [简体中文](tool-wait-probe.md)

# Official-model tool-wait interjection probe

This development probe is not a glasses installation or production backend. It builds the actual Rabi Page in a temporary directory and injects an isolated tool adapter. The normal packager never loads it. The official host creates the real `LanguageModel`; shared sessions, decision parsing, input records and queued turns remain production implementations.

## Scope

The initial request discovers tools and calls `/fixture/slow`. Its receipt stays pending while the adapter injects two fixed transcripts through `handleTranscriptionResult`: arithmetic and a `/fixture/next` query. Arithmetic must be answered while waiting; the tool-dependent input must defer. The original receipt is then released, the original turn completes, and the deferred input runs in its own turn.

Checks cover statuses during the wait, global prefixes, independent receipts, exactly one call per endpoint and original completion before the later call. Transcripts, backend results and in-memory records are fixtures. This does not test microphones, speakers, durable storage, real HTTP or backend work.

## Run

```powershell
node scripts/Test-AiuiToolWaitProbe.mjs
node scripts/Build-AiuiToolWaitProbe.mjs C:\Users\<user>\Downloads\candidate-tool-wait-probe.aix
```

The builder requires an absolute path ending in `-tool-wait-probe.aix` and refuses to overwrite existing files. Import via Studio's new-agent AIX menu, select the local draft, run the simulator and wake speech input. Submit:

> 请先查可用接口，再查询 /fixture/slow 的结果；拿到结果后告诉我回执编号。

The two follow-ups are injected automatically. Require `passed:true` in the `ToolWaitProbe result` log rather than relying on HUD text. Hiding the page clears probe timers; unknown outcomes are not successful outcomes.

## November 6 evidence

- SDK 0.7.1 answered arithmetic and completed the original task, but left the second input unconfirmed. Diagnostics identified `defer-text`: an explanation accompanied defer; request/input IDs were not the mismatch.
- SDK 0.7.2 explicitly permits bounded defer explanations and discards their presentation content. The real-model rerun passed the full sequence: answered/deferred while the tool waited, independent correct results and one call per endpoint.
- Passing diagnostic: `rabilink-aiui-1.0.39-defer-fix-tool-wait-probe.aix`, SHA-256 `78e78af89963649fe1cd8d64493bbc7b9e5ac25156a9afe363e50dd5bf273ba4`, 126453 bytes, VERSION `e434a2b0-166b-4481-afb9-ed1535077a7e`. Local Studio import only, not cloud-saved or installed.
- Local evidence: `studio-tool-wait-defer-text-20261106.png`, `studio-tool-wait-passed-20261106.png`. The Web host still lacks `speech.synthesize`; audio, acoustic interruption and device acceptance remain unverified.

Production candidates are separate; select them using [current delivery status](aiui-voice-current_en.md#current-delivery-and-acceptance-status).
