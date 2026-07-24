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
- 托盘视觉主题与 RibiWebGUI 的 `RabiLight` 保持一致：使用雾蓝页面背景、白色表面、深海军蓝正文、青绿色交互强调、8px 圆角和轻量边框；托盘菜单与面板“更多操作”共用同一套配色。Windows 不再注册 Qt 隐式 `setContextMenu`；表现层 `TrayMenuController` 统一接收左键 `Trigger` 和右键 `Context`，直接调用非阻塞 `QMenu.popup()`，因此两种点击都会立即打开同一个已预热菜单。角色面板也会在托盘图标可点击前完成不可见的 QWidget/原生布局预热，避免首次点击额外承担数百毫秒构造成本；人格菜单项在用户点击回调内先同步显示、置顶并请求激活面板，再于下一轮事件循环应用缓存 DTO 和重建内容，保留 Windows 前台用户手势。菜单内容重建同样延迟到菜单关闭后执行。托盘菜单会把当前人格和最多 5 个人格聊天入口直接展开，其余人格在展开“更多人格”时按需创建；运行、警告和离线状态继续使用独立语义色。
- 托盘与 RibiWebGUI 共用同一个 Rabi Manager 后端。Route 摘要与人格展示信息来自 `/gateways?summary=1`，计划、记忆、角色聊天和头像分别来自 `/api/roles/:roleId/plans`、`/memory`、`/role-panel/messages` 和 `/avatar`；计划审批意见通过 `/api/roles/:roleId/plans/:planId/feedback` 记录。托盘不直接读取 `data/` 或人格文件。完整 API 快照由无 Qt 依赖的 `DesktopRefreshService` 组织，再通过通用 Qt 线程池异步执行；刷新、聊天发送、审批提交、手动触发和退出请求中的 Manager I/O 都不占用主线程，主线程只应用 DTO 和表现结果。隐藏面板不请求聊天或头像、不重建 QWidget；托盘菜单显示期间延迟应用刷新结果；Manager DTO 的表现签名没有变化时不重建人格菜单或重复渲染面板，避免无关后台字段和 10 秒刷新与点击竞争。同一时间只保留一个刷新任务，但不会丢失手动刷新。短暂超时时保留并标记上次快照，Manager 真正离线时仍清空运行状态。
- 计划卡片折叠时按“标题 / 当前步骤 / 触发关键词”三层展示，其中当前步骤优先显示结构化的“第 N 步 · 步骤名”；计划和记忆的触发关键词压缩为动态单行，窗口变宽会显示更多，剩余项只显示为 `……`。展开卡片后隐藏折叠态当前步骤摘要，并显示全部关键词和完整计划详情。
- 计划卡片展开后优先完整列出 `steps`，显示完成数量和进度条，并用“当前执行：第 N 步”及高亮步骤行明确当前位置；步骤不再截断为前 6 项。有步骤时不重复展示 `nextAction`。当前步骤或计划提供 `blockedBy` 时，顶部状态、当前位置和步骤行统一切换为“阻塞中 / 当前阻塞 / 已阻塞”，并额外显示“阻塞原因”。旧计划没有 `steps` 时才保留旧版当前/下一步兼容区。
- 当当前执行步骤、当前进展或当前等待对象明确处于 QA 测试/验收阶段时，计划卡片右上角从绿色“进行中”派生为紫色“待QA测试”。未来尚未开始的 QA 步骤不会让计划提前变色；该颜色只表示仍可能返工的待验收阶段，不回写计划状态。
- 计划顺序由 Rabi Manager 统一返回：先按显示状态排列为“阻塞中 → 待QA测试 → 进行中 → 未开始 → 已完成 → 已归档”，同一状态内按 `updatedAt` 从新到旧；托盘只按 API 顺序渲染，不维护第二套排序规则。
- Manager 判定当前计划/步骤需要审批时，展开卡片会显示与 WebGUI 一致的“最近记录 / 审批建议 / 提交给 Agent”区域。意见关联 `planId` 与 `stepId`，成功后清空输入；记录成功但通知 Agent 失败时保留草稿和同一 `feedbackId` 供重试。该入口不直接推进步骤或改变计划状态。
- 读取角色面板聊天记录，并向当前 Route 发送文字或文件附件；聊天视图按日期分组，每条气泡内显示发送者和时间，文件附件使用紧凑文件行，避免时间戳和嵌套卡片打断对话阅读。输入框会随内容在有限高度内增长，`Enter` 发送，`Shift+Enter` 换行。投递在后台线程等待 Manager 和 Agent adapter 确认，期间窗口仍可切换和查看其它内容；失败时保留输入草稿。
- 角色面板把输入标记为“本地用户”，不会让 Agent 误以为角色在对自己说话；只有 Route 匹配且 Agent adapter 确认 `delivered` 后才显示发送成功，禁用 Route、规则未命中或没有处理端都会明确报失败。
- 计划主体和记忆保持只读；进行中/未归档/已归档计划均可展示，只有 Manager 声明的审批步骤允许追加审批意见。
- 从更多菜单打开人格、计划、记忆、项目和运行状态目录。
- 触发人格规则中声明的 `manual_trigger` 或 `heartbeat` 手动动作。
- 打开 RibiWebGUI、刷新状态，并通过 Manager 优雅退出本地 RabiRoute 运行态。

发送聊天、提交审批建议或触发规则属于显式用户动作。面板不会直接创建、修改、完成、归档或删除计划和记忆文件；审批建议由 Manager 写入独立审计记录，再由 Agent 决定是否更新计划。

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

## 托盘延迟验收

打包版托盘运行后，可以直接测量 Windows 托盘回调到 Qt 菜单窗口真正显示的延迟：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\measure-tray-menu-latency.ps1 -Samples 100
```

脚本不会移动鼠标，也不受 DPI 缩放后的屏幕坐标虚拟化影响。它分别模拟普通左键和右键托盘通知，通过 Windows `EVENT_OBJECT_SHOW` 记录菜单可见时刻；任一路径的 p95 或最大值超过 100ms 时返回失败。

## 数据和消息边界

计划和记忆的文件事实源仍由 Manager 后端拥有：

```text
data/roles/<RoleId>/plans/items/active/*.json
data/roles/<RoleId>/plans/archive/*.json
```

记忆事实源：

```text
data/roles/<RoleId>/memory/recent/*.json
data/roles/<RoleId>/memory/consolidated/*.json
```

托盘不会打开或解析这些文件。它和 RibiWebGUI 一样只消费 Manager HTTP API 返回的 DTO；目录仅用于“打开目录”和诊断展示。角色聊天也通过 Manager API 读取和发送，消息经过当前 Route 的 `rolePanel` 入口、模板和 Agent adapter，不直接写进计划或记忆。

## 生命周期

托盘菜单的 `退出 RabiRoute` 会请求 `POST /manager/shutdown`。Manager 负责停止受管 Gateway 并关闭 HTTP 服务，随后托盘退出。

如果优雅关闭失败，面板不会静默消失。由 Windows 启动器创建且无法响应的 Manager 进程可以由启动器持有的进程句柄结束；独立外部 Manager 不由面板强杀。

## 代码布局

可移植层：

- `ManagerClient`：与 RibiWebGUI 共用的 Manager HTTP 后端客户端；读取 Route、计划、记忆、聊天和头像，并发送消息、触发动作或请求关闭。
- `DesktopRefreshService`：无 Qt 依赖的 API 快照编排，只产出只读 DTO，不读取本地角色文件。
- `desktop_models` / `desktop_read_model`：Manager DTO 到托盘表现模型的转换与可重建缓存。
- `qt_async`：通用 Qt 线程池桥，只负责后台 callable 和主线程结果通知，不包含 Manager 或角色业务逻辑。
- `LifecycleController`：退出决策。
- `TaskWindow`：Route 导航、六个视图、聊天输入和渲染。
- `DesktopAdapter`：通过 Qt 打开 URL、文件和目录。
- `tray_app`：纯表现组合根，负责托盘菜单、窗口装配、缓存应用与用户事件。

平台层包含 Windows 启动器、打包和应用身份。未来 macOS/Linux 入口应复用相同的 Manager HTTP 协议和 Qt 面板，而不是另建一套业务逻辑。
