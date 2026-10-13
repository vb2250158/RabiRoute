---
name: rabiroute-webgui-build
description: RabiRoute WebGUI 构建、打包和开发注意事项，包括常见报错的排查与修复。
---

# RabiRoute WebGUI 构建注意事项

普通 WebGUI 修改默认按[Web 热补丁](../../../docs/web-hot-patches.md)构建不可变候选，校验后热替换，核对活动 hash、回执和根 HTML 资源。原生热补丁不要求额外开启开关、设置环境变量或另起 watcher；当前安装版是否完成激活，以实际接口和运行证据为准。

包含后端、共享合同或新增模块变化时读取[源码热补丁工作流](../../../skills/source-hot-patch-development/SKILL.md)，按实际兼容性和状态迁移校验处理，不一律重启。当前运行版存在能力缺口时交原维护 owner 修复并验证，不将目标能力写成已经上线。

## 构建命令

**始终用 cmd /c 包裹，不要直接在 PowerShell 里用 &&：**

```powershell
cmd /c "cd /d <repo> && npm run build"
```

前端只改动时可以单独构建：
```powershell
cmd /c "cd /d <repo> && npm run webgui:build"
```

构建命令只准备产物，不隐含重启。激活前后通过当前 Host status 与 `/meta` 核对 Manager/应用代身份；热补丁应保持进程身份不变，并从实际运行地址回读新资源及页面行为。

只读发现与身份核验示例；状态尚未就绪时有界重试，不启动或重启服务：

```powershell
$hostExe = if ($env:RABIROUTE_HOST_EXE) { $env:RABIROUTE_HOST_EXE } else { Join-Path $env:LOCALAPPDATA "Programs\RabiRoute\RabiRouteHost.exe" }
$current = $null
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $candidate = & $hostExe --command status --json | Out-String | ConvertFrom-Json
  if ($candidate.ok -eq $true -and ($candidate.state -eq "healthy" -or $candidate.state -eq "degraded") -and $candidate.applicationGenerationId -and $candidate.managerInstanceId -and $candidate.managerBaseUrl) {
    $current = $candidate
    break
  }
  Start-Sleep -Milliseconds 500
}
if (-not $current) { throw "Host 未在查询期限内返回完整 READY 身份；保留错误证据，核对原维护任务。" }
$meta = Invoke-RestMethod "$($current.managerBaseUrl)/meta" -TimeoutSec 5
if ($meta.applicationGenerationId -ne $current.applicationGenerationId -or $meta.managerInstanceId -ne $current.managerInstanceId) {
  throw "Host READY 与 Manager /meta 身份不一致，须重新发现地址。"
}
if (-not $meta.health.live -or -not $meta.health.requiredReady -or $meta.health.state -notin @("healthy", "degraded")) {
  throw "Manager 必需依赖尚未就绪。"
}
```

用户明确要求完整发布、安装包或首次安装时，按[构建与部署](../../../skills/rabiroute-build/SKILL.md)交付完整包。确有 Host/native 运行时、依赖 ABI 或活动状态无法安全迁移时，记录具体诊断，在候选准备和预检完成后由 Host 受控切换；准备期间保留旧服务。

源码开发服务器不扫描端口。先运行 `npm run start:manager`，把本次标准输出中的动态地址写入 `RABIROUTE_MANAGER_URL`，再运行 `npm run webgui:dev`；Windows 已安装 Host 在线时，开发服务器也可以直接读取 Host `status --json`。地址缺失、Host 未就绪或 READY 身份不完整时，开发服务器显式失败。不得按端口查找或结束其他进程，也不得直接启动独立 Manager/托盘替代 Host 应用代。

---

## 常见问题

### TDZ 报错：`ReferenceError: Cannot access 'X' before initialization`

**症状：** 浏览器控制台报 TDZ（Temporal Dead Zone）错误，指向打包后的 `index-xxx.js`。

**原因：** 通常是以下之一：
1. **Vite 增量打包缓存污染** — 修改了 `types.ts` 删除字段后，旧 chunk 缓存仍引用已删除的导出
2. **循环依赖** — store / helper / page 之间出现循环 import

**修复：清理 dist 后全量重建：**
```powershell
cmd /c "cd /d <repo> && rmdir /s /q ribiwebgui\dist && npm run build"
```

浏览器也要强制刷新（Ctrl+Shift+R）清除缓存。

**预防：** 删除 `types.ts` 字段前，先 grep 所有引用，确认全部清理干净再构建。

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
