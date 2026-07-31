<!-- docs-language-switch -->
<div align="center">
<a href="./manager-runtime-resilience_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Manager 运行稳定性与故障证据

> 状态：现行指南。对应 Manager 单实例、运行诊断、人格索引持久化和 Windows watchdog 的当前实现。

## 事故根因

2026-07-30 的两次自然退出具有相同栈：

```text
PersonaSyncManifestIndex.persistNow
  -> atomicWriteFileSync
  -> fs.renameSync
  -> EPERM
```

目标是 `data/persona-sync/manifest-index.json`。这个文件是可删除、可重建的派生索引，但旧实现从 `setTimeout` 回调直接执行一次 `renameSync`；Windows 或 SMB 短暂拒绝替换时，异常逃出定时器并成为未捕获异常，Manager 随即退出。

修复分成两层：

- 通用原子写入对 `EPERM / EACCES / EBUSY / ENOTEMPTY` 做有限指数退避；临时文件使用独占创建、`fsync` 和随机名称。
- 人格索引即使在通用重试耗尽后也不让派生缓存写入终止 Manager；它保留内存索引、记录失败状态，并按上限 30 秒的指数退避再次持久化。

`GET /api/persona-sync/index-status` 的 `persistence` 字段可查看连续失败数、累计失败数、最近成功/失败、下次重试和最后错误。

## 502 的判定边界

本机设置 `HTTP_PROXY` 时，普通 `curl http://127.0.0.1:8790/meta` 可能把回环请求发给代理，并在 8790 没有监听时得到代理生成的 502。它不能单独证明 Manager 自己返回了 502。

直接诊断必须绕过代理：

```powershell
curl.exe --noproxy "*" --max-time 6 http://127.0.0.1:8790/meta
```

Windows 启动器、watchdog 和浸泡脚本都显式禁用自身进程的 Web 代理，并为回环地址设置 `NO_PROXY`。Relay 上游故障仍返回 502/504，但响应包含结构化错误码、诊断请求 ID、`retryable` 与 `Retry-After`，用于和本机代理 502 区分。

## 持久运行证据

Manager 在以下目录按 UTC 日期追加 JSONL：

```text
data/.runtime/manager-logs/manager-runtime-YYYY-MM-DD.jsonl
```

记录包括：

- `process_start`
- `startup_failure`
- `uncaught_exception`
- `process_exit`

每条记录含 PID、父 PID、运行时间、Node 版本、平台和退出码。项目根路径会替换为 `<projectRoot>`；项目内错误路径保存为相对路径，外部路径只保留文件名。诊断写入失败不会改变原始崩溃语义。

`GET /meta` 的 `managerRuntime` 提供当前 PID、启动时间、运行秒数、Node 版本和日志分片，不暴露本机绝对路径。

## 单实例与自动恢复

Manager 在加载控制面之前独占：

```text
data/.runtime/manager-instance.lock
```

活实例存在时，后到实例以退出码 `17` 结束；只有锁中 PID 已不存在时才回收陈旧锁。

Windows watchdog 每分钟执行一个有互斥保护的单轮检查。恢复行为：

1. 无代理直连 `/meta`。
2. 通过同一个 Windows 启动器和本机打包 Node 启动，不回退到 PATH Node。
3. 启动后主动探测健康，不使用 `Start-Process -Wait` 等待长期 Manager 子进程。
4. 失败后按 15、30、60、120、240、300 秒上限退避。
5. 每次恢复使用唯一 stdout/stderr 文件，并在按日 `manager-recovery-YYYY-MM-DD.jsonl` 中记录开始、成功、失败或退避跳过。
6. 自动恢复复用健康 Manager，也允许在源码比最后一次成功构建新时使用现有 `dist`；watchdog 不负责构建或以构建时间触发计划外重启。

计划任务可用 `scripts/Install-RabiRoute-HealthWatchdogTask.ps1` 安装。Task Scheduler Operational 通道若由管理员启用，可提供额外系统事件；即使该通道关闭，任务结果、watchdog JSONL、launcher 日志和 Manager runtime JSONL 仍构成完整的应用侧时间线。

## 验证命令

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

Get-ScheduledTask -TaskName RabiRouteHealthWatchdog
Get-ScheduledTaskInfo -TaskName RabiRouteHealthWatchdog
```

浸泡通过条件是所有 `/meta` 样本成功且监听 PID 不变化。不要把一次临时重启或单次 200 响应视为稳定性验收。
