# 插件 Bundle 与热替换

[English](plugin-bundles_en.md) | 简体中文

Manager 的插件真源是 Profile，不是 `manager.json`。每个条目都有稳定 `id`、受信任 Bundle 包名和版本、启用状态与 JSON 配置。`profile.d/*.json` 按文件名顺序应用 `upsert`、`remove` Patch。

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
  rabi.plugin.json
  index.mjs
  client.mjs (可选)
```

首次启动会把旧 `manager.json.managerPlugins` 和旧 `rabi.manager.builtin` Profile 行迁到 `rabi.manager.base` Bundle。迁移完成后不会再读取 `manager.json.managerPlugins`。`manager:core` 仍由 Profile 表示，但不能禁用。

`rabi.plugin.json` 只允许 schema、包 ID、版本、宿主、Manager 入口和可选 Web 入口。不能声明命令、任意路径、URL 或环境变量。Manager 对 Bundle 全部文件计算 SHA-256 revision；Profile、Patch、入口或依赖变化时，文件监听会把新 revision 复制到隔离运行目录，再由 Plugin Reconciler 停止旧 Fiber、撤销路由、排空已接受请求并挂载新 Fiber。新版本激活失败时恢复旧 Fiber。

Manager Bundle 只能通过受控宿主 API 注册 HTTP 路由、跟踪异步操作、发布命名插件事件、读取有限大小 JSON 请求体和返回 JSON。宿主把每个路由固定到当前 `instanceId`，卸载时自动撤销全部路由并等待已接受请求结束。Bundle 不能取得 Manager 全局状态，也不能替换核心路由。

Web Bundle 目录由 `/api/plugins/modules` 发布实例 ID、包 ID、版本和 revision。浏览器以 revision 加载 `/api/plugins/modules/<instanceId>/client.js?rev=<revision>`；收到 `plugin_catalog_changed` 后先执行旧 disposer，再激活新 Bundle。新 Bundle 激活失败时会重新激活上一 revision；旧版也无法恢复时才报告该模块失败。Web Bundle 只能注册受控页面、设置 renderer 和状态 renderer，不能直接改 Manager 内部状态。`webEntry` 是浏览器直接加载的单文件 ESM；发布前必须把依赖打进该文件，当前 HTTP 合同不提供相对导入的依赖文件。

最小可运行 Bundle 在 [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README.md)。
