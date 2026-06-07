# RabiRoute 跨平台任务读取与 Windows 托盘任务窗口方案

## 目标定位

RabiRoute Windows Qt GUI 的准确定位是：**Windows 常驻托盘程序 + 当前任务悬浮窗**。

它不是 RibiWebGUI 的替代品，也不是外部主控台、Agent OS、执行器或完整项目管理台。它更像一个在 Windows 桌面上常驻的轻量入口，用来让用户随时看见当前人格正在记着和关注的任务。

这里讨论的是 RabiRoute 的启动体验之一，而不是把 RabiRoute 本体改成 Windows-only。RabiRoute 的基础启动路径必须继续跨平台保留：Mac / Linux / Windows 都应能通过 Node、CLI 或 npm scripts 启动 manager 和 gateway。Windows 托盘程序只是 Windows 用户更友好的桌面便利入口，最终可以打包成 exe；bat 可以作为辅助脚本，但不能成为唯一入口。

追加核心边界：RabiRoute 本体启动、manager client、task repository、任务目录读取和配置路径解析都必须尽量跨平台。任何 `os.startfile`、`explorer`、开机启动、托盘图标差异、exe 打包等 Windows-only 行为必须隔离在平台适配或入口层，并优先提供 `QDesktopServices` 这类跨平台 fallback，或给出清晰提示。Mac / Linux 可以继续通过 CLI / Node / 源码方式运行基础能力；Windows 只是额外多一个 tray / exe 便利入口。

一句话边界：

```text
RibiWebGUI 管路由配置和运行诊断。
manager/gateway 管消息入口、进程和投递。
Windows 托盘程序管桌面入口、当前任务展示和轻量打开动作。
人格任务事实源放在 data/roles/<RoleId>/ 下。
跨平台 CLI / npm scripts 保留 RabiRoute 本体启动能力。
```

## 用户确认方向

Qt 托盘程序围绕以下方向设计：

- Windows 常驻托盘。
- 右键菜单可以直接打开 RabiRoute WebGUI。
- 右键菜单可以打开当前任务悬浮窗。
- 可以通过托盘程序查看和轻量管理当前人格任务。
- 悬浮窗重点展示当前任务，同时能看到长期任务、短期任务入口或摘要。
- 任务系统跟随人格目录，例如 `<repo>\data\roles\Rabi\`。
- 任务数据不要放到 Qt Resources，也不要放到程序安装资源目录。
- 它不替代外部主控台，不替代 WebGUI 的完整管理台。
- 它不替代 Mac / Linux 的基础启动路径；Windows exe 是额外入口。

## 启动方式分层

RabiRoute 本体启动方式应分层设计：

```text
跨平台基础入口
  npm run start:manager
  npm run manager
  node dist/manager.js
  未来可补 rabiroute CLI

Windows 辅助入口
  start-rabiroute-manager.cmd
  其他 bat / PowerShell helper

Windows 桌面便利入口
  RabiRoute Tray exe
  PySide6 源码开发入口
```

原则：

- manager / gateway 的核心启动逻辑保持 Node 跨平台，不依赖 Qt。
- Windows 托盘程序可以检测并启动 manager，但不改变 manager 的跨平台实现。
- Windows exe 负责用户友好，不负责成为唯一运行方式。
- bat 适合作为开发和排障辅助，不应是最终用户唯一入口。
- Mac / Linux 不需要托盘 exe，也仍应能通过 npm scripts / Node / CLI 使用 RabiRoute。
- Qt 代码里的任务读取、manager HTTP client、路径解析尽量跨平台；只有托盘、exe 打包、Windows 开机启动等放在平台层。
- 打开目录时优先使用 `QDesktopServices` 等跨平台桌面服务；不要把 `os.startfile` 或 `explorer` 写进任务仓储、manager client 或路径解析层。

## 当前调查结论

当前仓库还没有 Windows / Qt / PySide / PyQt / QSystemTrayIcon / 桌面入口代码。现有可复用部分是：

- manager API：`http://127.0.0.1:8790/meta`、`/gateways`、`/gateways/<id>/start|stop|restart`。
- WebGUI 入口：`http://127.0.0.1:8790/`。
- 路由运行配置：`data/route/<configName>/routeConfig.json`。
- 路由运行状态：`data/route/<configName>/gateway-status.json`。
- Codex 线程状态：`data/route/<configName>/codex-state.json`。
- 人格目录：`data/roles/<RoleId>/`。
- Rabi 默认人格目录：`<repo>\data\roles\Rabi\`。

当前 `data/roles/Rabi/tasks/` 已存在，包含 `items/`、`inbox/`、`archive/` 和 `README.md`。其中 `items/long-term/`、`items/short-term/`、`items/project-linked/` 已作为任务事实源目录预留，但当前尚未发现已确认的正式任务 JSON。Qt 端应保持只读消费，不抢先发明写入结构；没有正式任务 JSON 时显示“任务目录已初始化但暂无可展示任务”的空状态。

另外，仓库外的个人笔记目录下已有两份相关笔记，可作为历史上下文参考：

- `rabiroute-windows-qt-gui-plan.md`：确认 PySide6 / Qt 托盘 / 悬浮任务窗路线。
- `rabiroute-floating-task-window-notes.md`：记录悬浮窗和人格任务机制的口头需求。

本仓库内的实现安排以当前文档为准，外部笔记只作为背景材料。

## 窗口形态

### 托盘程序

托盘程序是主形态。启动后默认不弹出大窗口，只在 Windows 通知区域显示 RabiRoute 图标。

建议图标状态：

- 正常：manager 可连接，当前 gateway 正常运行。
- 警告：manager 可连接，但 gateway 停止、NapCat 未连接或任务目录读取异常。
- 离线：manager 不可连接。

托盘提示文字建议包含：

```text
RabiRoute / 当前人格
Manager: 已连接
Gateway: 运行中
当前任务: 1
短期任务: 3
长期任务: 5
```

### 当前任务悬浮窗

当前任务悬浮窗是一个小型桌面任务面板，而不是配置后台。

建议行为：

- 默认宽度 360-460px。
- 默认贴靠屏幕右侧或右下角。
- 可置顶。
- 可隐藏到托盘。
- 可刷新。
- 可打开 WebGUI、人格任务目录、当前任务文件和项目目录。

建议内容层级：

```text
顶部：当前人格 / gateway 状态
主体：当前任务
次级：短期任务摘要
次级：长期任务摘要
底部：打开 WebGUI / 打开任务目录 / 刷新
```

当前任务卡片至少显示：

- 标题。
- 状态。
- 优先级。
- 当前步骤。
- 下一步。
- 关联项目目录。
- 更新时间。
- 来源或创建原因。

短期任务和长期任务区域先显示摘要和计数，点击后再展开或打开任务目录。

## 托盘右键菜单

MVP 菜单：

```text
RabiRoute / 当前人格
状态：Manager 已连接 / 未连接
打开 RabiRoute WebGUI
显示/隐藏当前任务悬浮窗
刷新任务
打开当前人格任务目录
打开当前人格目录
打开当前项目目录
打开运行状态目录
退出
```

后续可扩展菜单：

```text
Manager
  启动 Manager
  重启当前 Gateway
  查看运行日志

任务
  当前任务
  短期任务
  长期任务

人格
  切换当前人格
  打开 persona.md
  打开 growth.md
```

MVP 阶段不建议在菜单中加入“新建任务”“完成任务”“删除任务”等写操作，避免与任务系统规范冲突。

## 任务目录读取方式

最终任务事实源必须跟随人格目录：

```text
<repo>\data\roles\Rabi\tasks\
```

推荐抽象为：

```text
data/roles/<RoleId>/tasks/
```

Qt 托盘程序通过当前 gateway 的 `agentRoleId` 找到人格 ID，再从 `rolesDir` 定位人格目录。

读取顺序建议：

1. 调用 manager `/gateways`，获取当前 gateway、`agentRoleId`、`rolesDir`、`codexCwd`、运行态和角色列表。
2. 定位 `data/roles/<RoleId>/tasks/`。
3. 如果任务目录存在，按任务规范读取当前任务、短期任务、长期任务。
4. 如果任务目录不存在，显示空状态：任务规范尚未初始化。
5. 临时兼容时可以只读 `data/route/<configName>/codex-state.json` 中的 `todoNotes`，但必须标记为运行态补充，不作为正式任务事实源。

任务文件格式由任务系统规范决定。Qt 端只消费结构，不把格式写死到 UI 逻辑深处。建议等规范落地后支持一个聚合索引，例如：

```text
tasks/index.json
tasks/current.json
tasks/short-term.json
tasks/long-term.json
```

或：

```text
tasks/current/*.json
tasks/short-term/*.json
tasks/long-term/*.json
```

无论最终形态如何，Qt 端都应通过一个 `TaskRepository` 读取层适配，避免 UI 直接散落文件解析。

## 最小 MVP

MVP 只做只读桌面入口。

功能范围：

- 启动后常驻 Windows 托盘。
- 右键菜单打开 RibiWebGUI。
- 右键菜单显示/隐藏当前任务悬浮窗。
- 读取 manager `/meta` 和 `/gateways`。
- 显示 manager 是否连接。
- 显示当前 gateway 是否运行。
- 显示当前人格 ID 和人格目录。
- 读取 `data/roles/Rabi/tasks/`，若目录不存在或尚无正式任务 JSON，则展示清楚空状态。
- 展示当前任务、短期任务摘要、长期任务摘要。
- 打开人格任务目录。
- 打开人格目录。
- 打开当前项目目录 `codexCwd`。
- 手动刷新。

MVP 启动策略：

- 不改动现有 `npm run start:manager`、`npm run manager`、`node dist/manager.js`。
- Windows 托盘程序启动后先探测 `http://127.0.0.1:8790`。
- manager 已运行时只连接和展示状态。
- manager 未运行时，MVP 阶段可以先提示用户打开 WebGUI/启动 manager；后续再由托盘程序提供受控启动。
- 打包 exe 作为 Windows 友好入口排到后续阶段，不在 MVP 中强行完成。

MVP 明确不做：

- 不编辑 RibiWebGUI 配置。
- 不修改 `routeConfig.json`。
- 不修改 `roleMessageConfig.json`。
- 不创建、完成、删除任务。
- 不发送 QQ / NapCat 消息。
- 不启动外部主控台。
- 不直接管理 Codex 线程。
- 不把任务数据写入 Qt Resources。

## 与 WebGUI / manager / gateway 的边界

### WebGUI

WebGUI 继续负责：

- 路由配置编辑。
- 人格配置和模板规则编辑。
- gateway 启停和运行日志查看。
- NapCat、heartbeat、webhook 等运行诊断。
- Agent 绑定诊断。

托盘程序只提供打开 WebGUI 的入口，以及少量状态摘要。

### manager

manager 继续负责：

- 读取 `data/route` 和 `data/roles`。
- 启动、停止和守护 gateway 进程。
- 提供 WebGUI 静态资源和 API。
- 汇总 gateway runtime status。
- 保持跨平台启动和运行，不因 Windows 托盘程序引入 Windows-only 依赖。

托盘程序可以消费 manager API。后续如果任务目录规范稳定，可以让 manager 增加只读任务 API，例如：

```text
GET /roles/:roleId/tasks
GET /tasks?roleId=Rabi
```

但 MVP 可以先本地文件只读。

### gateway

gateway 继续负责：

- 消息接收。
- 事件记录。
- 路由判断。
- 模板包装。
- Agent adapter 投递。

托盘程序不参与消息路由，不改变 route decision，不向 QQ/NapCat 外发。

### 外部主控台

外部主控台或更完整的个人 Agent 工作台继续负责：

- 跨项目任务调度。
- 复杂任务执行。
- Agent 会话编排。
- 审批、草稿、发布、自动化动作。

托盘程序只是桌面入口和轻量任务状态窗。

## 后续实现步骤

### 阶段 1：文档和规范对齐

- 完成本方案文档。
- 等待或对齐 `data/roles/Rabi/tasks/` 任务规范。
- 明确当前任务、短期任务、长期任务的文件结构。
- 明确任务字段：`id`、`title`、`status`、`priority`、`kind`、`currentStep`、`nextAction`、`projectPath`、`source`、`dueAt`、`updatedAt`。

### 阶段 2：Qt 只读 MVP

建议使用 PySide6 或 PyQt6，实现成本低，适合快速验证。

当前已按 PySide6 方向创建最小骨架，原因是它直接使用 Qt 的 `QSystemTrayIcon`、`QMenu` 和普通 QWidget，最贴近“Windows 常驻托盘 + 当前任务悬浮窗”的目标，也不会影响现有 Node manager / Vue WebGUI 架构。

骨架中的 manager client 和 task repository 应保持跨平台：只做 HTTP 请求、`pathlib` 路径解析和 JSON 读取。Windows 专属能力，例如 exe 打包、开机启动、通知区域行为差异，放到托盘入口和后续 packaging 层。

```text
desktop/tray-task-window/
```

最小模块：

```text
main.py
manager_client.py
task_repository.py
tray_app.py
task_window.py
```

实际骨架模块：

```text
desktop/tray-task-window/main.py
desktop/tray-task-window/requirements.txt
desktop/tray-task-window/rabiroute_tray/manager_client.py
desktop/tray-task-window/rabiroute_tray/task_repository.py
desktop/tray-task-window/rabiroute_tray/task_window.py
desktop/tray-task-window/rabiroute_tray/tray_app.py
```

依赖尚未安装。运行前需要人工确认并安装：

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

阶段目标：

- 能跑托盘。
- 能打开 WebGUI。
- 能打开悬浮窗。
- 能读取任务目录并显示空状态或任务列表。

### 阶段 3：轻量操作

- 支持打开任务文件。
- 支持打开项目目录。
- 支持按状态筛选。
- 支持置顶、贴边、记住窗口位置。
- 支持定时刷新和文件变更刷新。
- 支持托盘图标状态变化。

仍然建议保持只读，直到任务系统写入规范稳定。

### 阶段 4：manager 集成

- manager 增加只读任务 API。
- Qt 端优先读 manager API，manager 不可用时降级读本地文件。
- WebGUI 可以增加同源任务页，但不要求 Qt 等它完成。
- manager API 和任务文件读写保持跨平台，不依赖 Windows 托盘程序。

### 阶段 5：受控写操作

等任务系统规范稳定后，再考虑：

- 标记任务完成。
- 推迟任务。
- 添加备注。
- 设置当前任务。

所有写操作必须写回 `data/roles/<RoleId>/tasks/` 规范位置，并留下更新时间和来源，不写到 Resources。

### 阶段 6：Windows 友好发布入口

- 用 PyInstaller / Nuitka 或同类方案打包 Windows 托盘 exe。
- exe 只作为 Windows 桌面入口，不替代 `npm run start:manager`。
- bat / PowerShell helper 保留为排障和开发辅助。
- 打包说明必须写清楚 Node manager 的依赖策略：使用现有项目 Node 环境、携带 dist，或未来提供完整安装包。
- Mac / Linux 继续使用基础 CLI / npm scripts / Node 启动；如未来要做桌面入口，再另行设计平台适配。

## 风险和红线

- 不要把托盘程序做成第二个 WebGUI。
- 不要把任务事实源放到 Qt Resources、安装目录或临时缓存。
- 不要在任务规范未定时提前实现写操作。
- 不要让 Qt 端绕过 manager 去启动复杂后台流程。
- 不要通过托盘程序直接外发 QQ / NapCat 消息。
- 不要把 Codex 线程状态当成正式任务数据库；`codex-state.json` 只能做临时补充来源。
- 不要把 Windows exe 做成 RabiRoute 唯一启动方式。
- 不要为了托盘程序破坏 Mac / Linux 的 Node manager 启动路径。

## 建议下一步

下一步继续对齐 `data/roles/Rabi/tasks/` 的正式任务 JSON 规范，并在保持只读边界的前提下扩展展示字段。Windows exe 打包作为便利发布入口排在 MVP 验证之后；Mac / Linux 仍保留 CLI / Node / 源码方式运行基础能力。
