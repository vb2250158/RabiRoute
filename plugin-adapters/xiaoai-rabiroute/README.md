<!-- docs-language-switch -->
<div align="center">
English | <a href="./README_zh.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# XiaoAI RabiRoute adapter

> Status: experimental integration. The PC-side transcript and decision bridge works. Speaker-side interruption, playback, firmware support, and real-device acceptance are not a completed product path.

This directory hosts a low-latency XiaoAI bridge for RabiRoute. It does not flash a speaker and does not implement a full Open-XiaoAI server.

A patched client or compatible server can submit recognized text to the bridge. The bridge forwards every transcript to a RabiRoute Webhook, then returns a narrow local `ignore` or `intercept` decision.

```text
Patched XiaoAI client or compatible server
  -> POST /v1/xiaoai/decision
    -> RabiRoute /webhook
      -> XiaoAI Route policy
        -> Agent delivery through Desktop IPC when matched
```

The included `open-xiaoai-migpt-rabiroute.config.ts` is an integration starting point, not a complete drop-in loop. It currently posts transcripts but does not call the speaker runtime's interruption or playback APIs.

## Run the bridge

Build and start the RabiRoute Manager, then enable the disabled `xiaoai` example Route after checking its port:

```powershell
npm run build
npm run start:manager
```

In another terminal:

```powershell
cd plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
$env:XIAOAI_INTERCEPT_REGEX = "^(问\s*Rabi|让\s*Rabi|Rabi|找\s*Rabi|兔兔|问\s*兔兔)"
npm.cmd start
```

The bridge listens on `127.0.0.1:8798` by default. Override it with `XIAOAI_BRIDGE_HOST` and `XIAOAI_BRIDGE_PORT` only when the network boundary has been reviewed.

## Smoke test

```powershell
cd plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

The smoke test proves that the bridge can return a decision and forward a transcript. It does not prove speaker interruption, TTS playback, or Codex completion.

## API

### `GET /health`

Returns bridge configuration, counters, and the most recent placeholder speak requests.

### `POST /v1/xiaoai/transcript`

Forwards a transcript to RabiRoute as a `voice_transcript` event with XiaoAI source metadata.

### `POST /v1/xiaoai/decision`

Forwards the same transcript and evaluates `XIAOAI_INTERCEPT_REGEX` locally. Non-matches return `action: ignore`; matches return `action: intercept` with a short acknowledgement.

The speaker integration must decide how to map that response to its own `abortXiaoAI()` or equivalent API. RabiRoute does not invoke that speaker-side function.

### `POST /v1/xiaoai/speak`

Accepts a requested reply but currently stores only an in-memory log entry and returns `202`. It is not connected to actual speaker playback and is lost when the bridge restarts.

## Related documents

- [Operational runbook](./RUNBOOK.md)
- [LX06 flashing research checklist](./LX06-FLASH-CHECKLIST.md)
- [XiaoAI integration design](../../docs/xiaoai-integration/xiaoai-rabiroute-intercept-route_en.md)
- [RabiRoute on GitHub](https://github.com/vb2250158/RabiRoute)
