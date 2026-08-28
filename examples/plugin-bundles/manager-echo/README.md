# Manager Echo 插件

[English](README_en.md) | 简体中文

这是一个使用正式 Manifest、共享 SDK、Manager HTTP 原语和独立 Web 入口的树外插件示例。

## 安装

```powershell
$packageRoot = "C:\RabiRoutePlugins"
$profilePath = "C:\RabiRouteProfiles\desktop.json"
$target = Join-Path $packageRoot "example.manager.echo\1.0.0"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item examples/plugin-bundles/manager-echo/* $target -Recurse -Force
$env:RABIROUTE_PLUGIN_PACKAGE_ROOTS = $packageRoot
$env:RABIROUTE_PLUGIN_PROFILE = $profilePath
```

在 Profile 的 `instances` 中加入：

```json
{
  "id": "manager:example-echo",
  "package": "example.manager.echo",
  "version": "1.0.0",
  "enabled": true,
  "config": { "message": "hello" },
  "grants": ["manager.http"]
}
```

启动 Manager 后会提供：

```text
GET /api/plugins/example-echo
WebGUI 的 Plugin Echo 页面
```

修改 `manager.mjs`、`web/client.mjs` 或 Profile 后，Manager 保持 PID 不变并切换 revision。删除 Profile 条目会释放路由、服务和页面；随后可以删除包目录。
