# Manager Echo Bundle

[English](README_en.md) | 简体中文

这是一个可热替换的最小 Manager 与 Web Bundle。复制到本机受信任 Bundle 目录后，给 Profile 增加 `manager:example-echo` 条目，会提供：

```text
GET /api/plugins/example-echo
WebGUI 的 Plugin Echo 页面与状态卡
```

```powershell
$target = "plugins/packages/example.manager.echo/1.0.0"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item examples/plugin-bundles/manager-echo/* $target -Recurse -Force
```

在 `data/plugins/manager/profile.d/10-example-echo.json` 写入：

```json
{
  "schemaVersion": 1,
  "operations": [
    {
      "op": "upsert",
      "plugin": {
        "id": "manager:example-echo",
        "package": "example.manager.echo",
        "version": "1.0.0",
        "enabled": true,
        "config": { "message": "hello" }
      }
    }
  ]
}
```

保存 Patch、`index.mjs` 或 `client.mjs` 后，Manager 会生成新 revision。后端先停止旧 Fiber、撤销路由并排空已接受请求；浏览器先执行旧 disposer 再激活新 Web entry。新 Web entry 失败时，浏览器恢复上一 revision。

`client.mjs` 是浏览器直接加载的单文件 ESM 入口。发布前将其打包为单文件；当前 HTTP 合同不提供相对导入的依赖文件。
