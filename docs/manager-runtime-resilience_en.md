<!-- docs-language-switch -->
<div align="center">
English | <a href="./manager-runtime-resilience.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Manager Runtime Resilience and Incident Evidence

Resilience starts with one owner per fact. RabiRoute Host owns the Windows application; Manager owns business state and plugin generations; the tray renders Manager DTOs; plugin processes must hold Manager-issued leases. Retired parallel guardians and tray self-repair are outside the current architecture.

## Two generation layers

| Layer | Identity | Owner | Failure boundary |
| --- | --- | --- | --- |
| Windows application generation | `applicationGenerationId` | RabiRoute Host | An unexpected Manager or tray exit closes the whole Windows Job before a bounded full-generation rebuild |
| Manager plugin generation | Plugin Kernel generation/revision | Manager | A failed candidate is never committed; a replaced graph drains and disposes in reverse dependency order |

The application generation exists before any plugin generation. A plugin cannot start, stop, or replace Host, and application lifecycle must never appear as an ordinary plugin contribution.

## Startup-ready contract

Manager lets the operating system allocate its loopback port. After configuration, Routes, and the Profile are activated, Manager becomes ready only when all Profile `readyRequires` capabilities exist. Under Host, Manager writes one structured READY line to its stdout containing at least:

```text
applicationGenerationId
managerInstanceId
pid
baseUrl
readyAt
```

Host validates generation, PID, Manager instance, and loopback URL before starting the tray. A listening port is not readiness, and a responding old endpoint is not the current generation.

Plan-storage recovery is not part of the application READY gate. Manager may publish READY as soon as its endpoint and identity, complete required-plugin set, and handler READY are established; it does not wait for plan recovery on NAS. A terminable one-shot child establishes plan-storage read/mutation eligibility separately. While that state is `running` or `degraded`, plan mutations fail closed, `/health` reports the degradation, and Host and Tray remain on the current application generation.

The core request layer exposes `/health` without depending on the optional diagnostics plugin. It returns the current `applicationGenerationId`, `managerInstanceId`, and `managerBaseUrl` together with three layered judgments: `live` confirms that the event loop responds, `requiredReady` confirms that the Profile `readyRequires` set is still complete, and `businessReady` reports whether plan-storage eligibility and every enabled Route ingress are ready. Host counts only identity mismatch, `live != true`, or `requiredReady != true` as generation failure. Degraded plan-storage eligibility sets `businessReady=false` without revoking application READY or restarting the generation. Optional-plugin, external-Route, and background-work degradation remains observable without causing a pointless whole-generation restart.

`/meta` reuses the same health snapshot and adds plugin-generation, Route, and background-work diagnostics. Same-generation clients verify that identity. Outside Host, source-mode callers use the URL explicitly printed by Manager.

## Recovery

When Manager or tray exits unexpectedly, Host does not apply a local resurrection patch. It stops the generation Job, releases all children, and starts a new generation with bounded backoff. Reaching the failure limit opens the circuit and preserves logs until an explicit start or restart.

Plugin reload follows prepare → validate → commit inside Manager:

1. parse schema/profile v2 without running entry top-level code in the package loader;
2. prepare candidates in dependency order and validate permissions, services, and `readyRequires`;
3. route new requests to the committed generation;
4. stop old-generation consumers before providers;
5. abort `lifecycle.signal`, then close effects/disposers and process leases;
6. keep the previous committed generation when a candidate fails, leaving no half-active process.

## Process leases

Every long-lived child created by Manager or a plugin must use the shared Process Lease Registry. A lease records its generation, plugin instance, and purpose; plugins may not create ownerless background processes outside the Registry. Generation disposal, plugin removal, and Manager shutdown reclaim their leases, and repeated release is idempotent.

The Windows Job is the final application-generation boundary. Process leases are the internal Manager ownership boundary. They reinforce but do not replace each other.

## HTTP 502 and connection failures

HTTP 502 means an upstream failed for that request; it does not by itself prove Manager exited. Check, in order:

1. whether Host `--command status --json` still reports a current generation;
2. whether `/health` generation, Manager instance, and URL match and both `live` and `requiredReady` are `true`;
3. whether Host, Manager, and plugin/Route logs record a child exit, reload, or upstream error;
4. whether the caller reused a previous generation's URL;
5. whether connection budgets, concurrent reads, file handles, or the remote Relay were exhausted.

Manager makes local service ready first. Relay, remote pages, and nonessential adapters connect in the background, so remote failure cannot block local READY. Large reads, aggregation, and directory walks stay off the core request path, and timeout/AbortSignal must reach real I/O. Plan-feedback recovery discovers candidates from feedback ledgers first, then resolves only those plans through bounded asynchronous reads inside the Manager read worker; it must not return to a synchronous all-plan walk or serial synchronous `getPlan()` calls.

## Evidence locations

```text
%LOCALAPPDATA%\RabiRoute\diagnostics\host\host-YYYYMMDD.log
%LOCALAPPDATA%\RabiRoute\diagnostics\desktop\YYYY-MM-DD\desktop-*\
data/route/<configName>/logs/
```

Host logs prove generation and child transitions; Desktop bundles prove Qt/Python startup and exit; Route and plugin logs prove business handling. None substitutes for another.

## Verification

```powershell
npm test
npm run build
npm run check:config
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-host.ps1 -OutputRoot C:\RabiRouteBuild\host
```

Machine acceptance must additionally cover dynamic-port conflicts, repeated launch, separate Manager/tray crashes, explicit restart, user quit, Host termination, isolated-plugin process reclamation, and absence of retired lifecycle owners. Passing tests proves their contracts, not the complete installed lifecycle.
