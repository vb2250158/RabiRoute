<!-- docs-language-switch -->
<div align="center">
English | <a href="./napcat-unattended.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Unattended NapCat and Login Stability

> Status: current guide. RabiRoute can discover, manage, and launch NapCat instances, while QQ authentication and security verification remain the responsibility of NapCat and QQNT.

RabiRoute receives NapCat/OneBot events, records messages, evaluates routes, and delivers work to a handler. After the Manager starts listening, or when a user clicks **Start and manage login**, it can coordinate local startup, all three QQ login modes, and OneBot connection repair. QQNT and NapCat still define authentication and security-verification semantics; Rabi only proxies the current local operation. QQ passwords, cookies, and tokens must not be written to `data/route`, `data/roles`, examples, or the repository.

## Responsibility split

- NapCat starts QQNT, maintains the QQ login, and exposes local login, WebSocket Client, and HTTP Server APIs.
- RabiRoute listens for OneBot events, calls the HTTP API, reports health, and records routing events. With **Auto login when Rabi starts** enabled, it starts the bound instance, selects an existing quick-login account, and repairs OneBot endpoints in the background after the Manager is listening. **Start and manage login** enters the same flow from the current Route card.
- Windows supervision, such as startup at sign-in or service management, keeps NapCat and the RabiRoute Manager alive.

For password login, plaintext exists only in the current browser form and one Manager request. Manager immediately hashes it with MD5 for NapCat and never writes the plaintext or hash to Route configuration, logs, or the response. RabiRoute does not bypass CAPTCHA, new-device confirmation, or risk-control checks: the user still completes Tencent CAPTCHA and mobile-QQ confirmation, after which the card resumes health checks.

## NapCat login and management inside the Route card

One Route binds one NapCat; another QQ account belongs in another Route. **Start and manage login** follows this sequence without opening or embedding the NapCat WebUI:

1. If the target instance is online with the expected account, reuse the live session without restarting QQNT/NapCat.
2. If the target is not ready, scan configured and discovered local OneBot HTTP endpoints and use `get_status` plus `get_login_info` to determine whether another NapCat instance already owns that QQ account.
3. If another instance owns the live account, preserve that session and refuse to start or quick-login a duplicate. The UI identifies the live owner and offers an explicit **Use online instance** action.
4. If no other live owner exists and NapCat is stopped, launch it hidden with the instance's `launchCommand` and `workingDir`, then wait for the local management API.
5. The card obtains login state and QR content through Manager and exposes exactly three first-class modes: Quick login, Password login, and QR login.
6. Quick login lists only identities already saved by NapCat. Password login keeps Tencent CAPTCHA and new-device QR confirmation in the card. QR login renders NapCat's QR content as a local image.
7. Once QQ is logged in, Rabi writes and applies the instance's OneBot HTTP/WebSocket configuration and rechecks both OneBot and the RabiRoute WebSocket.

The browser calls only `/api/message/napcat-login-panel` and `/api/message/napcat-login-action`. The WebUI token and authenticated Credential remain inside Manager, and login responses use `Cache-Control: no-store`. The Route card does not own a NapCat management session or preserve the WebUI as a second control plane.

Health scans remain read-only. Login, startup, and configuration repair use the Manager-owned `napcat-ensure-ready` action. Startup auto login runs asynchronously after the Manager begins listening, and Manager readiness does not wait for NapCat checks or authentication.

Start, restart, and stop actions are serialized by the bound QQ account. A double click, two concurrent callers, or mapped-drive and UNC paths that resolve to the same NapCat installation can therefore enter only one lifecycle operation. Immediately before spawning, RabiRoute rechecks the live OneBot login and reuses a ready instance instead of creating a second QQNT/NapCat process tree. This guard protects process lifecycle only; it does not bypass QR login, CAPTCHA, device confirmation, or any other QQ security check.

The UI reports four separate layers: NapCat management reachability, QQ authentication, OneBot HTTP health, and the RabiRoute WebSocket connection. A reachable management API does not mean QQ is logged in, and a logged-in QQ does not mean messages are reaching RabiRoute.

**Use online instance** only repoints the current QQ card's HTTP endpoint, WebUI endpoint, and working directory to the confirmed live instance. It does not sign QQ out, stop the old process, or silently migrate the login. If that instance is not yet routed to the current gateway, the UI continues to request OneBot WebSocket repair.

## Unattended login

Normally, complete one QR-code login in the Rabi NapCat card and then rely on NapCat/QQNT quick login. If quick login is unreliable after a reboot, NapCat Shell can read account fallback data from the Windows user environment:

```text
ACCOUNT=<qq-account>
NAPCAT_QUICK_PASSWORD=<qq-password>
NAPCAT_QUICK_PASSWORD_MD5=<password-md5>
```

Prefer `NAPCAT_QUICK_PASSWORD_MD5`. Use the plaintext variable only when the installed NapCat version and deployment explicitly require it. The Rabi card handles CAPTCHA and new-device QR confirmation exposed by the current NapCat API. Face verification, SMS, or a future unsupported check remains an explicit human stop; Rabi does not bypass it.

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

The NapCat bound to each Route has an **Auto login when Rabi starts** switch, enabled by default. After the Manager begins listening, it queues background work that reuses the correct live account or starts the bound NapCat Shell, selects an existing quick-login identity, and repairs OneBot HTTP/WebSocket configuration. Different Routes run concurrently, while work bound to the same QQ account remains serialized. Manager startup and WebGUI access do not wait for these steps.

Turning the switch off skips startup auto login only. **Start and manage login**, health checks, manual start, and restart remain available. CAPTCHA, QR login, and new-device confirmation are recorded as requiring user action and can be completed later in the same Route card.

## Process supervision

The RabiRoute Manager supervises route subprocesses it starts and reloads affected routes after changes under `data/route/*/adapterConfig.json` or `data/roles/*/personaConfig.json`. NapCat startup auto login runs once per Manager start. Later exits, disconnects, or expired login state remain visible through health status and user actions.

Common NapCat supervision choices:

- Windows Task Scheduler at user sign-in.
- NSSM or WinSW as a Windows service.
- A manually started NapCat Shell with QQNT/NapCat kept open.

If NapCat exits, QQ is signed out, or quick login fails, first use **Start and manage login** in the corresponding Route. If recovery fails, inspect NapCat logs, WebSocket state, HTTP `get_login_info`, and the latest Manager diagnostics.

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

1. Refresh login state in the current Route's NapCat card and check QQ, OneBot HTTP, and RabiRoute WebSocket separately.
2. Check NapCat logs for quick-login, QR login, device verification, or clock-skew messages.
3. In RibiWebGUI, verify WebSocket connectivity and the HTTP login profile.
4. If the UI reports that the account is online in another instance, use that live instance instead of starting the same QQ twice. For a real migration, explicitly stop the old instance first.
5. If the saved quick-login identity has expired, switch the card to **QR login** and refresh the code rather than repeatedly retrying quick login.
6. If QQ disconnects frequently, synchronize Windows time before restarting NapCat/QQNT.
7. For unattended operation, configure Windows startup and then the NapCat-side `ACCOUNT` and password/MD5 variables.
