# Windows 双击启动器与打包说明

RabiRoute 仍然从可移植的 Node manager 启动。Windows 启动器只是桌面便利入口：它会检测已有 manager，只在需要时启动一个新的 manager，把日志写到路由数据目录，打开 RibiWebGUI，并在 Python/PySide6 可用时启动 PySide6/Qt 计划与记忆面板。

Windows 启动器是“1+1”桌面体验的监督者：

```text
Start-RabiRoute-Tray.bat
  -> 内嵌 PowerShell 启动器
     -> node dist/manager.js
        -> 由 manager 管理的 gateway 子进程
     -> desktop/tray-task-window/main.py --manager-url http://127.0.0.1:8790
```

托盘里的 `退出 RabiRoute` 始终表示退出本地 RabiRoute 桌面运行态。它会调用本地 manager 关闭 API；manager 停止受管 gateway 子进程、关闭 HTTP server 并退出；随后托盘入口退出。

## 双击启动

在项目根目录双击：

```text
Start-RabiRoute-Tray.bat
```

`Start-RabiRoute-Tray.bat` 是一个 batch/PowerShell 混合启动器。旧的拆分启动文件已经移除，现在 Windows 只有这一个需要维护的源码入口。

默认行为：

- 使用项目根目录作为工作目录。
- 检查 `http://127.0.0.1:8790/meta`。
- 如果 RabiRoute manager 已经运行，复用它并打开 `http://127.0.0.1:8790/`。
- 如果端口 `8790` 被非 RabiRoute manager 占用，直接退出，不启动重复进程。
- 如果 `dist/manager.js` 缺失，或比源码更旧，会运行 `npm.cmd run build`，除非传入 `-NoBuild`。
- 没有 manager 运行时，在后台启动 `node dist\manager.js`。
- manager 响应后打开 RibiWebGUI。
- 除非传入 `-NoTray`，否则启动 PySide6/Qt 计划与记忆面板。
- 如果 Qt 面板已经运行，会复用已有面板，不创建重复托盘窗口。

日志写入：

```text
data/route/default-main/logs/
```

每次启动器运行都会创建带时间戳的文件，例如：

```text
launcher-YYYYMMDD-HHMMSS.log
manager-YYYYMMDD-HHMMSS.stdout.log
manager-YYYYMMDD-HHMMSS.stderr.log
tray-YYYYMMDD-HHMMSS.stdout.log
tray-YYYYMMDD-HHMMSS.stderr.log
```

常用直接命令：

```powershell
.\Start-RabiRoute-Tray.bat
.\Start-RabiRoute-Tray.bat -NoOpen
.\Start-RabiRoute-Tray.bat -NoBuild
.\Start-RabiRoute-Tray.bat -NoTray
.\Start-RabiRoute-Tray.bat -ManagerUrl http://127.0.0.1:8790
```

## 启动器不负责的事

启动器不会启动或停止 NapCat、QQ 或任何非 RabiRoute 进程。如果存在端口冲突，它只报告冲突并保持现有进程不动。RabiRoute 的退出由 manager 本地 shutdown API 统一处理，不靠启动器直接杀进程。

## Manager 关闭 API

可移植的 Node manager 暴露一个仅本机可用的优雅关闭端点：

```text
POST http://127.0.0.1:8790/manager/shutdown
```

这个端点让 Windows 托盘可以停止本地 manager，而不需要使用 Windows-only 的杀进程方式。manager 已经绑定在 `127.0.0.1`；这个端点不应该暴露到网络。它会停止受管 gateway 子进程、关闭 HTTP server 并退出。`SIGINT` 和 `SIGTERM` 也使用同一条关闭路径。

曾考虑但暂不采用的方案：

- 从托盘直接杀 manager PID：MVP 阶段拒绝，因为它是 Windows 专属行为，也更容易留下子进程或不完整日志。
- signal file：后续可以考虑，但观察延迟更高，也不如已有本地 HTTP API 直接。
- 让托盘成为长期父进程：暂不采用，让 Node manager 保持可移植核心，Windows 托盘只做便利层。

## macOS 和 Linux

可移植启动路径已经支持，并且仍然是基线：

```bash
npm install
npm run build
npm run start:manager
```

然后打开：

```text
http://127.0.0.1:8790/
```

这意味着 server、WebUI、manager API、gateway runtime、计划仓储布局和优雅关闭协议都不是 Windows-only。

当前只有便利启动器是 Windows 专属：

```text
Start-RabiRoute-Tray.bat
```

未来 macOS/Linux 桌面入口应该是另一个平台启动器，而不是另一个 RabiRoute core。它应遵守同一组约定：

1. 检测 `http://127.0.0.1:8790/meta`。
2. 只有没有 manager 运行时，才启动 `node dist/manager.js`。
3. 使用 `--manager-url` 启动托盘/浮动面板。
4. 托盘退出始终调用 `POST /manager/shutdown`。
5. shutdown 失败时，托盘不应静默退出，以免 Web 服务残留。

可能的平台启动器：

- macOS：先提供 `.command` 脚本，后续再考虑小型 `.app` wrapper 或 LaunchAgent。
- Linux：先提供 `.desktop` 文件加 shell 脚本；只有需要长期自启动时，再考虑 systemd user unit。
- 两者都应复用同一套 PySide6/Qt 面板代码。桌面环境支持系统托盘时走托盘；不支持时，以普通浮动窗口运行。

需要保持的代码边界：

```text
可移植层：manager HTTP API、shutdown API、ManagerClient、PlanRepository、RoleContextRepository、LifecycleController、app_paths、Qt TaskWindow。
平台适配层：启动脚本、打包、开机启动、OS 专属托盘可用性和启动行为。
```

## Qt 计划与记忆面板

`desktop/tray-task-window` 下的 PySide6/Qt 面板，对跨平台 Node manager 启动来说是可选的；但它属于 Windows “1+1” 桌面入口的一部分。Qt 是跨平台的，所以面板代码应继续可复用于 Windows、macOS 和 Linux。

需要托盘入口时，推荐本地准备方式：

```powershell
py -m venv .venv-tray
.\.venv-tray\Scripts\python.exe -m pip install -r desktop\tray-task-window\requirements.txt
.\.venv-tray\Scripts\python.exe desktop\tray-task-window\main.py
```

除非这台机器明确希望全局安装 PySide6，否则不要全局安装。

启动器按以下顺序查找 Python：

1. `desktop\tray-task-window\.venv\Scripts\python.exe`
2. `.venv-tray\Scripts\python.exe`
3. `py.exe -3`
4. `python.exe`

如果缺少 Python 或 PySide6，托盘进程会在 tray stderr 日志中给出清晰提示后退出；manager/WebGUI 仍保持可用。

没有系统托盘的桌面环境中，Qt app 应该仍然以普通窗口显示浮动面板。平台启动器负责判断这种体验对目标 OS/package 是否可接受。

Qt 面板还按项目根目录实现了跨平台单实例锁。这个保护同样适用于 macOS/Linux 启动器，不只是 Windows PowerShell 启动器。

## 托盘 exe 打包

仓库包含打包 spec 和构建 wrapper，但生成的 exe 是本地构建产物，不是源码文件。

本地构建：

```powershell
.\scripts\build-tray-exe.ps1
```

脚本会运行 `npm run build`，用 `RabiRoute-Tray.spec` 调用 PyInstaller，并把 `dist\RabiRoute-Tray.exe` 复制到仓库根目录方便本地测试。`RabiRoute-Tray.exe` 已被 Git 忽略。正式发布二进制前必须单独做一次发布脱敏检查，因为 PyInstaller 输出可能包含构建机路径。

运行边界：

- exe 只打包 PySide6 托盘入口。
- exe 不打包 Node.js、`dist/manager.js`、`ribiwebgui/dist` 或运行期 `data`。
- frozen 模式下，`desktop/tray-task-window/main.py` 会从 `Path(sys.executable).parent` 解析项目根目录。
- 如果 manager 没有运行，exe 会启动 `node dist/manager.js`，并拥有该进程的关闭权。

真实发布 exe 前，需要确认：

- `dist/manager.js` 和 `dist/index.js` 已构建。
- `ribiwebgui/dist/index.html` 存在。
- `data/route/<configName>/adapterConfig.json` 和 `data/roles/<RoleId>/personaConfig.json` 仍是可写的运行期文件。
- 日志写在 bundled resources 外部。
- 桌面入口永远不能成为唯一受支持的启动路径。

后续可能的打包方向：

- GitHub Releases：只有完成单独的二进制脱敏和冒烟测试后再使用。
- 小型 installer：后续可以安装 Node/runtime 前置条件，并放置检出的项目目录。
- Electron shell：只有 WebGUI 真正需要桌面窗口能力时才值得考虑。
