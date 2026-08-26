# 插件 Bundle 与热替换

[English](plugin-bundles_en.md) | 简体中文

Manager 的插件真源是 Profile，不是 `manager.json`。每个条目都有稳定 `id`、受信任 Bundle 包名和版本、启用状态与 JSON 配置。`profile.d/*.json` 按文件名顺序应用 `upsert`、`remove` Patch。

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
  rabi.plugin.json
  index.mjs
  web/client.mjs (可选，及同目录的浏览器依赖)
```

Profile 缺失时，首轮装载使用 `rabi.manager.base/rabi.manager.profile.json` 并合并旧 `manager.json.managerPlugins` enabled 值；listener 就绪后异步写入 Profile 并删除旧键。已存在的 Profile 不再读取旧键。旧 `rabi.manager.builtin` Profile 或 Patch 行在同一次初始化中迁到 `rabi.manager.base`。迁移完成后常规对账不会再读取 `manager.json.managerPlugins`。`manager:core` 仍由 Profile 表示，但不能禁用。

`rabi.plugin.json` 只允许 schema、包 ID、版本、宿主、Manager 入口和可选 Web 入口。不能声明命令、任意路径、URL 或环境变量。Manager 对 Bundle 全部文件计算 SHA-256 revision；Profile、Patch、入口或依赖变化时，文件监听会把新 revision 复制到隔离运行目录，再由 Plugin Reconciler 停止旧 Fiber、撤销路由、排空已接受请求并挂载新 Fiber。新版本激活失败时恢复旧 Fiber。

Manager Bundle 只能通过受控宿主 API 注册 HTTP 路由、跟踪异步操作、发布命名插件事件、读取有限大小 JSON 请求体和返回 JSON。宿主把每个路由固定到当前 `instanceId`，卸载时自动撤销全部路由并等待已接受请求结束。Bundle 不能取得 Manager 全局状态，也不能替换核心路由。

Web Bundle 目录由 `/api/plugins/modules` 按 Bundle 包 ID、版本和 revision 发布；同一个 revision 即使服务多个 Manager 实例，浏览器也只加载一次入口。模块记录里的 `instances` 是该 Bundle 当前拥有的实例，Bundle 通过受控 `forInstance(instanceId)` API 分别注册它们的页面、设置 renderer、状态 renderer 和主题资源。浏览器以不可变路径加载 `/api/plugins/modules/<moduleId>/<revision>/<entryPath>`；同一 revision 下的相对 JavaScript、CSS 和字体资源也从该 Bundle revision 提供。收到 `plugin_catalog_changed` 后，revision 或 `instances` 集合变化都会先执行旧 disposer，再激活新 Bundle。新 Bundle 激活失败时会重新激活上一 revision；旧版也无法恢复时才报告该模块失败。旧 revision 保留的资源树与 `client.mjs` 一起读取，因此回退不会依赖会被下一次 WebGUI 构建覆盖的宿主静态资源。

Bundle 构建必须使用相对 URL。入口运行在 `/api/plugins/modules/<moduleId>/<rev>/web/` 时，懒加载脚本、CSS 和字体继续从这个 revision 目录读取，不会绕回 WebGUI 根路径或当前宿主静态资源。

最小可运行 Bundle 在 [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README.md)。
