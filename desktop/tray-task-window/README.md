<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Qt 角色面板

> 状态：当前桌面便利入口。面板已实现并随 Windows 启动器使用，但不替代 Manager、RibiWebGUI 或 Codex/ChatGPT Desktop。

这是 RabiRoute 的 PySide6/Qt 托盘与浮动角色面板。它读取 Manager、Route、计划和记忆状态，也可以通过 `rolePanel` 消息端向当前 Route 绑定的 Agent 发送文字和文件附件。

Qt 面板本身尽量保持跨平台。Windows 启动器与打包边界以 [`docs/windows-launcher-and-packaging.md`](../../docs/windows-launcher-and-packaging.md) 为准。

## 当前能力

- 支持系统托盘；无托盘环境退化为普通浮动窗口。
- 按项目根目录保持单实例，避免重复托盘图标和面板。
- 从 Manager 读取 Route 列表、启停状态和角色绑定。
- 初次打开时优先选择唯一启用的 Route；只有启用项不唯一时才沿用 `Rabi` 人格或列表首项作为兼容回退，避免面板默认落到已禁用的其它人格。
- 在左侧切换 Route，并显示 `聊天`、`当前`、`计划`、`近期记忆`、`已归档` 和 `诊断` 六个视图。
- 六个视图都在一级导航中直接可见；`当前` 按“进行中计划 / 近期记忆”分区，`诊断` 使用只读表格展示状态和目录。
- 托盘视觉主题与 RibiWebGUI 的 `RabiLight` 保持一致：使用雾蓝页面背景、白色表面、深海军蓝正文、青绿色交互强调、8px 圆角和轻量边框；运行、警告和离线状态继续使用独立语义色。
- 计划和记忆卡片折叠时把触发关键词压缩为动态单行，窗口变宽会显示更多，剩余项只显示为 `……`；展开卡片后显示全部关键词。
- 计划卡片展开后优先完整列出 `steps`，显示完成数量和进度条，并用“当前执行：第 N 步”及高亮步骤行明确当前位置；步骤不再截断为前 6 项。有步骤时不重复展示 `nextAction`。当前步骤或计划提供 `blockedBy` 时，顶部状态、当前位置和步骤行统一切换为“阻塞中 / 当前阻塞 / 已阻塞”，并额外显示“阻塞原因”。旧计划没有 `steps` 时才保留旧版当前/下一步兼容区。
- 读取角色面板聊天记录，并向当前 Route 发送文字或文件附件。
- 角色面板把输入标记为“本地用户”，不会让 Agent 误以为角色在对自己说话；只有 Route 匹配且 Agent adapter 确认 `delivered` 后才显示发送成功，禁用 Route、规则未命中或没有处理端都会明确报失败。
- 只读展示进行中/未归档/已归档计划，以及近期/沉淀记忆。
- 从更多菜单打开人格、计划、记忆、项目和运行状态目录。
- 触发人格规则中声明的 `manual_trigger` 或 `heartbeat` 手动动作。
- 打开 RibiWebGUI、刷新状态，并通过 Manager 优雅退出本地 RabiRoute 运行态。

发送聊天或触发规则属于显式用户动作。面板不会直接创建、修改、完成、归档或删除计划和记忆文件。

## 不负责什么

- 不替代 `npm run start:manager` 或 `node dist/manager.js`。
- 不承担真实 Codex prompt 的执行；真实消息仍由 Desktop IPC 投给已加载任务。
- 不发送 QQ/NapCat 消息，也不绕过 Route policy。
- 不提供新的 MCP server、控制端口或独立任务 Runtime。
- 不把 RabiRoute 变成 Windows-only 应用。

## 安装与运行

需要 Python 3 和 PySide6：

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

独立启动面板，只连接已经运行的 Manager：

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790
```

如果缺少 PySide6，入口会显示安装提示。关闭独立模式面板不会主动停止一个外部启动的 Manager。

Windows 的“Manager + 托盘”启动入口：

```powershell
Start-RabiRoute-Tray.bat
```

项目本体仍可独立启动：

```powershell
npm run start:manager
```

## 数据和消息边界

计划事实源：

```text
data/roles/<RoleId>/plans/items/active/*.json
data/roles/<RoleId>/plans/archive/*.json
```

记忆事实源：

```text
data/roles/<RoleId>/memory/recent/*.json
data/roles/<RoleId>/memory/consolidated/*.json
```

面板对这些目录只读。角色聊天通过 Manager API 读取和发送，消息经过当前 Route 的 `rolePanel` 入口、模板和 Agent adapter，不直接写进计划或记忆。

## 生命周期

托盘菜单的 `退出 RabiRoute` 会请求 `POST /manager/shutdown`。Manager 负责停止受管 Gateway 并关闭 HTTP 服务，随后托盘退出。

如果优雅关闭失败，面板不会静默消失。由 Windows 启动器创建且无法响应的 Manager 进程可以由启动器持有的进程句柄结束；独立外部 Manager 不由面板强杀。

## 代码布局

可移植层：

- `ManagerClient`：状态、聊天、手动触发和关闭 API。
- `PlanRepository`、`RoleContextRepository`：只读计划、记忆和状态摘要。
- `LifecycleController`：退出决策。
- `TaskWindow`：Route 导航、六个视图、聊天输入和渲染。
- `DesktopAdapter`：通过 Qt 打开 URL、文件和目录。
- `tray_app`：托盘菜单、刷新循环与窗口装配。

平台层包含 Windows 启动器、打包和应用身份。未来 macOS/Linux 入口应复用相同的 Manager HTTP 协议和 Qt 面板，而不是另建一套业务逻辑。
