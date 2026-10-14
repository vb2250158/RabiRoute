<!-- docs-language-switch -->
<div align="center">
English | <a href="./napcat-linux.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# NapCat (QQ) on Linux

Windows behavior is unchanged (OneKey / `napcat.bat` / `NapCatWinBootMain.exe`). Linux supports two modes:

## Mode A: connect to an external NapCat (recommended, incl. Docker)

NapCat runs under Docker, systemd, or another host; RabiRoute only connects. Leave **`launchCommand` empty** and configure addresses and token:

```json
{
  "id": "qq-bot",
  "gatewayPort": 8789,
  "httpUrl": "http://127.0.0.1:3000",
  "webuiUrl": "http://127.0.0.1:6099/webui",
  "accessToken": "<token matching NapCat network config>",
  "botUserId": "<bot QQ number>"
}
```

1. Copy [`examples/linux/napcat-docker-compose.yml`](../examples/linux/napcat-docker-compose.yml), adjust UID/GID, run `docker compose up -d`.
2. Open the WebUI (default `http://127.0.0.1:6099/webui`; the initial WebUI token is in `docker compose logs napcat`) and scan the QR code.
3. In NapCat network settings:
   - enable an **HTTP Server** on port 3000 with a token;
   - add a **WebSocket Client** to `ws://host.docker.internal:<gatewayPort>` (`ws://127.0.0.1:<gatewayPort>` with host networking), same token.
4. Put `httpUrl` / `webuiUrl` / `accessToken` into RabiRoute. A non-loopback address without a token triggers a warning.

## Mode B: local Linux QQ + NapCat.Shell

After NapCat's official Linux installer, QQ lives at `/opt/QQ/qq` or `~/Napcat/opt/QQ/qq` and NapCat at `<QQ root>/resources/app/app_launcher/napcat`. Instance config:

- `launchCommand`: QQ binary, e.g. `/opt/QQ/qq`
- `workingDir`: QQ root, e.g. `/opt/QQ` (used to locate `resources/app/app_launcher/napcat/config`)
- `botUserId`: bot QQ number

On launch RabiRoute:

- adds `--no-sandbox`, and `-q <uin>` quick login when `botUserId` is set;
- wraps with `xvfb-run -a` when there is no display (`DISPLAY` / `WAYLAND_DISPLAY`); warns if `xvfb-run` is missing;
- detects processes via `/proc` (QQ and processes whose command line mentions napcat).

Non-`qq` launch commands (custom scripts) run unchanged.

## Limitations

- Linux does not download/extract NapCat templates; install via the official script or Docker first.
- First login requires a manual QR scan; RabiRoute never logs in to QQ for you.
- Local launch depends on Linux QQ and xvfb; verify on a real machine.
