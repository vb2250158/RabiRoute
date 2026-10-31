---
name: rabiroute-webgui-build
description: RabiRoute WebGUI 构建、打包和开发注意事项，包括常见报错的排查与修复。
---

# RabiRoute WebGUI 构建注意事项

普通 WebGUI 修改默认按[Web 热补丁](../../../docs/web-hot-patches.md)构建不可变候选，校验后热替换，核对活动 hash、回执和根 HTML 资源。原生热补丁不要求额外开启开关、设置环境变量或另起 watcher；当前安装版是否完成激活，以实际接口和运行证据为准。

包含后端、共享合同或新增模块变化时读取[源码热补丁工作流](../../../skills/source-hot-patch-development/SKILL.md)，按实际兼容性和状态迁移校验处理，不一律重启。当前运行版存在能力缺口时交原维护 owner 修复并验证，不将目标能力写成已经上线。

## 构建命令

在本轮隔离源码目录执行匹配测试和项目要求的完整构建：

```powershell
npm run build
```

`npm run webgui:build` 用于单独核对前端产物；开发快路径只有通过对应证明、影响分析和发布准入后才可替代完整验证。不要在运行目录或其他任务的输出目录执行构建。

构建命令只准备产物，不隐含重启。激活前后通过 `RabiRouteHost.exe --command status --json` 与 `/meta` 核对 Manager/应用代身份；热补丁应保持进程身份不变，并从实际运行地址回读新资源及页面行为。

使用项目动态解析器发现地址，核对身份和本次功能的实际依赖：

```powershell
$identity = node <repo>/scripts/resolve-manager.mjs | ConvertFrom-Json
$meta = Invoke-RestMethod ($identity.managerBaseUrl + "/meta") -TimeoutSec 5
if ($meta.applicationGenerationId -ne $identity.applicationGenerationId -or $meta.managerInstanceId -ne $identity.managerInstanceId) {
  throw "Manager 身份已变化，重新发现原实例。"
}
if (-not $meta.health.live -or $meta.health.state -notin @("healthy", "degraded")) {
  throw "Manager 事件循环不可用或健康状态无效。"
}
```

`requiredReady` 记录声明能力状态；缺项由目标接口判断，不阻断无依赖功能。解析失败保留实际错误并核对原维护任务，不启动替代实例。

用户明确要求完整发布、安装包或首次安装时，按[构建与部署](../../../skills/rabiroute-build/SKILL.md)交付完整包。确有 Host/native 运行时、依赖 ABI 或活动状态无法安全迁移时，记录具体诊断，在候选准备和预检完成后由 Host 受控切换；准备期间保留旧服务。

源码开发服务器不扫描端口。先运行 `npm run start:manager`，把本次标准输出中的动态地址写入 `RABIROUTE_MANAGER_URL`，再运行 `npm run webgui:dev`；Windows 已安装 Host 在线时，开发服务器也可以直接读取 Host `status --json`。地址缺失、Host 未就绪或 READY 身份不完整时，开发服务器显式失败。不得按端口查找或结束其他进程，也不得直接启动独立 Manager/托盘替代 Host 应用代。

---

## 常见问题

### TDZ 报错：`ReferenceError: Cannot access 'X' before initialization`

**症状：** 浏览器控制台报 TDZ（Temporal Dead Zone）错误，指向打包后的 `index-xxx.js`。

**原因：** 通常是以下之一：
1. **Vite 增量打包缓存污染** — 修改了 `types.ts` 删除字段后，旧 chunk 缓存仍引用已删除的导出
2. **循环依赖** — store / helper / page 之间出现循环 import

**修复：先核对循环引用与实际产物版本，再在本任务隔离目录重建：**
```powershell
npm run build
```

确认当前页面的草稿已保存或导出后，再按兼容策略刷新；保留仍在使用的旧页面资源。

**预防：** 删除 `types.ts` 字段前，先用 `rg` 查所有引用，确认全部清理干净再构建。

---

### dataDir 路径重复嵌套

**症状：** 路由数据目录出现 `config-3/config-3/config-3/...` 多层嵌套。

**原因：** `routeConfigItem()` 把 `definition.dataDir`（已含 configName 的完整路径）写入配置文件，下次 `normalizeDefinition` 读取后再次拼接 configName，每保存一次多嵌套一层。

**修复原则：**
- `dataDir` 不应写入 `routeConfig.json`，路径由全局 `routeRoot/configName` 动态计算
- `normalizeDefinition`、`envFor`、`dataDirFor` 统一使用 `path.resolve(routeRoot, configName)`，不读 `definition.dataDir`

---

## 架构说明

- **全局目录配置** 存在 `data/manager.json`，字段为 `routeDir`（路由根目录）和 `rolesDir`（角色根目录），接口为 `GET/POST /manager-config`
- **per-gateway 的 `dataDir`/`rolesDir` 已废弃**，不保存到 `routeConfig.json`
- 实际数据目录 = `routeRoot / configName`，角色目录 = `rolesRoot`
