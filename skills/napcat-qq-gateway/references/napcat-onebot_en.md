English | [简体中文](napcat-onebot.md)

# NapCat / OneBot reference

Read the [Rabi delivery workflow](../../rabiroute-message-delivery/SKILL.md) before sending. Direct calls are limited to independent installations not managed by Rabi, or a failure bypass after verifying Rabi is unavailable, the original message did not take effect, and identity and authorization still match. Use managed endpoints while Rabi is available. Authentication failure never authorizes a bypass; reconcile uncertain receipts before considering another send.

## Locations and current connection

Installation paths and entry points depend on the installed version. `<DownloadsRoot>/NapCat.Shell.Windows.OneKey.zip`, `<NapCatRoot>`, `NapCatInstaller.exe`, and `NapCat.<version>.Shell/napcat.bat` are layout hints only: verify existence and version first. Locate account configuration under the current installation, not leftover directories.

Obtain complete WebUI, reverse-WebSocket, and OneBot HTTP URLs and authentication requirements from current configuration or managed status. Do not reuse old ports or scan ports to guess services. Examples use explicitly injected `ONEBOT_BASE_URL`; this is neither automatic discovery nor a new product configuration contract. Discover Rabi Manager through Host/READY and verify `/meta` identity as described in [message queries](message-query_en.md).

## Network and authentication

- Reverse WebSocket sends events to the complete URL configured for the current gateway. Verify message format, authentication, and listener scope against both peers' contracts.
- Do not recommend empty tokens or disabled gateway validation. Use existing protected credentials without logging tokens in command lines or documentation; stop when required credentials are missing.
- `ws://` is plaintext, not proof of safety. Use it only where an existing trusted local configuration permits it. Remote deployments follow their established trusted TLS contract; do not disable certificate verification.
- Keep HTTP listeners within existing authorized addresses and scope. Enabling remote access requires separate authorization; examples do not authorize public exposure.
- A TCP/WebSocket connection proves transport only. Verify online status, account, and target using `get_status` and `get_login_info`.

## OneBot events

Group and private events contain `post_type=message`, `message_type=group|private`, `user_id`, `message_id`, and message content; group events also contain `group_id`. Parse the current schema and preserve account namespaces. Record only fields required by the official retention policy, not complete private conversations merely for diagnostics.

## Request encoding examples

These examples demonstrate UTF-8 for an already authorized independent connection; they do not authorize sending. Verify that `ONEBOT_BASE_URL` is the current trusted endpoint, `ONEBOT_ACCESS_TOKEN` comes from an existing protected source, and `QQ_USER_ID` is the authorized real recipient. Do not print credentials or follow redirects.

```powershell
$base = $env:ONEBOT_BASE_URL.TrimEnd('/')
$json = @{ user_id = [long]$env:QQ_USER_ID; message = "你好" } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri "$base/send_private_msg" -Method Post `
  -Headers @{ Authorization = "Bearer $env:ONEBOT_ACCESS_TOKEN" } `
  -ContentType "application/json; charset=utf-8" -Body $bytes `
  -TimeoutSec 10 -MaximumRedirection 0
```

For groups, use `send_group_msg` and `group_id`, with a currently authorized target rather than a placeholder number. Node `fetch` encodes JSON strings as UTF-8:

```js
const response = await fetch(new URL('/send_private_msg', process.env.ONEBOT_BASE_URL), {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ONEBOT_ACCESS_TOKEN}` },
  body: JSON.stringify({ user_id: Number(process.env.QQ_USER_ID), message: '你好' })
});
// Verify HTTP, status/retcode, and message_id under the current OneBot contract; HTTP 200 alone is insufficient.
```

On timeout, 5xx, disconnect, or an unreadable receipt, preserve request identity and reconcile authoritative state first. Do not resend automatically because text is garbled, a message is not immediately visible, or an example failed. Platform acceptance, formal Rabi recording, and business completion are separate outcomes.

## Troubleshooting sequence

1. Verify current version, listener address, and account through managed status. An unavailable WebUI does not itself authorize restarting Rabi or NapCat.
2. For authentication failure, check protected credential configuration without printing token search results or disabling authentication.
3. If events arrive but the gateway records nothing, check the current reverse-WebSocket URL, format, subscription scope, and managed diagnostics.
4. If receiving works but sending does not, inspect HTTP availability and authentication read-only; `get_status` is not a test send.
5. For garbled Chinese, examine request UTF-8, responses, and platform records. Establish the original outcome before deciding on an authorized correction.
6. Use group filtering supported by the current gateway. Do not invent environment variables or assume all groups are in scope.

## Safety and historical coverage

Never read or store QQ passwords; prefer a dedicated account. Do not reverse-engineer memory keys or bypass QQNT database encryption. History is limited to content actually synchronized for the authorized account or explicitly exported by the user. Report time and coverage; an empty result does not prove there were no messages.
