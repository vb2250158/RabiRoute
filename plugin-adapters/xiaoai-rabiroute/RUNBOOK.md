<!-- docs-language-switch -->
<div align="center">
English | <a href="./RUNBOOK_zh.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# XiaoAI RabiRoute runbook

> Status: experimental runbook. It covers the repository-owned PC bridge. Open-XiaoAI checkout, speaker firmware, SSH access, and playback hooks remain environment-owned dependencies.

## Supported boundary

```text
Speaker-side client or compatible server
  -> optional WebSocket or SSH tunnel
    -> PC-side Open-XiaoAI-compatible process
      -> http://127.0.0.1:8798/v1/xiaoai/decision
        -> http://127.0.0.1:8791/webhook
          -> RabiRoute XiaoAI Route
```

The repository does not vendor Open-XiaoAI. Obtain and review it separately from the [upstream project](https://github.com/idootop/open-xiaoai).

## Start order

1. Build and start the Manager from the repository root.
2. Enable the disabled `xiaoai` Route after checking port `8791`.
3. Start this bridge on `127.0.0.1:8798`.
4. Start an external Open-XiaoAI-compatible server or client integration.
5. Add an SSH reverse tunnel only if direct connectivity is unavailable.

```powershell
npm run build
npm run start:manager
```

```powershell
cd plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
npm.cmd start
```

If using an external Open-XiaoAI checkout, adapt `open-xiaoai-migpt-rabiroute.config.ts` to that version's API. The checked-in file does not currently perform speaker interruption or reply playback.

## Optional reverse tunnel

Copy `xiaoai-local.config.example.json` to ignored `xiaoai-local.config.json` and fill only local values. Never commit the speaker address or SSH password.

```powershell
py -3 reverse-tunnel.py
```

The common tunnel layout makes a speaker client connect to `ws://127.0.0.1:4399`, which is forwarded to the PC's Open-XiaoAI-compatible server. Confirm the exact direction in `reverse-tunnel.py` and your local JSON before use.

## Checks

Manager and bridge ports:

```powershell
Get-NetTCPConnection -LocalPort 8790,8791,8798,4399 -ErrorAction SilentlyContinue
```

Bridge health:

```powershell
Invoke-RestMethod http://127.0.0.1:8798/health
```

Bridge smoke:

```powershell
cd plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

Then inspect the configured Route's transcript log and Manager status. A successful bridge smoke is not proof that the Desktop task received or completed the prompt.

## Intercept behavior

Every decision request is forwarded to RabiRoute. The local regex only decides whether native XiaoAI should continue.

- Non-match: `{"action":"ignore"}`.
- Match: `{"action":"intercept","speakText":"..."}`.

Keep the regex narrow. Detailed routing belongs in the persona and Route policy. The speaker integration must explicitly implement the actual interruption call.

## Failure isolation

- `/health` unavailable: bridge process or port problem.
- Decision returns `500`: inspect the configured RabiRoute Webhook and Route state.
- Transcript logged but no Agent work: inspect Route rules, Desktop availability, and the loaded target task.
- `intercept` returned but native XiaoAI continues: speaker-side config has not mapped the decision to its abort API.
- `/speak` returns `202` but nothing is heard: expected; playback is still a placeholder.
