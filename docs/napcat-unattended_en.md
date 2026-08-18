<!-- docs-language-switch -->
<div align="center">
English | <a href="./napcat-unattended.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Unattended NapCat and Login Stability

> Status: current guide. RabiRoute can discover, manage, and launch NapCat instances, while QQ authentication and security verification remain the responsibility of NapCat and QQNT.

RabiRoute receives NapCat/OneBot events, records messages, evaluates routes, and delivers work to a handler. After the Manager starts listening, or when a user clicks **Open NapCat**, it can coordinate local startup, quick-login selection, and OneBot connection repair. It must not store QQ passwords, cookies, or tokens in `data/route`, `data/roles`, examples, or the repository.

## Responsibility split

- NapCat starts QQNT, maintains the QQ login, exposes its WebUI, WebSocket Client, and HTTP Server.
- RabiRoute listens for OneBot events, calls the HTTP API, reports health, and records routing events. With **Auto login when Rabi starts** enabled, it starts the bound instance, selects an existing quick-login account, and repairs OneBot endpoints in the background after the Manager is listening. **Open NapCat** runs the same flow on demand.
- Windows supervision, such as startup at sign-in or service management, keeps NapCat and the RabiRoute Manager alive.

RabiRoute does not type a QQ password or bypass CAPTCHA, device confirmation, or risk-control checks. When human verification is required, the one-click flow opens the authenticated WebUI for the correct instance and waits for the user to finish the step.

## One-click flow in RibiWebGUI

The **Open NapCat** button for a QQ instance follows this order:

1. If the target instance is online with the expected account, open its WebUI without restarting it.
2. If the target is not ready, scan configured and discovered local OneBot HTTP endpoints and use `get_status` plus `get_login_info` to determine whether another NapCat instance already owns that QQ account.
3. If another instance owns the live account, preserve that session and refuse to start or quick-login a duplicate. The UI identifies the live owner and offers an explicit **Use online instance** action.
4. If no other live owner exists and NapCat is stopped, use the instance's `launchCommand` and `workingDir`, then wait for the WebUI.
5. If the WebUI exposes a valid quick-login entry for the bound account, select it and wait for QQ and OneBot. If the saved identity has expired, stop retrying it and request a QR login explicitly.
6. If QQ is logged in but OneBot is not connected, write and apply the instance's HTTP and WebSocket configuration.
7. Hand control to the user only for CAPTCHA, device confirmation, QR login, or a conflict that cannot be resolved safely.

Health scans remain read-only. Login, startup, and configuration repair use the Manager-owned `napcat-ensure-ready` action. Startup auto login runs asynchronously after the Manager begins listening, and Manager readiness does not wait for NapCat checks or authentication.

Start, restart, and stop actions are serialized by the bound QQ account. A double click, two concurrent callers, or mapped-drive and UNC paths that resolve to the same NapCat installation can therefore enter only one lifecycle operation. Immediately before spawning, RabiRoute rechecks the live OneBot login and reuses a ready instance instead of creating a second QQNT/NapCat process tree. This guard protects process lifecycle only; it does not bypass QR login, CAPTCHA, device confirmation, or any other QQ security check.

The UI reports four separate layers: WebUI reachability, QQ authentication, OneBot HTTP health, and the RabiRoute WebSocket connection. A reachable WebUI does not mean QQ is logged in, and a logged-in QQ does not mean messages are reaching RabiRoute.

**Use online instance** only repoints the current QQ card's HTTP endpoint, WebUI endpoint, and working directory to the confirmed live instance. It does not sign QQ out, stop the old process, or silently migrate the login. If that instance is not yet routed to the current gateway, the UI continues to request OneBot WebSocket repair.

## Unattended login

Normally, complete one QR-code login in NapCat WebUI and then rely on NapCat/QQNT quick login. If quick login is unreliable after a reboot, NapCat Shell can read account fallback data from the Windows user environment:

```text
ACCOUNT=<qq-account>
NAPCAT_QUICK_PASSWORD=<qq-password>
NAPCAT_QUICK_PASSWORD_MD5=<password-md5>
```

Prefer `NAPCAT_QUICK_PASSWORD_MD5`. Use the plaintext variable only when the installed NapCat version and deployment explicitly require it. CAPTCHA, device lock, face verification, SMS, and similar checks still require a human in NapCat WebUI.

## Persistent Windows environment variables

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD_MD5 "<password-md5>"
```

If plaintext is unavoidable:

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD "<qq-password>"
```

`setx` affects only processes started afterward. Restart NapCat Shell, its Windows service, or the user session as appropriate. During troubleshooting, report only whether a variable exists and its length; never print the credential.

## Auto login when Rabi starts

Each QQ instance has an **Auto login when Rabi starts** switch, enabled by default. After the Manager begins listening, it queues background work that reuses the correct live account or starts the bound NapCat Shell, selects an existing quick-login identity, and repairs OneBot HTTP/WebSocket configuration. Different accounts or instances run concurrently, while work bound to the same QQ account remains serialized. Manager startup and WebGUI access do not wait for these steps.

Turning the switch off skips startup auto login only. **Open NapCat**, health checks, manual start, and restart remain available. CAPTCHA, QR login, device confirmation, and similar security steps are recorded as requiring user action and can be completed later in the instance WebUI.

## Process supervision

The RabiRoute Manager supervises route subprocesses it starts and reloads affected routes after changes under `data/route/*/adapterConfig.json` or `data/roles/*/personaConfig.json`. NapCat startup auto login runs once per Manager start. Later exits, disconnects, or expired login state remain visible through health status and user actions.

Common NapCat supervision choices:

- Windows Task Scheduler at user sign-in.
- NSSM or WinSW as a Windows service.
- A manually started NapCat Shell with QQNT/NapCat kept open.

If NapCat exits, QQ is signed out, or quick login fails, first use **Open NapCat** for that instance. If recovery fails, inspect NapCat logs, WebSocket state, HTTP `get_login_info`, and the latest Manager diagnostics.

## RabiRoute health check

The NapCat adapter calls OneBot `get_login_info` every 60 seconds by default and writes the result to:

```text
data/route/<configName>/gateway-status.json
```

Change the interval with:

```powershell
setx NAPCAT_LOGIN_REFRESH_SECONDS "30"
```

Zero or a negative value disables this periodic check. The check only detects and reports login problems; it does not log QQ back in.

## Troubleshooting order

1. Open NapCat WebUI and confirm QQ login, WebSocket Client, and HTTP Server.
2. Check NapCat logs for quick-login, QR login, device verification, or clock-skew messages.
3. In RibiWebGUI, verify WebSocket connectivity and the HTTP login profile.
4. If the UI reports that the account is online in another instance, use that live instance instead of starting the same QQ twice. For a real migration, explicitly stop the old instance first.
5. If the saved quick-login identity has expired, choose QR login in the corresponding WebUI rather than repeatedly retrying quick login.
6. If QQ disconnects frequently, synchronize Windows time before restarting NapCat/QQNT.
7. For unattended operation, configure Windows startup and then the NapCat-side `ACCOUNT` and password/MD5 variables.
