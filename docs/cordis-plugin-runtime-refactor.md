<a href="./cordis-plugin-runtime-refactor_en.md">English</a> | 简体中文

# RabiRoute Cordis 插件运行时

> 状态：Profile、Patch、Bundle、版本 revision、Manager Fiber 热替换和 Web Bundle 重挂已接入。
>
> 主要读者：RabiRoute 维护者与插件作者。

## 当前入口

Manager 的插件真源是 Profile：

```text
data/plugins/manager/profile.json
data/plugins/manager/profile.d/*.json
plugins/packages/<encodeURIComponent(packageId)>/<version>/
```

Profile 的每个条目都有稳定 `id`、Bundle `package`、固定 `version`、`enabled` 和 JSON `config`。Patch 按文件名字典序应用 `upsert` 与 `remove`，因此安装包、选择版本和本机覆盖配置是三件独立的事。

Profile 缺失时，Manager 先用 Bundle 自带的默认 Profile 与旧 `manager.json.managerPlugins` enabled 值完成首轮装载；HTTP listener 就绪后异步写入 Profile 并删除旧键。若 Profile 已存在，它是唯一配置来源。旧 `rabi.manager.builtin` Profile 或 Patch 行在同一次初始化中改为 `rabi.manager.base`。常规对账只读取 Profile、Patch 和 Bundle，不读取或写入旧键。

## Bundle 合同

每个 Bundle 目录必须有 `rabi.plugin.json`：

```json
{
  "schemaVersion": 1,
  "id": "example.manager.echo",
  "version": "1.0.0",
  "hosts": ["manager", "web"],
  "entry": "./index.mjs",
  "webEntry": "./client.mjs"
}
```

清单只声明身份、版本、宿主与入口。它不能声明命令、任意路径、URL 或环境变量。Manager 对 Bundle 的全部文件计算 SHA-256 revision，并把每个 revision 复制到隔离运行目录后再导入，旧模块缓存不能污染新版本。

`rabi.manager.base` 是随 RabiRoute 发布的基础 Bundle。它的 `index.mjs` 直接拥有 26 个实例的 definition、依赖和表现贡献，`rabi.manager.profile.json` 拥有默认 Profile；Manager 不再反向创建内置 definition。基础 Bundle 仅取得按实例发放的 Manager 资源激活 capability，外部 Bundle 不会取得该 capability。

## Manager 生命周期

Profile、Patch 或 Bundle 文件变化会触发一次合并后的对账：

1. Loader 读取 Profile、Patch 和指定版本 Bundle；
2. Reconciler 用稳定 `id + revision` 比较当前 Fiber；
3. 变化实例停止接收新路由，撤销已注册路由并等待已接受请求结束；
4. 旧 Fiber dispose，新的隔离 revision 导入并挂载；
5. 新版本失败时，恢复此前成功的 Fiber；恢复失败时在 reconciliation 状态中记录错误。

Manager Bundle 只能注册本实例路由、跟踪异步操作、发布命名事件、读取有上限的 JSON 请求和返回 JSON。它不能读取 Manager 全局状态，不能替换核心控制面路由。

`manager:core` 是 Profile 条目，但不能禁用。持有端口、进程监督或外部长期连接的模块仍按受监督生命周期停止或重启；不让半卸载状态继续处理消息。

## Web Bundle 热替换

`GET /api/plugins/modules` 从最近一次成功完成的 Manager runtime snapshot 返回 active Web Bundle 图：每条记录按 Bundle 包 ID、版本和 SHA-256 revision 聚合，`instances` 列出该 Bundle 当前拥有的实例。它不在请求时重读 Profile；失败或等待依赖的实例不会发布给浏览器。同一 Bundle revision 即使拥有多个实例，浏览器也只 import 一次；Bundle 只能通过受控 `forInstance(instanceId)` 为每个实例登记贡献。WebGUI 收到 `plugin_catalog_changed` 后：

1. 释放 revision 或实例集合变化的旧 Bundle；
2. 从 `/api/plugins/modules/<moduleId>/<revision>/<entryPath>` 读取新模块；
3. 新模块只可注册受控页面、设置 renderer 或状态 renderer；
4. 新模块激活失败时重新激活上一 revision；两次激活都失败时显示错误并保留宿主恢复入口。

Web entry 与相对 JavaScript、CSS、字体资源同属一个不可变 revision 目录；回退读取该 revision 的完整资源树。

## 验收入口

- [插件 Bundle 与热替换](plugin-bundles.md)：Profile、Patch、目录和受控 API。
- [`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README.md)：Manager 路由与 Web 状态卡的最小 Bundle。
- `GET /api/plugins/reconciliation`：读取当前实例、revision、对账状态与回滚结果。
- `GET /api/plugins/modules`：读取当前 Web Bundle 图。

DSH 的 Profile / Bundle / Patch / 稳定 ID / 可释放 effect 模型是这里的参考。RabiRoute 保留自身 Route、事件记录、投递和 Outbox 的业务所有权，不把它们变成任意 Bundle 可写的全局状态。
