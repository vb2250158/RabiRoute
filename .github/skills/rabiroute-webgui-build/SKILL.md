---
name: rabiroute-webgui-build
description: RabiRoute WebGUI 构建、打包和开发注意事项，包括常见报错的排查与修复。
---

# RabiRoute WebGUI 构建注意事项

## 构建命令

**始终用 cmd /c 包裹，不要直接在 PowerShell 里用 &&：**

```powershell
cmd /c "cd /d <repo> && npm run build"
```

前端只改动时可以单独构建：
```powershell
cmd /c "cd /d <repo> && npm run webgui:build"
```

重启 Manager：
```powershell
$p = (netstat -ano | Select-String ":8790.*LISTENING") -replace '.*\s(\d+)$','$1' | Select-Object -First 1
if ($p) { Stop-Process -Id ([int]$p.Trim()) -Force; Start-Sleep 1 }
Start-Process "node" -ArgumentList "dist/manager.js" -WorkingDirectory "<repo>" -WindowStyle Hidden
```

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
