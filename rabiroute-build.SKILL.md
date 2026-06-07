---
name: rabiroute-build
description: Use when the user asks to build, package, rebuild, restart, or deploy RabiRoute — including frontend-only build, backend-only build, full build+restart, or Windows tray packaging.
---

# RabiRoute 打包与部署

项目根目录：`<repo>`

## 构建组成

| 部分 | 源目录 | 输出 | 命令 |
|------|--------|------|------|
| 后端（Node.js） | `src/` | `dist/manager.js` | `npm run build:backend` |
| 前端（Vue/Vite） | `ribiwebgui/src/` | `ribiwebgui/dist/` | `npm run webgui:build` |
| 全量构建 | 两者 | 两者 | `npm run build` |

**重要**：npm 无法直接在 PowerShell 运行，必须用 `cmd /c "npm ..."` 包裹。

## 场景对应命令

> **默认策略：始终走完整打包**（后端 + 前端 + 重启 manager）。
> 只在明确说"只改前端"/"只改后端"时才单独构建。

### 完整打包 + 重启 + 托盘（默认，任何改动都用这个）
```powershell
# 1. 构建
cmd /c "cd /d <repo> && npm run build"
# 2. 停旧 manager
$p = (netstat -ano | Select-String ":8790.*LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] } | Select-Object -First 1)
if ($p) { Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue }
Start-Sleep 1
# 3. 启动新 manager
Start-Process "node" -ArgumentList "dist/manager.js" -WorkingDirectory "<repo>" -RedirectStandardOutput "rabiroute-manager-restart.log" -RedirectStandardError "rabiroute-manager-restart.err.log" -WindowStyle Hidden
Start-Sleep 2; Invoke-RestMethod "http://localhost:8790/meta" -TimeoutSec 3
# 4. 启动/复用托盘（-NoBuild 跳过重复构建，-NoOpen 不重复开浏览器）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\start-rabiroute-windows.ps1" -NoBuild -NoOpen
```

### 仅前端（明确指定时才用）
```powershell
cmd /c "cd /d <repo> && npm run webgui:build"
```
打包后仍需重启 manager（静态文件由 manager 提供）。

### 仅后端（明确指定时才用）
```powershell
cmd /c "cd /d <repo> && npm run build:backend"
```
必须重启 manager 才能生效。


### 4. Windows 托盘版本（默认部署方式）
**在 Windows 上"打包"默认指托盘版本。** 托盘版本 = manager + PySide6 Qt 任务面板 + 系统托盘图标。

启动方式（会自动检测是否需要 build）：
```powershell
Start-Process "<repo>\Start-RabiRoute-Tray.bat"
```

或调用 PowerShell 脚本（支持参数）：
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\start-rabiroute-windows.ps1"
```

脚本参数：
- `-NoBuild`：跳过自动构建（已有最新 dist）
- `-NoTray`：只启动 manager，不启动 Qt 面板
- `-NoOpen`：不自动在浏览器打开 WebGUI
- `-ManagerUrl`：默认 `http://127.0.0.1:8790`

托盘 Python 环境：
- 优先使用 `desktop\tray-task-window\.venv\Scripts\python.exe`
- 回退 `.venv-tray\Scripts\python.exe`
- 再回退系统 `py.exe` / `python.exe`
- 依赖：`PySide6>=6.7`，安装：`py -m pip install -r desktop\tray-task-window\requirements.txt`

## 重启 manager（不重新构建）

```powershell
$p = (netstat -ano | Select-String ":8790.*LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] } | Select-Object -First 1)
if ($p) { Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue }
Start-Sleep 1
Start-Process "node" -ArgumentList "dist/manager.js" -WorkingDirectory "<repo>" -RedirectStandardOutput "rabiroute-manager-restart.log" -RedirectStandardError "rabiroute-manager-restart.err.log" -WindowStyle Hidden
```

验证 manager 是否在线：
```powershell
Start-Sleep 2; Invoke-RestMethod "http://localhost:8790/meta" -TimeoutSec 3
```

## 端口说明

| 端口 | 用途 |
|------|------|
| 8790 | Manager HTTP API + WebGUI 静态文件 |
| 8792 | config-3 gateway WebSocket（可能在旧进程残留） |

## 自动构建判断

`start-rabiroute-windows.ps1` 会比较 `dist/manager.js` 的修改时间与 `src/`、`ribiwebgui/src/` 下 `.ts/.vue` 文件的修改时间，若源文件更新则自动触发 `npm run build`。

## 部署顺序（完整启动）

1. `npm run build`（或脚本自动触发）
2. 启动 `node dist/manager.js`（后台）
3. 等待 `http://127.0.0.1:8790/meta` 响应
4. 启动 Qt 托盘面板（`desktop/tray-task-window/main.py --owns-manager`）
5. 打开浏览器 `http://127.0.0.1:8790`
