# RabiRoute Qt 计划与记忆面板

这是 RabiRoute 桌面面板的最小 PySide6/Qt 版本。

它是额外的桌面便利入口。Qt/PySide6 本身跨平台，所以浮动面板和大部分托盘代码应尽量复用于 Windows、macOS 和 Linux。RabiRoute 本体、manager client、计划仓储、路径解析、生命周期规则和角色数据读取都必须保持可移植；平台启动器和打包脚本才是平台适配层。

Windows 桌面启动和完整打包的唯一真源是 `docs/windows-launcher-and-packaging.md`。本 README 只说明 Qt 面板自身，不重复定义 exe、后端 `dist/`、RibiWebGUI 前端产物和运行期 `data/` 的打包边界。

## 用途

这个应用是 RabiRoute 计划和记忆的桌面入口，不替代 RibiWebGUI，也不替代外部控制台。

MVP 范围：

- 当前平台和桌面环境支持 `QSystemTrayIcon` 时，常驻系统托盘。
- 桌面环境不支持系统托盘时，退化为普通浮动面板。
- 托盘右键菜单可以打开 RibiWebGUI。
- 托盘右键菜单可以显示或隐藏浮动面板。
- 托盘右键菜单可以刷新计划、记忆和 manager 状态。
- 托盘右键菜单可以打开角色计划目录、角色目录、当前项目目录和运行状态目录。
- 从 `http://127.0.0.1:8790` 读取 manager 状态。
- 从 `data/roles/<RoleId>/plans` 读取计划文件。
- 从 `data/roles/<RoleId>/memory` 读取记忆文件。
- 没有正式计划或记忆 JSON 时，展示清晰的空状态。
- 通过 Qt desktop services 打开文件夹，让 Windows Explorer、macOS Finder 或 Linux 文件管理器按平台能力处理。
- 提供可切换的只读视图：当前、计划、近期记忆、沉淀记忆和状态。

MVP 不包含：

- 替代 `npm run start:manager`、`npm run manager` 或 `node dist/manager.js`。
- 把 RabiRoute 做成 Windows-only。
- 把 bat 文件当成唯一启动方式。
- 写入计划或记忆事实。
- 增加 Windows 开机启动注册或 exe 打包。
- 发送 QQ / NapCat 消息。
- 增加 MCP server、本地端口服务或重型命令协议。

## 启动模型

RabiRoute 本体保持跨平台。

Windows PowerShell：

```powershell
npm run start:manager
npm run manager
node dist\manager.js
```

macOS / Linux：

```bash
npm run start:manager
npm run manager
node dist/manager.js
```

Qt 面板只是便利层。当前先提供 Windows 启动器；macOS/Linux 后续可以新增启动器，同时复用同一套 Qt 面板、manager client、计划仓储、角色上下文仓储、路径解析和生命周期控制器。

## 依赖

需要 Python 3 和 PySide6。MVP 不自动安装依赖。

准备使用时可以手动安装：

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

如果缺少 PySide6，入口脚本会给出安装提示，而不是直接抛出 Python traceback。

## 运行

```powershell
py desktop\tray-task-window\main.py
```

独立模式只连接已经存在的 manager。关闭独立模式的托盘面板不会停止 manager。

Qt 面板按项目根目录保持单实例。如果同一项目已经有一个面板在运行，新启动的进程会给出清晰提示并退出，而不是创建第二个托盘图标或窗口。

Windows 启动器可以按“1+1”生命周期启动：

```powershell
Start-RabiRoute-Tray.bat
```

等价命令：

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790
```

托盘里的 `退出 RabiRoute` 表示退出本地 RabiRoute 桌面运行态。它会先调用 manager 本地优雅关闭接口，manager 再停止 gateway 子进程并关闭 Web 服务，最后托盘入口退出。

## 浮动窗口视图

浮动窗口在 MVP 阶段保持朴素：状态头、视图按钮、只读文本区和刷新按钮。

当前视图：

- `当前`：进行中的计划。
- `计划`：所有未归档计划，并显示已归档计划数量。
- `近期记忆`：Agent 通过 RabiRoute 接口维护的近期记忆 JSON。
- `沉淀记忆`：RabiRoute 记忆整理流程写入的沉淀记忆 JSON。
- `状态`：manager 可达性，以及 gateway adapter、NapCat、heartbeat、角色语音/听众模式等运行状态文件。

所有视图都不写入计划或记忆数据。

## 数据边界

计划事实源位于当前角色目录：

```text
data/roles/<RoleId>/plans
```

面板读取：

```text
plans/items/active/*.json
plans/archive/*.json
```

记忆事实源位于：

```text
data/roles/<RoleId>/memory
```

面板读取：

```text
memory/recent/*.json
memory/consolidated/*.json
```

这些目录在托盘面板里一律只读。面板不会创建、完成、归档、删除、规范化或迁移计划/记忆文件。

托盘应用不能把计划或记忆事实存到 Qt resources、应用资源、安装目录或临时缓存里。内部 manager client 和仓储层使用 HTTP、JSON 和 `pathlib`，让非托盘逻辑保持可移植。Windows 专属的打包、开机启动注册或托盘行为差异属于平台层。

## 后续扩展点

MVP 阶段暂缓 MCP/server/port 集成。如果后续 RabiRoute 需要从外部控制浮动窗口，应围绕已有 snapshot 和 view key 增加一个小型跨平台命令适配层，不要让外部协议直接耦合 UI widget。

## 生命周期边界

托盘程序是本地 RabiRoute 桌面运行态的退出入口。平台启动器负责启动，manager 负责停止 gateway 子进程：

- 托盘菜单里的 `退出 RabiRoute` 始终会请求 `POST /manager/shutdown`。
- manager 收到 shutdown 后停止受管 gateway 子进程、关闭 HTTP server 并退出。
- 如果 shutdown 请求失败，托盘不会静默退出，避免 Web 服务仍留在后台。
- manager 在 Windows/macOS/Linux 上仍可通过 `npm run start:manager` 独立运行。
- 如果旧版本已经残留多个托盘进程，先从当前新版托盘执行 `退出 RabiRoute`，再检查是否仍有旧进程残留。

退出规则由 `rabiroute_tray.lifecycle_controller` 实现，保持平台无关。当前 Windows 通过 `Start-RabiRoute-Tray.bat` 提供第一版启动器；未来 macOS/Linux 启动器应复用同样的 manager HTTP 生命周期协议，不另起一套托盘行为。

## 代码布局

可移植层：

- `ManagerClient`：manager 状态和优雅关闭的 HTTP API 适配。
- `PlanRepository`：只读读取 `data/roles/<RoleId>/plans` 下的计划文件。
- `RoleContextRepository`：只读读取角色记忆和状态摘要。
- `LifecycleController`：本地 RabiRoute 关闭决策规则。
- `app_paths`：把 manager/gateway payload 解析为本地路径。
- `TaskWindow`：PySide6 视图状态和渲染。
- `DesktopAdapter`：通过 Qt desktop services 打开 URL、文件、文件夹并查找应用图标。
- `tray_app`：Qt 应用装配、托盘菜单、刷新循环和浮动面板启动。

平台专属层：

- Windows `.bat` / PowerShell 启动器。
- 未来 macOS `.command` / LaunchAgent / app bundle 启动器。
- 未来 Linux `.desktop` / systemd user unit / shell 启动器。
- 打包、开机启动注册，以及 OS 专属托盘可用性处理。
