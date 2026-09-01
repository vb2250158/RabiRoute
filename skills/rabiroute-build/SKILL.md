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

**重要**：正式 Windows 验收必须用本机磁盘上的构建副本和输出目录；NAS 只保存源码，不能承载构建中间物或运行进程。

## 场景对应命令

> **默认策略：始终走完整打包**（后端 + 前端 + 插件 + Host + Tray runtime + 安装器）。
> 只在明确说"只改前端"/"只改后端"时才单独构建。

### 完整打包 + 安装验收（默认）
```powershell
& "<repo>\scripts\build-windows-release.ps1"
```

### 仅前端（明确指定时才用）
```powershell
cmd /c "cd /d <repo> && npm run webgui:build"
```
这只用于开发校验；正式安装仍走完整包。

### 仅后端（明确指定时才用）
```powershell
cmd /c "cd /d <repo> && npm run build:backend"
```
这只用于开发校验；正式安装仍走完整包。


### 4. Windows 托盘版本（默认部署方式）
**在 Windows 上"打包"默认指托盘版本。** 托盘版本 = manager + PySide6 Qt 任务面板 + 系统托盘图标。

启动方式（只启动本机已安装的唯一 Host）：
```powershell
Start-Process "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe"
```

查询当前代状态和动态 Manager 地址：
```powershell
& "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command status --json
```

源码仓库不提供生产启动兼容入口。源码开发使用 `npm run dev` 或 `npm run dev:hot`；完整 Windows 验收必须先在本机磁盘构建发行包，再启动构建或安装目录里的 `RabiRouteHost.exe`。

### 5. 构建 Windows 完整包

```powershell
.\scripts\build-windows-release.ps1
```

默认输出到 `%LOCALAPPDATA%\RabiRoute\build\windows-release`。脚本构建后端、WebGUI、插件包、.NET Host 与隔离 Qt runtime，并生成 portable zip 和安装器；源码可以在 NAS，所有构建中间物与成品必须在本机磁盘。

Host 是唯一应用生命周期拥有者：每一代先以挂起状态创建 Manager、放入 Windows Job 后恢复，收到结构化 READY 才以同代身份启动 Tray。任一必需子程序异常退出都会结束整代，再按有界退避重建；用户退出走带 generation fence 的 Host 命令。

## 重启完整应用代

```powershell
& "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command restart
```

验证当前代：
```powershell
$status = & "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command status --json | ConvertFrom-Json
Invoke-RestMethod ($status.managerBaseUrl + "/meta") -TimeoutSec 3
```

## 端口说明

Manager HTTP API 与 WebGUI 默认请求端口 `0`，由 Windows 分配空闲回环端口。消费者只能从 Host status 或本代 READY 获得地址；不要缓存端口、扫描端口或读取旧 lock file。Gateway 与第三方 Adapter 的显式协议端口仍由各自配置管理，不属于 Manager 生命周期发现。

## 部署顺序（完整启动）

1. 运行 `scripts/build-windows-release.ps1`。
2. 安装生成的 setup，或解压 portable 包到本机磁盘。
3. 启动 `RabiRouteHost.exe`。
4. 用 `--command status --json` 验证 `state=healthy` 和 Manager/应用代身份。
5. 通过托盘或 Host `activate` 打开本代 WebGUI。
