# XiaoAI RabiRoute Adapter

This folder is the low-latency XiaoAI bridge surface for RabiRoute.

It does not flash the speaker by itself. Flashing must be done against the exact supported XiaoAI speaker model and firmware. This adapter is the PC-side service that a patched XiaoAI client or Open-XiaoAI-style server can call.

## Intended Path

```text
Patched XiaoAI speaker
  -> Open-XiaoAI-style client/server
    -> POST /v1/xiaoai/transcript
      -> RabiRoute /webhook
        -> voice_transcript route
          -> Agent
```

For replies:

```text
Agent / RabiRoute output
  -> POST /v1/xiaoai/speak
    -> Open-XiaoAI playback hook
      -> speaker says the reply
```

The `/speak` endpoint is currently a placeholder queue/log. Wire it to the actual Open-XiaoAI playback command once the speaker-side protocol is chosen.

## Run

```powershell
cd <repo>\plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
npm.cmd start
```

## Smoke

Start RabiRoute with the XiaoAI route/webhook enabled, then:

```powershell
cd <repo>\plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

Expected:

1. This adapter returns `200`.
2. RabiRoute appends a record to `data/route/xiaoai/voice-transcripts.jsonl`.
3. RabiRoute route rules create a Codex notification for the `RabiRoute XiaoAI` thread.

## API

### POST /v1/xiaoai/transcript

```json
{
  "deviceId": "bedroom_xiaoai",
  "deviceName": "卧室小爱",
  "area": "bedroom",
  "sessionId": "xiaoai-session-001",
  "text": "问 Rabi 今天电脑任务跑完了吗",
  "messageId": "xiaoai-001"
}
```

The adapter forwards this to RabiRoute as:

```json
{
  "type": "voice_transcript",
  "source": "xiaoai",
  "sourceDeviceId": "bedroom_xiaoai",
  "sourceDeviceName": "卧室小爱",
  "sourceArea": "bedroom",
  "sessionId": "xiaoai-session-001",
  "text": "问 Rabi 今天电脑任务跑完了吗"
}
```

### POST /v1/xiaoai/speak

```json
{
  "deviceId": "bedroom_xiaoai",
  "text": "Rabi 说，任务还在跑。",
  "interrupt": true,
  "requestId": "xiaoai-001"
}
```

Currently logs/queues the request only.
