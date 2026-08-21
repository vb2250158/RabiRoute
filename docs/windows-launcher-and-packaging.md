<!-- docs-language-switch -->
<div align="center">
<a href="./windows-launcher-and-packaging_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Windows 桌面启动与完整打包

> 状态：现行指南。已按启动脚本、Manager shutdown API、Qt 托盘代码和打包脚本核对。

本文是 Windows 桌面启动和打包的唯一真源。README、脚本注释和托盘 README 只应指向这里，不再各自维护另一套“exe 是否完整包”的解释。

RabiRoute Desktop 是 Windows 上唯一的用户入口。系统托盘和任务窗口只是它的界面；Manager 是它使用的本机后端，不单独作为另一款 Windows 软件出现。完整运行包由以下产物组成：

```text
RabiRoute-Desktop.exe          托盘/任务面板入口，负责桌面体验和启动监督
scripts/watch-rabiroute-desktop-lifecycle.ps1  桌面后端与界面共同监督器
dist/manager.js             Node manager 后端入口
dist/**/*.js                gateway、adapter、routing 等后端编译产物
ribiwebgui/dist/            RibiWebGUI 前端静态产物
data/                       外置、可写、私有的运行期配置和日志
node.exe 或系统 Node.js      运行 manager 的 Node runtime
node_modules/ 或等价依赖     manager 运行需要的 npm 依赖
```

`RabiRoute-Desktop.exe` 是完整 Windows 桌面应用的启动入口。它负责拉起并监督本机后端、WebGUI 和桌面界面；启动时会删除同目录旧的 `RabiRoute-Tray.exe`、`RabiRoute-Tray.new.exe` 和未替换的 `RabiRoute-Desktop.new.exe`，避免旧入口继续出现。发布包必须同时带齐这些运行产物和外置运行期数据。

Windows 用户始终从 RabiRoute Desktop 启动。它会检测并在需要时启动本机后端，把日志写到路由数据目录，打开 RibiWebGUI，并显示 PySide6/Qt 计划与记忆界面；直接运行 Node Manager 只用于开发或跨平台部署。

Windows 启动器建立一个 RabiRoute Desktop 运行态，并把缺失组件修复交给唯一的轻量监督器：

```text
Start-RabiRoute-Desktop.bat 或 RabiRoute-Desktop.exe
  -> 检查/补齐 dist/manager.js 和 ribiwebgui/dist
  -> node dist/manager.js
     -> manager 提供 RibiWebGUI 静态文件和 HTTP API
     -> manager 管理 gateway 子进程
  -> RabiRoute Desktop 界面（系统托盘与任务窗口）连接 http://127.0.0.1:8790
  -> data/runtime/desktop-lifecycle-intent.json = running
  -> watch-rabiroute-desktop-lifecycle.ps1
     -> 后端或界面缺失时通过同一启动器恢复完整桌面运行态
```

RabiRoute Desktop 菜单里的 `退出 RabiRoute` 始终表示退出本地桌面运行态。Manager 会先原子写入 `desiredState=stopped`，再停止受管 gateway、关闭 HTTP server 并退出，随后桌面界面退出。监督器看到 `stopped` 后自行结束，不能把用户明确关闭的进程重新拉起。普通 Manager 重载不改变该意图。

## 双击启动

在项目根目录双击：

```text
Start-RabiRoute-Desktop.bat
```

`Start-RabiRoute-Desktop.bat` 是一个 batch/PowerShell 混合启动器。旧的拆分启动文件已经移除，现在 Windows 只有这一个需要维护的源码入口。

默认行为：

- 使用项目根目录作为工作目录。
- 连续检查 `http://127.0.0.1:8790/meta`，只有稳定健康的 Manager 才会复用。
- 如果健康 Manager 正在运行但早于当前 `dist/manager.js` 构建，先受控关闭旧实例，再加载当前构建。
- 如果 `8790` 被无响应进程占用，只在命令行精确指向本项目绝对 `dist/manager.js`，或发布包/旧启动方式使用的相对 `dist/manager.js` 时接管：先调用 `/manager/shutdown`，超时后才终止这棵已核实的进程树；Node 进程、端口 owner 与 Manager 探活门禁仍须同时成立。
- 如果端口 `8790` 属于非本项目进程或无法核实的进程，直接退出，不停止它，也不启动重复 Manager。
- Manager 在加载控制面前还会独占 `data/.runtime/manager-instance.lock`。同一工作区从映射盘、UNC、启动器或直接 `node dist/manager.js` 并发启动时，后到实例以退出码 `17` 拒绝启动；锁中 PID 已不存在时才回收陈旧锁。
- 如果 `dist/manager.js` 缺失，或比后端源码更旧，会运行 `npm.cmd run build`，除非传入 `-NoBuild`。
- 如果 RibiWebGUI 前端产物 `ribiwebgui/dist/index.html` 或 `ribiwebgui/dist/assets` 缺失，或比前端源码更旧，会自动补构建；manager 已运行时只跑 `npm.cmd run webgui:build`，manager 未运行时跑完整 `npm.cmd run build`。
- 没有 manager 运行时，在后台启动 `node dist\manager.js`。
- manager 响应后打开 RibiWebGUI。
- 除非传入 `-NoDesktopShell`，否则启动 RabiRoute Desktop 界面。
- 如果 RabiRoute Desktop 界面已经运行，会复用已有界面，不创建重复窗口。
- 完整桌面启动会由 Manager 原子记录 `running` 意图，并启动工作区唯一的轻量监督器。监督器每 5 秒只检查本机后端 `/meta` 和本项目桌面界面进程，连续两次缺失才走同一启动器的 PID、端口和单实例门禁恢复完整运行态；它不扫描或修复 QQ、NapCat、Route、Adapter 等业务状态。
- 桌面界面探测到本机后端暂时离线时保持运行并显示离线状态，不再因连续超时自行退出；后端或界面真正消失时，由监督器恢复完整桌面运行态。

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
desktop-lifecycle-supervisor.log
desktop-lifecycle-supervisor.jsonl
```

常用直接命令：

```powershell
.\Start-RabiRoute-Desktop.bat
.\Start-RabiRoute-Desktop.bat -NoOpen
.\Start-RabiRoute-Desktop.bat -NoBuild
.\Start-RabiRoute-Desktop.bat -NoDesktopShell
.\Start-RabiRoute-Desktop.bat -ManagerUrl http://127.0.0.1:8790
```

## 启动器不负责的事

启动器不会启动或停止 NapCat、QQ 或任何非 RabiRoute 进程。未知端口占用者只会被报告并保持不动。只有同一项目、同一 `dist/manager.js` 的旧 Manager 已被精确核实时，启动器才会先请求本地 shutdown；若该实例已经无响应且仍占端口，才终止它自己的进程树，避免一个僵死旧实例永久阻止新版本启动。

## Manager 关闭 API

可移植的 Node manager 暴露一个仅本机可用的优雅关闭端点：

```text
POST http://127.0.0.1:8790/manager/shutdown
```

这个端点只接受本机请求。托盘发送 `{ "desktopExit": true }` 时，Manager 必须先持久化 `stopped` 意图；持久化失败则拒绝退出并让托盘继续显示。安装、升级或受控重载使用普通空请求，只关闭 Manager 而不把桌面意图改成 `stopped`。两种请求最终都使用与 `SIGINT`、`SIGTERM` 相同的 Manager 关闭路径。

完整桌面启动使用另一个仅本机端点写入运行意图：

```text
POST http://127.0.0.1:8790/manager/desktop-lifecycle/start
```

`data/runtime/desktop-lifecycle-intent.json` 是私有运行期事实源，不提交到仓库。文件缺失、损坏或不是 `running` 时监督器失败关闭，绝不自行猜测应当启动桌面运行态。

曾考虑但暂不采用的方案：

- 从从 RabiRoute Desktop 直接杀 manager PID：MVP 阶段拒绝，因为它是 Windows 专属行为，也更容易留下子进程或不完整日志。
- signal file：后续可以考虑，但观察延迟更高，也不如已有本地 HTTP API 直接。
- 让 Windows 界面成为长期父进程：不采用。Node manager 保持可移植核心；Windows 的长期 owner 是只负责 RabiRoute Desktop 运行态的独立监督器；桌面界面只负责表现。

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
Start-RabiRoute-Desktop.bat
```

未来 macOS/Linux 桌面入口应该是另一个平台启动器，而不是另一个 RabiRoute core。它应遵守同一组约定：

1. 检测 `http://127.0.0.1:8790/meta`。
2. 只有没有 manager 运行时，才启动 `node dist/manager.js`。
3. 使用 `--manager-url` 启动 RabiRoute Desktop 的任务窗口。
4. 用户从 RabiRoute Desktop 退出时始终调用 `POST /manager/shutdown`。
5. shutdown 失败时，RabiRoute Desktop 保持可见并提示失败，以免本机后端残留。

可能的平台启动器：

- macOS：先提供 `.command` 脚本，后续再考虑小型 `.app` wrapper 或 LaunchAgent。
- Linux：先提供 `.desktop` 文件加 shell 脚本；只有需要长期自启动时，再考虑 systemd user unit。
- 两者都应复用同一套 PySide6/Qt 面板代码。桌面环境支持系统托盘时走托盘；不支持时，以普通浮动窗口运行。

需要保持的代码边界：

```text
可移植层：manager HTTP API、shutdown API、ManagerClient、DesktopRefreshService、desktop read-model DTO、通用 `qt_async`、LifecycleController、app_paths、Qt TaskWindow。Windows 桌面界面不直接加载角色文件仓储；它与 RibiWebGUI 共用 Manager 后端。
平台适配层：启动脚本、打包、登录启动、OS 专属系统托盘可用性和启动行为。
```

## Qt 计划与记忆面板

`desktop/tray-task-window` 下的 PySide6/Qt 面板，对跨平台 Node manager 启动来说是可选的；但它属于 RabiRoute Desktop 的内部界面模块。Qt 是跨平台的，所以面板代码应继续可复用于 Windows、macOS 和 Linux。

需要构建 RabiRoute Desktop 时，推荐本地准备方式：

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

如果缺少 Python 或 PySide6，RabiRoute Desktop 启动会失败并留下明确日志；需要仅运行跨平台后端时，显式使用 `npm run start:manager`。

没有系统托盘的桌面环境中，Qt app 应该仍然以普通窗口显示浮动面板。平台启动器负责判断这种体验对目标 OS/package 是否可接受。

Qt 面板还按项目根目录实现了跨平台单实例锁。这个保护同样适用于 macOS/Linux 启动器，不只是 Windows PowerShell 启动器。

## Windows 完整包构建

仓库包含打包 spec 和构建 wrapper，但生成的 exe 和构建产物都是本地构建产物，不是源码文件。

本地构建：

```powershell
.\scripts\build-desktop-exe.ps1
```

这是 Windows 完整桌面运行包的唯一构建入口。脚本会运行 `npm run build`，确认后端 `dist/manager.js` 和前端 `ribiwebgui/dist/index.html` 都存在，再用 `RabiRoute-Desktop.spec` 调用 PyInstaller，并把 `dist\RabiRoute-Desktop.exe` 复制到仓库根目录方便本地测试。`RabiRoute-Desktop.exe` 已被 Git 忽略。正式发布二进制前必须单独做一次发布脱敏检查，因为 PyInstaller 输出可能包含构建机路径。

运行边界：

- exe 只打包 PySide6 托盘入口和托盘 Python 代码。
- exe 不打包 Node.js、`dist/manager.js`、`ribiwebgui/dist`、`node_modules` 或运行期 `data`。
- frozen 模式下，`desktop/tray-task-window/main.py` 会从 `Path(sys.executable).parent` 解析项目根目录。
- 如果 manager 已经运行，exe 会复用它；如果 WebGUI 前端产物缺失或过期，exe 会尝试运行 `npm run webgui:build` 修复。
- 如果 manager 没有运行，exe 会先确认/补齐后端和前端构建产物，再启动 `node dist/manager.js`，并拥有该进程的关闭权。
- exe 确认 Manager 健康后会写入 `packaged-desktop` 运行意图并启动同一个生命周期监督器；发布包中的桌面界面缺失时，监督器重新启动 packaged exe，而不是依赖系统 Python。

真实发布 Windows 桌面包前，需要确认：

- `dist/manager.js` 和 `dist/index.js` 已构建。
- `ribiwebgui/dist/index.html` 存在。
- 运行机有 Node.js，或发布包中按统一约定放置了可被启动器发现的 `node.exe`；项目根的便携 `node.exe` 优先于 `RABIROUTE_NODE` 和 PATH，确保本机包不会意外依赖源码盘运行时。
- npm 依赖已经安装，或发布包包含可运行的 `node_modules`。
- `data/route/<configName>/adapterConfig.json` 和 `data/roles/<RoleId>/personaConfig.json` 仍是可写的运行期文件。
- 日志写在 bundled resources 外部。
- 桌面入口永远不能成为唯一受支持的启动路径。

后续可能的打包方向：

- GitHub Releases：`v*` tag 触发 `.github/workflows/release-windows.yml`，在干净的 Windows runner 上运行测试、构建、脱敏检查、安装包冒烟测试并发布资产。
- Windows installer：`installer/RabiRoute.iss` 使用 Inno Setup 生成当前用户级 x64 安装器，内置 RabiRoute Desktop、Manager、WebGUI 和生产依赖；默认安装到 `%LOCALAPPDATA%\Programs\RabiRoute`。
- Portable ZIP：和安装器使用同一份经过检查的 payload，适合免安装验证或手工迁移；发布时一并生成 `SHA256SUMS.txt`。
- Electron shell：只有 WebGUI 真正需要桌面窗口能力时才值得考虑。

本地构建完整发布资产：

```powershell
.\scripts\build-windows-release.ps1
```

默认发布包只构建 RabiRoute 桌面运行所需的 RabiRoute Desktop、其 Manager 后端、WebGUI、Node.js 和生产 npm 依赖，不构建或复制 RabiSpeech Windows 运行时，也不会安装 ASR/TTS Python 依赖或模型。语音插件的公开脚本仍保留在包内；需要语音功能的用户再进入 `plugin-adapters\rabi-speech` 运行 `scripts\install.ps1`，并按需选择模型。

维护者只有在明确要制作包含 RabiSpeech Windows 进程宿主的专用包时才传入：

```powershell
.\scripts\build-windows-release.ps1 -IncludeSpeech
```

这个开关会额外生成并复制带产品名、图标和版本资源的 `plugin-adapters/rabi-speech/runtime/RabiSpeech.exe`。Windows 11 音量合成器依赖这个真实进程映像显示 `RabiSpeech`，仅修改 Core Audio 会话名仍会显示 `Python`。它仍不会把体积较大的 Python 依赖和语音模型塞进安装包；这些内容继续由用户显式安装。构建脚本只复制 Git 跟踪的公开运行资源和所选生成产物，不复制根目录 `data/`、日志、录音、转写、`.env` 或本机配置；然后嵌入固定版本的 Windows x64 Node.js，使用生产依赖启动临时 Manager 做 `/meta` 冒烟测试，最后生成安装器、便携 ZIP 和 SHA-256 清单。

安装与升级边界：

- 安装器在替换文件前、卸载器在删除程序文件前，都只调用本机 `POST /manager/shutdown` 请求优雅停止现有 Manager，不直接杀 Node 进程。
- payload 不含 `data/`；首次启动仍由 Manager 从脱敏的 `examples/data/` 初始化。
- 覆盖安装只更新程序文件，不覆盖本机 route、人格、日志或其他 `data/` 内容。
- 卸载器不主动删除运行期 `data/`，避免误删用户配置；需要彻底清理时由用户确认后手工删除残留目录。
- 当前二进制尚未代码签名，Release 说明必须提示 SmartScreen 的未知发布者警告和 SHA-256 校验方式。
