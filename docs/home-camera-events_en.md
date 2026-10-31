English | [简体中文](home-camera-events.md)

# Camera events and Home Assistant recovery

Status: source implementation and fixture verification. Real UAC, elevated logon-task startup, HAOS recovery and camera-event clips require installed acceptance.

## Startup and privilege

Bootstrap consumes its own `--elevated-task` marker before invoking Host Core. Control commands and other arguments are preserved, and unsupported combinations remain rejected by Core.
A successful status query that reports `stopped` still enters first-start elevation. Only a running or starting Host is reused directly.

The stable Windows `RabiRouteHost.exe` resolves local Host Core through `current.json` and checks the highest-privilege task scoped to this installation and user. A missing task requests UAC once. Approval registers `RabiRoute.Host.Elevated.<installation-and-user-hash>` with a fixed `--elevated-task` Host action, interactive user-logon and on-demand startup. A verified existing task is reused without another UAC prompt. An elevated task-launched Host does not recursively launch itself. Status, self-test and control commands do not request elevation.

Task checks include user SID, installation path, fixed action, highest privilege and interactive logon. Foreign or modified tasks are neither run nor overwritten. Refusal or unavailable task services leaves Host running with limited privileges, reported through `/meta.hostPrivilege`, the HA deployment panel and local `data/runtime/privilege-status.json`. The autostart setting controls the logon trigger without disabling on-demand startup.

Elevation applies to the entire Host: Manager, plugins and children inherit administrator privileges, including existing authenticated Agent operations. Review trusted plugins and remote connections before enabling it. This change does not introduce a second API authorization model.

## Managed HA recovery

`HomeAssistantDeployment` reuses QQ's `NapcatSupervisorService` lifecycle for single activation, isolated failure, cancellation and disposal. Only local deployments with `autoStart=true` are recovered. External services are not taken over, missing system components are not installed automatically, and background recovery never prompts for UAC. Bundled PowerShell runs as the plugin's hidden, cancellable child with inherited Host privileges, not as another resident application or independent HA task. Independent Hyper-V autostart is disabled; Rabi owns startup.

`home-assistant-deployment.json` supports `healthCheckIntervalMs` (default 30000), `recoveryCooldownMs` (default 300000) and `recoveryMaxAttempts` (default 3, range 1–10). These are infrastructure-health checks, not device/business polling. Positive HTTP readiness resets the consecutive recovery budget. Exhaustion leaves observations active but stops VM mutations. Manual Start resets the budget. Unavailable, recovered and exhausted transitions use existing event delivery and audit ports; an unbound persona is never guessed.

Recovery verifies VM ownership through the installation receipt, VM Notes and disk chain. It reads the live network-adapter address and synchronizes loopback-only `8123 → IP:8123`. Receipt-owned incorrect port-80 forwarding is migrated; foreign listeners or mappings are rejected. Core gets a 90-second readiness wait. If it remains unhealthy and the VM was already running, one recovery may gracefully stop/start that VM once, allowing 90 seconds for shutdown and 180 seconds for Core readiness. No forced power-off is used. A newly started VM that is not ready is preserved for a later bounded observation. The address is read again after recovery. An installation receipt or running VM is not proof of Core readiness.

Core startup still depends on a working HAOS Supervisor startup chain. A failed graceful recovery remains an error and consumes the bounded retry budget. SSH is not enabled; Windows PowerShell Direct is not used against Linux HAOS.

Authorization/subscription has a transport deadline. A subscribed event WebSocket sends HA protocol ping every 30 seconds; a missing matching pong causes reconnection. Status exposes last event time, transport error category and delivery state. Failed delivery or missing matching Routes is audited, and failed clip delivery is not mislabeled as failed capture. Agent delivery requires a correctly bound Xiaomi message Route; appending the ledger alone is not delivery success.

## Cameras and persona storage

The existing Xiaomi Home plugin remains the owner. `cameraEvents.ts` defines the common event, adapter and path contracts; `xiaomiMiotCameraAdapter` is the first adapter. RTSP, ONVIF and other brands are not implemented. Events continue through existing Rabi state, situation, intent, decision and action layers; the camera layer does not decide Agent actions.

`settings.json.agentRoleId` must be explicit. Missing binding disables event transport rather than selecting a private persona. The host injects existing `roleDirForApi`, resolving the persona directory from the Manager configuration repository's `rolesRoot`. Clips use:

```text
<persona-directory>/camera/<cameraId>/<YYYY-MM-DD>/<eventId>.mp4
```

Dates use event-time UTC. Unsafe filename characters use reversible percent encoding. Stable event IDs include adapter, camera, occurrence time and event kind, never rotating signed URLs. Storage rejects missing persona roots, junctions and traversal. Exclusive copying supports cross-volume destinations without overwriting existing files. Artifact deduplication includes both persona and sourceEventId. `camera_clip_ready` records retain original `sourceEventId`, `cameraId` and `artifactId`.

Xiaomi capture still requires genuine HA `motion_video_*` attributes, `cameraClipCaptureEnabled=true` and nonempty `cameraClipAllowedHosts`. Populate allowed hosts only from verified real media URLs. No automatic allowlist relaxation or signed-URL disclosure is introduced.

## Installed acceptance and legacy cleanup

1. Schedule activation of a successfully built candidate; source editing does not restart the running Host.
2. Personally confirm the first UAC prompt. Test refusal and visible limited-mode behavior separately.
3. Verify task SID, fixed executable, logon trigger, on-demand start and actual process privileges. A second start must not repeat UAC.
4. Verify Core, live IP, forwarding, event subscription and one bounded failure/recovery, including unavailable/exhausted/recovered reporting.
5. Trigger a real camera event and verify its persona event record, matching eventId clip, artifact digest and playback.
6. Only after acceptance, decide whether to disable/remove the legacy `RabiRoute.HomeAssistantOs.Recovery.<hash>` task and its dedicated ProgramData helper. Export task XML and verify Description, user, action and installation ownership first. Never remove VM, VHDX, HA configuration, credentials or recordings. Preserve old files before acceptance, but do not run old and new recovery owners concurrently.

The elevated Host control pipe grants access only to the account SID so its ordinary CLI can query status and use existing authenticated lifecycle commands. It grants no access to Administrators, Everyone, or other accounts.
