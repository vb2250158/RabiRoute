<!-- docs-language-switch -->
<div align="center">
English | <a href="./manager-runtime-resilience.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Manager runtime resilience and incident evidence

> Status: current guide. It describes the implemented Manager single-instance guard, runtime diagnostics, persona-index persistence, and Windows watchdog.

## Confirmed root cause

Two natural exits on 2026-07-30 had the same stack:

```text
PersonaSyncManifestIndex.persistNow
  -> atomicWriteFileSync
  -> fs.renameSync
  -> EPERM
```

The target was the rebuildable `data/persona-sync/manifest-index.json` cache. A transient Windows or SMB replacement denial escaped a timer callback as an uncaught exception and terminated Manager.

The fix has two layers:

- atomic writes retry transient `EPERM / EACCES / EBUSY / ENOTEMPTY` failures with bounded exponential backoff, exclusive temporary-file creation, `fsync`, and randomized names;
- if those retries are exhausted, persona-index persistence keeps the in-memory index available, records the failure, and retries with a maximum 30-second delay instead of terminating Manager.

`GET /api/persona-sync/index-status` exposes bounded persistence health: consecutive and total failures, last success/failure, next retry, and the last error.

## Interpreting HTTP 502

When `HTTP_PROXY` is set, an ordinary loopback curl may reach the proxy and receive a proxy-generated 502 while port 8790 has no listener. This does not prove that Manager returned 502.

Use a proxy-free probe:

```powershell
curl.exe --noproxy "*" --max-time 6 http://127.0.0.1:8790/meta
```

The Windows launcher, watchdog, and soak probe disable proxy use for their local requests. Relay upstream failures still use 502/504, but include a structured error code, diagnostic request ID, `retryable`, and `Retry-After`.

## Persistent evidence

Manager appends daily JSONL under:

```text
data/.runtime/manager-logs/manager-runtime-YYYY-MM-DD.jsonl
```

It records `process_start`, `startup_failure`, `uncaught_exception`, and `process_exit`, including PID, parent PID, uptime, Node version, platform, and exit code. Project-root paths are replaced with `<projectRoot>`; internal files become relative paths, while external paths retain only the basename.

`GET /meta` exposes the current PID, start time, uptime, Node version, and log shard as `managerRuntime`, without exposing an absolute path.

## Single instance and recovery

Manager acquires `data/.runtime/manager-instance.lock` before loading the control plane. A second live instance exits with code `17`; only a lock whose PID no longer exists can be reclaimed.

The Windows watchdog runs one mutex-protected cycle per minute:

1. probe `/meta` without a proxy;
2. recover through the common launcher and packaged Node runtime, never PATH Node;
3. probe startup health without waiting for the long-lived Manager process tree;
4. back off at 15, 30, 60, 120, 240, and at most 300 seconds;
5. retain unique stdout/stderr logs and daily `manager-recovery-YYYY-MM-DD.jsonl` events;
6. reuse a healthy Manager and the last successful build instead of rebuilding or restarting merely because source timestamps changed.

Task Scheduler Operational events are optional additional evidence when an administrator enables the channel. Task results, watchdog JSONL, launcher logs, and Manager runtime JSONL remain available without it.

## Verification

```powershell
npm.cmd run build
node --import tsx --test `
  src/shared/filePersistence.test.ts `
  src/personaSyncManifestIndex.test.ts `
  src/managerRuntimeDiagnostics.test.ts `
  src/managerInstanceLock.test.ts

curl.exe --noproxy "*" http://127.0.0.1:8790/meta
curl.exe --noproxy "*" http://127.0.0.1:8790/api/persona-sync/index-status

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\Test-RabiRoute-ManagerSoak.ps1 `
  -DurationSeconds 300 -IntervalSeconds 5
```

A soak passes only when every `/meta` sample succeeds and the listening PID remains stable. A temporary restart or one successful request is not a stability acceptance.
