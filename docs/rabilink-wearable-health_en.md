<!-- docs-language-switch -->
<div align="center">
English | <a href="./rabilink-wearable-health.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiLink wearable health endpoint

> Status: **experimental integration with a closed real-device primary path**. The timeline, Manager query API, alert route, RibiWebGUI endpoint, Android settings UI, Health Connect source, and PC ADB Companion are implemented. On the tested Xiaomi phone, mobile-owned settings now drive continuous local-Provider heart-rate and sleep ingestion. Xiaomi Health still leaves Health Connect empty on that phone; direct MiWear SPP collection, which would contend with the official app connection, is not the default collector.

## Ownership and flow

RabiRoute owns normalized health history, alert rules, and Agent queries. The RabiLink phone owns device-side settings and collection. A wearable authentication key is encrypted locally with Android Keystore and must never enter Relay, logs, the health timeline, or Agent context.

```text
wearable
  -> phone Health Connect (native mobile source)
     or mobile settings -> RabiRouteHost -> current Manager generation
                           -> Plugin Kernel -> ProcessLeaseRegistry
                              -> PC ADB Companion worker -> Xiaomi Health local Provider
  -> structured wearable.health observation through Relay or trusted local Manager
  -> wearable message endpoint
  -> data/roles/<RoleId>/wearable-health/events/YYYY-MM-DD.jsonl
  -> heart-rate thresholds/cooldown and sleep-state rules
  -> wearable_health_alert -> Agent

Agent / proactive intelligence
  -> local Manager health API
  -> current state, history, and 24-hour summary
```

Ordinary samples do not enter the conversation ledger and do not wake the Agent. Only rule matches become Agent events.

## Enable the endpoint

Add “Wearable health” in the RibiWebGUI Route editor. The equivalent configuration is:

```json
{
  "messageAdapters": ["rolePanel", "rabilink", "wearable"],
  "messageAdapterPolicies": {
    "wearable": {
      "inputEnabled": true,
      "outputEnabled": false,
      "supportedOutputs": ["text"]
    }
  }
}
```

Enable a `wearable_health_alert` persona rule. Runnable examples live in `examples/data/route/RabiLink/adapterConfig.json` and `examples/data/roles/RabiActive/personaConfig.json`.

## Phone settings

Open “Wearable health” and select either Health Connect or “Xiaomi Health (PC ADB Companion)”, then set the stable device ID/name/kind, event-triggered lookback window, high/low heart-rate thresholds, cooldown, and sleep-state alerts. Health Connect is read once after an explicit user/startup/platform event; the phone no longer runs a periodic health query. ADB Companion uses the phone settings as its source of truth and runs as a Host-owned Manager plugin worker on the paired Rabi PC.

An obtained Xiaomi authentication key may be saved in the password field. Android Keystore protects it with AES-GCM; it is reserved for a future direct-vendor collector and is not uploaded. Neither source invents records when its upstream is empty, and the PC Companion never reads the Keystore secret.

## Xiaomi ADB Companion

With USB debugging enabled, the bridge reads Xiaomi Health's latest local Provider heart rate plus the current sleep report and stages, then normalizes heart-rate, session, stage, and provable current sleep-state samples. Production no longer owns a logon scheduled task. `RabiRouteHost.exe` owns the current Manager, and the Manager Plugin Kernel owns the PowerShell worker and its ADB descendants through a generation-scoped `ProcessLeaseRegistry`.

Manager binds `127.0.0.1:0` by default. The worker receives only the current Host READY tuple (`managerBaseUrl`, `applicationGenerationId`, and `managerInstanceId`), verifies `/meta`, and attaches both lifecycle-fencing headers to every Manager request. It never reads a fixed Manager port, scans candidate ports, or accepts `GATEWAY_MANAGER_URL` / `RABIROUTE_MANAGER_URL` bypasses.

The headers are `x-rabiroute-expected-application-generation-id` and `x-rabiroute-expected-manager-instance-id`. Manager returns `503` when it is not part of a Host generation, `400` when either header is missing, and `409` for stale or mismatched identity. Only a matching pair reaches body ingestion and persistence and returns `202`; rejected fence requests create no role directory or health record.

Repository scripts remain only as one-shot diagnostics. A manual Manager check must identify the locally installed Host so `status --json` can return the current dynamic identity:

```powershell
.\apps\rabilink-android\scripts\Sync-MiHealthWearableToRabiLink.ps1 `
  -Execute -Transport Manager `
  -HostExe "<local-install-root>\RabiRouteHost.exe" `
  -UseMobileSettings:$true
```

`Auto` prefers a configured Relay and falls back to trusted local Manager. Manager observations can request the same Agent alert route. The script never prints Relay credentials or reads the wearable key. Real-device checks verified the latest heart rate, a sleep session, nine sleep stages, current sleep state, deduplication, and query APIs. This is not a full-day heart-rate curve and still requires a persistent ADB connection.

`Install-RabiLinkWearableCompanionTask.ps1` is now a fail-closed compatibility diagnostic and never registers, starts, stops, or deletes a task. Setup transactionally backs up and removes the retired `RabiLinkWearableHealthCompanion` only when its SID, description, old NAS runner, and fixed-Manager arguments match the exact product fingerprint. A foreign same-name task blocks installation before any mutation; a later installation failure restores the backed-up XML and running state.

If the phone has not enabled ADB Companion or ADB is temporarily unavailable, the same worker records `degraded` and retries no faster than once per 60 seconds; it does not create a restart storm. A genuine worker crash gets three bounded exponential-backoff restarts inside the same generation before the plugin fails. Sanitized state and logs live under local runtime `data/wearable-companion/` and `logs/wearable-companion/`, never inside the immutable plugin package or on NAS.

A child-process `error` event is not proof of exit. Until a real `exit` / `close` event or exit code exists, the process lease retains the global worker key and a replacement plugin generation cannot start another worker. A failed stop keeps the old lease, allows the same handle to retry, and makes handoff fail closed; an asynchronous pidless spawn error is observed by the lease layer and enters bounded retry instead of becoming an unhandled event that terminates Manager.

Threshold alerts use a dedicated `wearable` route to reach the Agent without starting unrelated QQ or FenneNote adapters. Inspect first, then configure explicitly:

```powershell
node scripts/configure-wearable-health-route.mjs
node scripts/configure-wearable-health-route.mjs --execute
```

The script copies only non-secret Agent-binding fields from the existing Night Rain route and backs up the private persona rules and any existing health route under ignored `data/` storage before writing.

## Agent API

Keep Manager on a trusted local interface:

```text
GET   /api/roles/:roleId/health
GET   /api/roles/:roleId/health/state
GET   /api/roles/:roleId/health/history
GET   /api/roles/:roleId/health/summary
GET   /api/roles/:roleId/health/config
PATCH /api/roles/:roleId/health/config
POST  /api/roles/:roleId/health/observations[?deliverAlerts=true]
```

History filters are `metric`, `from`, `to`, `sourceDeviceId`, `limit`, and `order=asc|desc`. `state` exposes the current sleep inference and staleness. An Agent must not treat stale heart rate, `unknown` sleep, or a historical sleep session as a live medical conclusion.

A direct Manager observation POST persists data and returns rule results. With explicit `deliverAlerts=true`, matching rules also become `wearable_health_alert` deliveries targeted at the role in the URL. Relay + `wearable` keeps the same behavior.

## Privacy and acceptance

Events are daily JSONL files under the role directory. Sensitive metadata names such as auth, token, secret, key, password, and cookie are dropped. Stable sample IDs/content fingerprints deduplicate retries; alerts use per-device rule cooldowns. There is no automatic retention policy yet, so exposing Manager, backing up role data, or deleting health history requires an explicit privacy decision.

Real-device acceptance requires matching Host/Manager/worker generation identity, a dynamic URL equal to `/meta`, rejection of stale fencing headers, a Manager-owned worker lease with zero residue after unload, zero retired scheduled tasks, a genuine sample, a structured Relay or Manager receipt, a deduplicated role event, working state/history queries, one alert inside a cooldown window, successful Agent delivery, and proof that neither wearable keys nor Relay tokens appear in logs or health files.
