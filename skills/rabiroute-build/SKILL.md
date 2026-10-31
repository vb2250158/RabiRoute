---
name: rabiroute-build
description: 用于 RabiRoute 构建、打包、重启、部署和运行验收；区分构建验证、原生热补丁激活与完整安装包交付。
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

构建验证与运行激活分别处理。普通功能修改按项目要求运行匹配测试及 `npm run build`；构建成功不会自动要求安装完整包或重启应用。

普通改动默认按[源码热补丁工作流](../source-hot-patch-development/SKILL.md)准备不可变候选，完成完整性、兼容性和状态迁移校验后热替换，再回读活动版本与原场景。原生热补丁不以额外开启开关、设置环境变量或另起 watcher 为使用前提；后端变化、新增模块和未来模块按同一发现与校验流程处理，不按名称或静态清单一律改走重启。当前运行版的能力缺口须交给原维护 owner 修复并验证，不能将目标能力写成已经上线。

用户明确要求完整发布、安装包、portable 包或首次安装时，仍执行完整打包与对应安装验收。候选准备期间保留旧服务；需要进程切换时按下方边界处理。

### 完整打包 + 安装验收（明确交付完整包或首次安装）
```powershell
& "<repo>\scripts\build-windows-release.ps1"
```

### 仅前端构建
```powershell
cmd /c "cd /d <repo> && npm run webgui:build"
```
该命令只生成前端产物；运行激活按 Web 热补丁合同验收。明确交付安装包时另走完整打包。

### 仅后端构建
```powershell
cmd /c "cd /d <repo> && npm run build:backend"
```
该命令只生成后端产物；不替代项目要求的完整构建，也不隐含重启。运行激活按源码热补丁工作流处理。


### 4. Windows 安装包与托盘版本
**在 Windows 上"打包"默认指托盘版本。** 托盘版本 = manager + PySide6 Qt 任务面板 + 系统托盘图标。

启动方式（只启动本机已安装的唯一 Host）：
```powershell
Start-Process "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" -WindowStyle Hidden
```

查询当前代状态和动态 Manager 地址：
```powershell
& "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command status --json | Out-String
```

源码仓库不提供生产启动兼容入口。源码开发使用 `npm run dev`；Windows 安装器或 portable 包验收必须先在本机磁盘构建发行包，再启动构建或安装目录里的 `RabiRouteHost.exe`。不要为普通热补丁验收启动第二个 Manager。

### 5. 构建 Windows 完整包

```powershell
.\scripts\build-windows-release.ps1
```

默认输出到 `%LOCALAPPDATA%\RabiRoute\build\windows-release`。脚本构建后端、WebGUI、插件包、.NET Host 与隔离 Qt runtime，并生成 portable zip 和安装器；源码可以在 NAS，所有构建中间物与成品必须在本机磁盘。

Host 是唯一应用生命周期拥有者：每一代先以挂起状态创建 Manager、放入 Windows Job 后恢复，收到结构化 READY 才以同代身份启动 Tray。任一必需子程序异常退出都会结束整代，再按有界退避重建；用户退出走带 generation fence 的 Host 命令。

## 确需进程切换或明确要求重启时

Host/启动器、Node/Qt 或 native 二进制、当前进程无法安全更换的依赖 ABI，以及无法安全迁移的活动状态，须先给出具体文件、校验结果和不能热替换的原因。不能仅凭“后端改动”“共享合同变化”、构建产物摘要不同或尚未实现的热补丁覆盖，就断言必须重启。

确认确需切换后，先准备并验证候选、保留回退产物和活动任务，再在现有授权范围内通过 Host 正式入口切换。重启当前版本不能代替候选激活；下面命令仅用于明确要求重启当前已安装版本的场景。

```powershell
$hostExe = Join-Path $env:LOCALAPPDATA "Programs\RabiRoute\RabiRouteHost.exe"
$before = & $hostExe --command status --json | Out-String | ConvertFrom-Json
if (-not $before.applicationGenerationId) { throw "Host 未返回当前应用代身份。" }
& $hostExe --command restart --application-generation-id $before.applicationGenerationId --json | Out-String
```

验证当前代：
```powershell
$status = & "$env:LOCALAPPDATA\Programs\RabiRoute\RabiRouteHost.exe" --command status --json | Out-String | ConvertFrom-Json
Invoke-RestMethod ($status.managerBaseUrl + "/meta") -TimeoutSec 3
```

## 端口说明

Manager HTTP API 与 WebGUI 默认请求端口 `0`，由 Windows 分配空闲回环端口。消费者只能从 Host status 或本代 READY 获得地址；不要缓存端口、扫描端口或读取旧 lock file。Gateway 与第三方 Adapter 的显式协议端口仍由各自配置管理，不属于 Manager 生命周期发现。

## 完整包交付顺序（首次安装或已确认需切换）

1. 运行 `scripts/build-windows-release.ps1`。
2. 安装生成的 setup，或解压 portable 包到本机磁盘。
3. 启动 `RabiRouteHost.exe`。
4. 用 `--command status --json` 和 `/meta` 核对 Manager/应用代身份、`live=true`，接受 `healthy` 或 `degraded`，记录 `requiredReady` 的声明能力状态，再由目标接口判断其功能依赖。
5. 通过托盘或 Host `activate` 打开本代 WebGUI。
