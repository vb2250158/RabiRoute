# LX06 Low-Latency Flashing Checklist

Target device: Xiaomi XiaoAI Speaker Pro, model `xiaomi.wifispeaker.lx06`.

This checklist follows the vendored Open-XiaoAI docs in:

```text
plugin-adapters/xiaoai-rabiroute/vendor/open-xiaoai/docs/flash.md
plugin-adapters/xiaoai-rabiroute/vendor/open-xiaoai/packages/client-rust/README.md
plugin-adapters/xiaoai-rabiroute/vendor/open-xiaoai/examples/migpt/README.md
```

## Safety Boundary

Flashing can void warranty or brick the device. Do not continue unless you accept that risk.

Do not share:

- SN
- MAC
- QR codes
- Wi-Fi password
- SSH password
- Xiaomi account credentials

You may share:

- speaker LAN IP, for example `192.168.1.123`
- whether `identify` succeeds
- non-secret error text

## Phase 0: PC-Side RabiRoute Prep

Already prepared:

```text
plugin-adapters/xiaoai-rabiroute/index.mjs
plugin-adapters/xiaoai-rabiroute/smoke-send.mjs
examples/data/route/xiaoai/routeConfig.json
docs/xiaoai-integration/xiaoai-roleMessageConfig-snippet.json
```

Start the RabiRoute XiaoAI bridge:

```powershell
cd <repo>\plugin-adapters\xiaoai-rabiroute
$env:RABIROUTE_WEBHOOK_URL = "http://127.0.0.1:8791/webhook"
npm.cmd start
```

Current low-latency bridge endpoint:

```text
http://127.0.0.1:8798/v1/xiaoai/decision
```

This endpoint forwards all transcripts to RabiRoute, but only returns `intercept` when the local first-stage rule matches. Native XiaoAI should continue for `ignore`.

Smoke test:

```powershell
cd <repo>\plugin-adapters\xiaoai-rabiroute
npm.cmd run smoke
```

## Phase 1: Prepare Flashing Tool

Open-XiaoAI docs require:

1. A data-capable USB cable, not charge-only.
2. Amlogic Flash Tool v6.0.0.
3. A patched firmware file named `root_patched.squashfs`.

Official doc points to:

```text
https://androidmtk.com/download-amlogic-flash-tool
```

Extract the tool to Desktop and rename the folder:

```text
Amlogic_Flash_Tool_v6.0.0
```

Install driver:

```text
AMLLogic driver installer.exe
```

## Phase 2: Connect LX06

LX06 older XiaoAI Speaker Pro usually uses an internal Micro USB debug port and may require opening the shell.

Open-XiaoAI doc says:

1. Remove speaker shell.
2. Find the Micro USB debug port on the upper-left part of the mainboard.
3. Connect it to the Windows PC with a data-capable Micro USB cable.

Do not proceed if the cable is charge-only or the port is not recognized.

## Phase 3: Identify Device

Open Git Bash in the flash tool `bin` directory.

Unplug speaker power. Replug power. Immediately run:

```shell
./update.exe identify
```

Expected success looks like:

```text
This firmware version is 0-7-0-16-0-0-0-0
```

If it does not show a firmware version:

1. Power-cycle speaker.
2. Retry quickly after power-on.
3. Check USB cable and driver.
4. Do not run partition flashing commands yet.

## Phase 4: Set Boot Partition

Only after `identify` succeeds:

```shell
./update.exe bulkcmd "setenv bootdelay 15"
./update.exe bulkcmd "setenv boot_part boot0"
./update.exe bulkcmd "saveenv"
```

## Phase 5: Flash Patched System

Put `root_patched.squashfs` where the flash command can access it.

```shell
./update.exe partition system0 root_patched.squashfs
```

If the patched file is elsewhere, use the actual path:

```shell
./update.exe partition system0 /path/to/root_patched.squashfs
```

After success:

1. Unplug USB.
2. Unplug power.
3. Replug power.
4. Wait for boot.

## Phase 6: SSH

After patched firmware boots, find the speaker LAN IP in router/Mi Home.

SSH:

```shell
ssh -o HostKeyAlgorithms=+ssh-rsa root@SPEAKER_IP
```

Open-XiaoAI default SSH password:

```text
open-xiaoai
```

Do not paste the password into chat.

## Phase 7: Install Open-XiaoAI Client

After SSH succeeds:

```shell
mkdir /data/open-xiaoai
echo 'ws://PC_LAN_IP:4399' > /data/open-xiaoai/server.txt
curl -sSfL https://gitee.com/idootop/artifacts/releases/download/open-xiaoai-client/init.sh | sh
```

Replace `PC_LAN_IP` with the Windows PC IP address.

For autostart:

```shell
curl -L -o /data/init.sh https://gitee.com/idootop/artifacts/releases/download/open-xiaoai-client/boot.sh
reboot
```

Current LX06 status after setup:

```text
Speaker IP: stored locally in xiaoai-local.config.json
PC LAN IP: stored locally in xiaoai-local.config.json or tunnel runtime
Client path: /data/open-xiaoai/client
Configured server: ws://127.0.0.1:4399
Autostart script: /data/init.sh installed
```

The configured server uses an SSH reverse tunnel when Windows firewall blocks direct speaker -> PC access to `PC_LAN_IP:4399`.

Private local tunnel settings live in:

```text
plugin-adapters/xiaoai-rabiroute/xiaoai-local.config.json
```

That file is ignored by git. Commit only the placeholder example JSON.

PC-side tunnel:

```powershell
cd <repo>\plugin-adapters\xiaoai-rabiroute
py -3 reverse-tunnel.py
```

Speaker-side manual client start:

```shell
echo ws://127.0.0.1:4399 > /data/open-xiaoai/server.txt
/data/open-xiaoai/client ws://127.0.0.1:4399 >/tmp/open-xiaoai-client.log 2>&1 &
```

## Phase 8: Server Choice

Open-XiaoAI examples use a WebSocket server on port `4399`.

For RabiRoute integration, use one of two approaches:

1. Fast experiment: run Open-XiaoAI MiGPT example server, then modify its `onMessage` to call RabiRoute.
2. Cleaner route: implement a minimal Open-XiaoAI-compatible server that forwards transcript events to `plugin-adapters/xiaoai-rabiroute`.

The current bridge endpoint is:

```text
http://127.0.0.1:8798/v1/xiaoai/decision
```

RabiRoute receives:

```text
http://127.0.0.1:8791/webhook
```

## Recovery

To boot the original system:

```shell
fw_env -s boot_part boot1
```

Or via flashing tool:

```shell
./update.exe bulkcmd "setenv boot_part boot1"
./update.exe bulkcmd "saveenv"
```
