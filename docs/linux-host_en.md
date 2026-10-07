<!-- docs-language-switch -->
<div align="center">
English | <a href="./linux-host.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Linux Host: source startup and runtime boundaries

> Status: new minimal Linux Host implementation. This page describes the current source contract. A build, local test, or working browser page does not establish real Relay, two-device delivery, or sustained-operation acceptance.

Linux Host owns local Manager startup, current address discovery, restart, and shutdown. The interface is the existing RibiWebGUI. This Linux path does not provide the Windows Host, tray, Qt windows, system screenshots, or global hotkeys. Starting Linux Host does not establish availability of Codex/ChatGPT Desktop, NapCat, speech models, or other handlers; each integration still needs its own host, dependencies, and acceptance.

## 1. Prepare and start

Requirements: Linux, Node.js 20+, npm, and util-linux `flock` at `/usr/bin/flock` or `/bin/flock`. Building needs dependency-source access; dependency installation can run repository and dependency installation scripts. Do not run the everyday instance as root.

From the repository root:

```bash
bash Start-RabiRoute-FromSource.sh
```

Each invocation runs `npm ci` and `npm run build`, then starts Linux Host. It does not install a systemd service, login startup entry, or Windows/Qt desktop. When dependencies and the build are already current:

```bash
npm run start:linux
npm run status:linux -- --json
```

The default is background operation, with the current state, WebGUI address, and log location printed. Open this run's URL; never preserve one port as a permanent address. You can also run:

```bash
node scripts/linux-host.mjs --command open
```

With `DISPLAY` or `WAYLAND_DISPLAY`, `open` invokes `xdg-open`; without a graphical session it only prints the status and URL. On a remote server, `127.0.0.1` refers to that server, so another computer cannot open it directly. Host uses loopback listeners and does not automatically expose a public endpoint.

An ordinary first start creates local runtime configuration and device identity. This is normal local application initialization, not evidence of a Relay connection. To inspect the application without enabling integrations, use the read-only mode below.

## 2. Commands and modes

```bash
node scripts/linux-host.mjs --command start
node scripts/linux-host.mjs --command status --json
node scripts/linux-host.mjs --command open
node scripts/linux-host.mjs --command restart --json
node scripts/linux-host.mjs --command quit --json
npm run stop:linux
```

- `start` is the default. If the same user already has a Host, it returns that Host's status without creating a second instance or changing its options.
- `status` queries a live Host. An unavailable control connection or failed validation exits unsuccessfully; old files and logs never substitute for live status.
- `restart` asks Host to stop the old Manager and create a new application generation. Rediscover the Manager address and both runtime identities afterward.
- `quit` (also accepted as `stop`) requests Host shutdown. “Shutdown accepted” acknowledges the request; process cleanup finishes afterward.
- `--json` emits script-readable status. `--foreground` keeps Host in the foreground for terminal diagnostics or an external service manager.
- `--read-only` blocks Manager configuration writes, automatic integrations, and peer tunnels, and disables Route autostart. A missing tunnel key uses an in-memory identity rather than creating a persistent tunnel key. Host logs, leases, and the control descriptor still require disk writes, so this is not a zero-disk-write mode.
- `--no-autostart` disables Route autostart and the configuration-event watcher while allowing configuration writes. It is not read-only mode or an external-connection isolation mode.
- `--state-root` must be absolute; the default is the repository root. `--package-root` must also be absolute and normally needs no override.

Read-only foreground inspection:

```bash
npm run start:linux -- --foreground --read-only
```

Separate application files from local state:

```bash
npm run start:linux -- --state-root "$HOME/.local/share/rabiroute"
```

Startup options apply only when creating Host. A request for read-only/no-autostart mode or a different package/state root is rejected when it conflicts with the running Host. To change the mode, state root, or running build, quit the existing Host, confirm it has exited, then start again. `restart` retains the current Host options. Different working directories, checkouts, and state roots do not create additional same-user Host slots.

## 3. Current address and health validation

Host consumes the `RABIROUTE_MANAGER_READY:` structured output from the Manager it starts, checks the process, `applicationGenerationId`, and nonempty `managerInstanceId`, then reads `/meta` at that run's `baseUrl`. Normal admission requires matching identities, `health.live=true`, `health.requiredReady=true`, and `health.state` equal to `healthy` or `degraded`. One unconfigured integration need not prevent the console from working.

`status --json` provides `managerBaseUrl`, `applicationGenerationId`, `managerInstanceId`, `hostInstanceId`, runtime state, read-only/autostart options, and the log path. Automation must use the complete `managerBaseUrl` and recheck both `/meta` identities and the needed capabilities before business requests. Rediscover after an identity change; do not replay writes with an unknown outcome. Never scan ports, infer an address from an old lock file, or directly launch or kill a managed Manager.

## 4. Ownership, security, and shutdown

- Host and Linux Manager hold separate kernel file-descriptor leases through util-linux `flock`. When the short-lived utility exits, the parent still holds the locked open-file description; closing it or exiting releases the lease.
- Leases live under the fixed `/tmp/rabiroute-process-leases-<uid>/`, accessible only to that user. The lock inode remains stable. Adjacent owner JSON is diagnostic metadata, not proof of a live process. Do not delete a lock file to “unlock” it or bypass permission checks.
- Where Unix sockets are supported, Manager also reserves the legacy lease to prevent an older build becoming a second writer during migration. Only when the system rejects AF_UNIX and no legacy socket exists may it use the still-mandatory `flock` path alone.
- Host control uses a dynamic local TCP loopback endpoint. Its `0600` control descriptor contains a random per-run control token. Commands require a live connection and Host identity validation; restart/shutdown additionally require the current application generation. Never share, commit, or copy the control descriptor or its token, or use it as a Relay credential.
- `SIGINT`, `SIGTERM`, and `quit` begin normal teardown: request Manager shutdown, send `SIGTERM` to its process group, and escalate to `SIGKILL` after the timeout.
- Losing the Host–Manager Node IPC connection requests normal Manager shutdown. This is not full kernel-enforced descendant containment: forcibly killed, stalled, or process-group-escaping processes require an external supervision boundary.
- For deployments that require complete process-tree cleanup, configure systemd yourself with `--foreground`, explicit absolute paths, and `KillMode=control-group`. This is optional operations setup; the startup script neither installs nor enables it.

After an admitted Manager exits unexpectedly, Host retries with bounded backoff. Five generation failures within 15 minutes enter `faulted`, requiring diagnosis and an explicit `restart`. Initial startup failure also reports `faulted` rather than retrying forever.

## 5. RabiLink: use the existing setup screen

Linux uses the existing WebGUI RabiLink configuration, without a Linux-specific authentication scheme:

1. Open the current WebGUI in normal, writable mode and go to RabiLink configuration.
2. Verify the trusted Relay server address and its operator/purpose. Do not guess an endpoint from logs or an unfamiliar page.
3. Manually supply that Relay application's reusable application token, enable **Connect to server**, and save. Real tokens belong only in local managed configuration, never command examples, public issues, screenshots, or the repository.
4. Check the server connection, target-device availability, actual service readiness, and an explicitly authorized business operation separately. A working page or connected server does not prove the business flow.

Saving persists the configuration and can restore the connection on later normal starts. Before entering credentials, understand the access involved: authenticated devices in the same application can use services actually provided by this computer, including speech, personas, resources, Manager administration, and knowledge reads/writes. Device identity, application isolation, pinned public keys, and service readiness remain checked separately. Read-only mode cannot complete this setup. See [cross-computer connections](rabilink-peer-tunnel_en.md) and [knowledge runtime](rabilink-knowledge-runtime_en.md).

## 6. State, logs, and troubleshooting

- State defaults to the repository root. With a separate state root, `data/` and `logs/` live below that root. Host logs are at `<stateRoot>/logs/linux-host/host.log`.
- The repository ignores runtime directories such as `data/` and `logs/`. Keep a separate state root outside the repository. Check both tracked and untracked files before committing; ignore rules do not untrack existing files.
- State may contain private configuration, identity keys, and business data. Restrict local directory access and sanitize logs before sharing. Do not copy another computer's device identity to set up a new machine.
- Missing `flock`: install your distribution's util-linux package, then retry. Lease/descriptor permission failure: inspect ownership, symlinks, and permissions instead of weakening checks or deleting active locks.
- Missing build: run `npm ci` and `npm run build`. For `faulted` or startup timeout, inspect Host logs, fix the dependency or configuration issue, then restart explicitly.
- Page unavailable: query status again and use the current address, without trying historical ports. If automatic browser opening fails, open that address manually.

Maintainer verification commands:

```bash
npm run test:linux-host
node --test scripts/dynamic-manager-active-truth.test.mjs
npm run build
```

Run and record these against the current changes; this page does not claim they passed. Real Relay connections, cross-device delivery, recovery, target-platform dependencies, and sustained operation still need separate acceptance in the relevant environment.
