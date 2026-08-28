<a href="./plugin-bundles_en.md">English</a> | 简体中文

# 插件包与热替换

Manager 使用一个插件内核装载内置包和树外包。两者使用同一个 `rabi.plugin.json`、`@rabiroute/plugin-sdk`、能力依赖、权限检查和 effect 生命周期。

## 正式目录

默认构建产物：

```text
dist/plugins/profiles/desktop.json
dist/plugins/packages/<package-id>/<version>/
  rabi.plugin.json
  manager.mjs
  web/client.mjs  # 可选
```

源码只在 `plugins/builtin/` 维护。`npm run build` 生成 `dist/plugins/`；Manager 不从源码目录加载插件。

树外插件使用独立包根目录和单一 Profile：

```powershell
$env:RABIROUTE_PLUGIN_PACKAGE_ROOTS = "C:\RabiRoutePlugins"
$env:RABIROUTE_PLUGIN_PROFILE = "C:\RabiRouteProfiles\desktop.json"
npm run start:manager
```

多个包根目录使用 Windows 路径分隔符 `;`。环境变量决定进程使用哪个 Profile 和哪些包根目录；进程启动后，Profile 或包文件变化会触发热替换。

## Profile

Profile 只有一个格式，不支持 Patch：

```json
{
  "schemaVersion": 1,
  "instances": [
    {
      "id": "manager:example-echo",
      "package": "example.manager.echo",
      "version": "1.0.0",
      "enabled": true,
      "config": { "message": "hello" },
      "grants": ["manager.http"]
    }
  ]
}
```

`id` 是实例身份；`package` 和 `version` 选择安装包；`grants` 是该实例获得的权限。禁用或删除实例后，它的路由、监听器、定时器、连接、服务和界面贡献都会释放。

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "example.manager.echo",
  "version": "1.0.0",
  "entries": {
    "manager": "./manager.mjs",
    "web": "./web/client.mjs"
  },
  "provides": ["example.manager.echo@1"],
  "requires": ["host.manager.http@1"],
  "optional": [],
  "permissions": ["manager.http"]
}
```

能力引用必须使用 `name@major`。缺少必需能力的插件进入 `waiting_dependency`；权限未授予时失败关闭。Manifest 不接受旧宿主字段、独立入口字段或启动命令。

## 热替换

Manager 对包内全部文件计算 SHA-256 revision，并从 `data/plugins/.runtime/` 的隔离副本导入。

- revision、配置、权限或依赖 revision 不变时，不重新激活；
- 变化只重载该插件及真实依赖链；
- 不相关插件继续运行；
- 候选激活或 effect 发布失败时，上一可用 generation 继续服务；
- 成功后释放旧 effect scope；
- Web 模块使用不可变 revision URL，失败时保留上一可用模块；
- 常规更新不替换 Manager 或 Gateway 进程。

`GET /api/plugins/catalog` 返回插件和界面贡献，`GET /api/plugins/reconciliation` 返回活动、等待、失败和诊断状态，`POST /api/plugins/reconciliation` 立即重读。

## 插件作者入口

- SDK：`plugins/contracts/plugin-sdk/`
- 内置包：`plugins/builtin/`
- Profile：`plugins/profiles/desktop.json`
- 可运行示例：[`examples/plugin-bundles/manager-echo/`](../examples/plugin-bundles/manager-echo/README.md)
- 架构和边界：[`manager-plugin-implementation-hot-swap.md`](manager-plugin-implementation-hot-swap.md)

提交前运行：

```powershell
npm run check:plugin-architecture
npm test
npm run build
```
