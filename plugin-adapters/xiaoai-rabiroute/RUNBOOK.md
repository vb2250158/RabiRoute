# XiaoAI RabiRoute Runbook

## Current Architecture

```text
LX06 open-xiaoai client
  -> ws://127.0.0.1:4399 on speaker
  -> SSH reverse tunnel
  -> PC open-xiaoai server 127.0.0.1:4399
  -> PC bridge http://127.0.0.1:8798/v1/xiaoai/decision
  -> RabiRoute webhook http://127.0.0.1:8791/webhook
```

The reverse tunnel is used when Windows firewall blocks direct inbound traffic from the speaker to the PC `:4399` server.

## Start Order

Start RabiRoute first:

```powershell
cd G:\夜雨\RabiRoute
npm.cmd run start
```

Start the XiaoAI bridge:

```powershell
cd G:\夜雨\RabiRoute\plugin-adapters\xiaoai-rabiroute
npm.cmd start
```

Start the open-xiaoai server:

```powershell
cd G:\夜雨\RabiRoute\plugin-adapters\xiaoai-rabiroute\vendor\open-xiaoai\examples\migpt
$env:RABIROUTE_XIAOAI_BRIDGE_URL = "http://127.0.0.1:8798"
corepack pnpm start
```

Start the reverse tunnel:

```powershell
cd G:\夜雨\RabiRoute\plugin-adapters\xiaoai-rabiroute
py -3 reverse-tunnel.py
```

The tunnel reads private local connection settings from:

```text
G:\夜雨\RabiRoute\plugin-adapters\xiaoai-rabiroute\xiaoai-local.config.json
```

That file is ignored by git. Keep real LAN IPs and the speaker SSH password there. Commit only:

```text
G:\夜雨\RabiRoute\plugin-adapters\xiaoai-rabiroute\xiaoai-local.config.example.json
```

Start the speaker client:

```shell
echo ws://127.0.0.1:4399 > /data/open-xiaoai/server.txt
/data/open-xiaoai/client ws://127.0.0.1:4399 >/tmp/open-xiaoai-client.log 2>&1 &
```

## Check Status

PC ports:

```powershell
Get-NetTCPConnection -LocalPort 8791,8798,4399
```

Bridge health:

```powershell
Invoke-RestMethod http://127.0.0.1:8798/health
```

Speaker:

```shell
ps | grep '/data/open-xiaoai/client' | grep -v grep
netstat -an | grep 4399
tail -50 /tmp/open-xiaoai-client.log
```

## Speaker Autostart

The speaker has `/data/init.sh` installed from the Open-XiaoAI client boot script. On reboot it reads:

```text
/data/open-xiaoai/server.txt
```

Current value:

```text
ws://127.0.0.1:4399
```

This means PC-side startup still needs the reverse tunnel before the speaker client can connect.

## Intercept Behavior

Default first-stage intercept regex:

```text
^(问\s*Rabi|让\s*Rabi|Rabi|找\s*Rabi|兔兔|问\s*兔兔)
```

Non-matching speech is forwarded to RabiRoute for logs/rules and returns:

```json
{ "action": "ignore" }
```

Matching speech returns:

```json
{ "action": "intercept", "speakText": "收到，已经转给 Rabi。" }
```

The open-xiaoai config should only call `abortXiaoAI()` for `intercept`.
