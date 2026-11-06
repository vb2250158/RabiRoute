# 插件存档归属与升级

[English](plugin-storage_en.md)

插件源码、公开 schema 和默认配置保存在插件包中。正式运行配置和私有数据由稳定的数据 owner 保存，插件版本不参与存档路径。

```text
stateRoot/data/plugins/<pluginId>/
  <插件共享私有文件>
  instances/<stableInstanceId>/<真正实例独立的文件>
```

公开默认值来自应用 profile；用户实例覆盖仍由 `PluginProfileSettings` 保存。一个生效配置沿一个正式入口读写。路由、人格、请求、回执及投递重放账本继续由原宿主或人格 owner 管理。

| 插件 | 默认存档 |
| --- | --- |
| DSH | 插件目录的 `credentials/`（含本地保护密钥）及 `auth.json` |
| WorkBuddy | 插件目录的 `auth.json`；原生会话和数据库由 WorkBuddy 保存 |
| Bilibili history | 真实实例目录的 `bridge.json`；历史记录仍归对应人格 |
| Xiaomi Home | 插件目录的 `resources.json` 选择运行资源；新安装默认使用该目录的 `runtime/` |

Xiaomi Home 既有 VM、媒体、密钥和账本通过一次正式资源绑定继续使用原目录，不复制或移动 Hyper-V 活盘。`health.storage.runtimeDir` 显示实际目录；用户可配置插件的 `runtimeDir`，或在停用该 owner 后修改正式 `resources.json` 的绝对路径。

0.6 → 0.7 存档布局升级采用完整 Host 切代。原 owner 退出、Manager 实例锁取得、正式环境加载后，在插件装配前执行唯一入口：

```ts
await prepareApplicationPluginStorage({
  phase: "owners-retired",
  layout,
  readOnly
});
```

各插件通过自己的 `storage-migrations.json` 声明旧源与新目标。物理迁移保留私有 raw 备份，校验内容，再原子发布目标并退役原文件。恢复材料位于 `stateRoot/data/.runtime/plugin-storage-backups/0.7/`。中断时沿原 receipt 校验原源、备份及目标后完成原迁移；真实冲突保留各方文件，只报告受影响插件的错误。只读启动不搬迁数据。

旧 Bilibili 共享队列只有在原实例 owner 唯一时才迁入对应实例，不复制 jobs 给多个实例执行。没有旧共享源的新安装允许各实例独立使用新目录。

远端 Agent 在自己的原 owner 退出后，只传入本机的 Agent profile、settings、package roots、layout 和 environment 执行同一入口。部分旧远端版本的默认文件曾受包相对路径影响；升级器取得原 owner 的精确路径元数据时，可提供：

```ts
legacySources: [
  { pluginId, migrationId, sourcePath: absoluteOriginalResourcePath }
]
```

`legacySources` 按插件和迁移项精确选择原资源，优先于仅适合真实共用旧根的 `legacyStateRoot`。升级器不扫描缓存、不选择“最新”目录。旧协议未记录原路径时，应先取得原 owner 的路径记录再采用，不能宣称数据已迁移。显式环境变量和用户自定义路径继续保留。

旧 profile 的包版本仅通过发布的 `package-migrations.json` 中精确的 packageId/fromVersion 声明转换。查询返回 effective migration，不改写原 profile、overlay、实例 ID 或业务存档。

坏行在对应 owner 内隔离，查询明确返回 `partial` 和实际位置诊断；健康记录仍可查询。根文件 JSON、schema 或 I/O 错误保留原文件并提供恢复错误。需要完整证据的批量重放不能把缺失坏行视作完整账本。
