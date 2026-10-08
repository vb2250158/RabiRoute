# PC onboarding prompt

English | [简体中文](rabilink-pc-pairing.md)

Status: experimental integration. One-time enrollment, recovery and revocation passed matching tests and isolated local verification. Servers expose this entry after deploying this version. Access and persistence in each target cloud environment still require acceptance; the platform controls temporary task lifetime.

## Three steps

1. Sign in to the public RabiLink console at `/manage`, select the application, and click **复制接入提示词** (Copy onboarding prompt).
2. Paste the complete prompt into a private Agent task on the target computer. The Agent checks the environment, installs or reuses an independent RabiPC, downloads and verifies the onboarding client, redeems the one-time code, saves private configuration, and starts the connection through the original Host.
3. Refresh the console device list, confirm the computer is online, and verify same-application discovery or an authorized read-only operation.

Ordinary onboarding has one entry: copying the prompt. It already binds the selected application; users do not enter application tokens, select another authentication method, or approve again. Each code expires after thirty minutes and enrolls one computer. The computer generates and retains its long-term credential; Relay receives only its hash.

This follows the interaction of [remote Agent onboarding](lan-rabi-agent-bootstrap_en.md). Authorization owners remain separate: remote Agents enroll as nodes of a local Manager, while RabiPC joins an application on public Relay. They do not share management keys, node identities, or execution runtimes.

Enrollment grants the existing application access contract: the computer can use administrative and knowledge read/write services exposed by devices in the same application. Give the prompt only to the intended computer. Keep the one-time code out of public repositories, group messages, screenshots, and logs. Neither the prompt nor server hashes contain the existing application master token.

## Target Agent procedure

The client requires Node.js 20+, an independent `rabiGuid`, and `data/Config.json` under the instance state root. If no instance exists, the Agent installs and initializes its platform Host first. It must not copy another computer's identity or start a second Manager directly. Linux installation and lifecycle are documented in [Linux Host](linux-host_en.md).

The copied prompt supplies two fixed download URLs, their SHA-256 values, and exact byte sizes at issuance:

- `/api/rabilink/pc-pairings/client/rabilink-pair-pc.mjs`
- `/api/rabilink/pc-pairings/client/rabilink-pc-pairing.mjs`

Download only same-origin HTTPS files from that Relay, reject cross-origin redirects, and verify the prompt's pinned hashes and sizes before execution. These hashes come from the authenticated console and provide content verification, not an independent software signature. The command contains no credential:

```bash
node /absolute/private/install/rabilink-pair-pc.mjs \
  --relay https://relay.example.com \
  --state-root /absolute/private/rabiroute-runtime \
  --name "Cloud PC" --ticket-stdin
```

The Agent supplies the code through child-process standard input. The client accepts no plaintext code argument and rejects interactive terminal input that could echo it. Runtime files must be outside Git or verified ignored and untracked.

Before making a request, the client stores its stable request identity, code, and recovery secrets in the instance's private `data/pc-pairing-request.json`. Relay consumes the code and grants the dedicated credential in one durable write. The client backs up the original configuration, checks concurrent changes, writes and fully reads back `data/Config.json`, preserving other fields. After success it removes the one-time code from the request record. Backups and recovery files can contain credentials; do not send or commit them.

Start or restart through the original Host. Linux example:

```bash
node scripts/linux-host.mjs --command restart \
  --state-root /absolute/private/rabiroute-runtime --json
```

Installation, redemption, configuration persistence, device presence, and real access are separate checks. The Agent reports name, identity, online state, read-only verification, and whether the environment can keep the service running after the task ends.

## Interruption and disconnection

- Repeat the same command after interruption, retaining the original request record. Read the original receipt first; a committed redemption does not create a second identity or grant.
- Copy a fresh prompt when an unused code expires. The new code retains the uncommitted local request. Already connected instances verify existing configuration without enrolling again.
- **断开连接** (Disconnect) revokes that PC's credential and immediately closes its event and Relay tunnel connections. Other PCs remain authorized. Reconnect with a fresh prompt and `--new-request` on the original command. Active grants cannot be duplicated with that flag.
- Disabling, deleting, or rotating an application's master token invalidates its PC credentials and requires a newly issued code.
- Tracked configuration, unignored runtime files, changed identities, or concurrent modifications block overwrite. Before removing a stale `pc-pairing.lock`, confirm the original process has exited.

## Developer contract and compatibility

Console issuance: `POST /manage/api/apps/:appId/pc-pairing-tickets`. The browser creates a random code and submits only a stable UUID and hash. Issuance requires authenticated account ownership, JSON, `x-rabilink-pairing-write: 1`, and same-origin checks. Reuse the UUID and hash to recover the original issuance.

PC redemption: `POST /api/rabilink/pc-pairings`. Send the code only through `Authorization: Bearer`; the body contains device identity and locally generated credential hashes. The grant is bound to the issuing account and application; only an exact original-request retry succeeds. Private proof reads `POST /api/rabilink/pc-pairings/:id/receipt`. Query parameters cannot supply enrollment authority. Revoke with `DELETE /manage/api/apps/:appId/pc-credentials/:id`.

Issuance and redemption use the existing application store, with no background scan or approval wait process. Codes have expiry, capacity limits, and redemption rate limits. Dedicated credentials are bound to device ID and GUID and cannot impersonate another PC. The `rbw_...` credential enters the existing `X-RabiLink-Token` header only inside the process; Relay stores its hash.

Released phone, AIUI, and developer clients retain their application-token protocol. Compatibility operations are isolated at `/manage?integration=1`; the ordinary console has no token or glasses-SN onboarding choices. This change does not migrate those clients. Remove compatibility after their replacements ship and migration is verified.

## Deployment

Use the [Relay deployment procedure](rabilink-relay-server_en.md). Runtime files are listed in `scripts/rabilink-relay-runtime-files.json`. Complete matching tests, the full build, and package-scope checks before obtaining explicit public deployment authorization.

`-RuntimeOnly` updates Relay code while preserving remote WebGUI, OpenAPI, Caddy, accounts, applications, and queues. `-PrepareOnly` prepares the local archive without contacting the server. Deployment restarts Relay, briefly reconnects clients, and requires management users to sign in again. Back up remote runtime code first and use the existing deployment rollback procedure on failure.
