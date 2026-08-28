<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Desktop

> 状态：当前 Windows 桌面应用。系统托盘与任务窗口是 RabiRoute Desktop 的界面，Manager 是同一应用使用的本机后端。

这是 RabiRoute Desktop 的 PySide6/Qt 界面。它读取 Manager、Route、计划和记忆状态，也可以通过 `rolePanel` 消息端向当前 Route 绑定的 Agent 发送文字和文件附件。

Qt 面板本身尽量保持跨平台。Windows 启动器与打包边界以 [`docs/windows-launcher-and-packaging.md`](../../docs/windows-launcher-and-packaging.md) 为准。

## 当前能力

- 支持系统托盘；无托盘环境退化为普通浮动窗口。
- 按项目根目录保持单实例，避免重复托盘图标和面板。
- 从 Manager 读取 Route 列表、启停状态和角色绑定。
- 初次打开时优先选择唯一启用的 Route；只有启用项不唯一时才沿用 `Rabi` 人格或列表首项作为兼容回退，避免面板默认落到已禁用的其它人格。
- 在左侧切换 Route，并显示 `聊天`、`当前`、`计划`、`近期记忆`、`已归档` 和 `诊断` 六个视图。
- 六个视图都在一级导航中直接可见；`当前` 按“进行中计划 / 近期记忆”分区，`诊断` 使用只读表格展示状态和目录。
- Desktop 从 Manager 插件目录启用托盘命令、面板操作、系统划词、系统截图、剪贴板贴图快捷键和 `system` / `light` / `dark` / `custom:*` 主题。内置合同与显式允许的可信扩展使用同一个 Registry；只有活动插件声明且本机已注册的合同会生效。插件停用后，对应托盘入口、面板操作和系统监听会撤销。目录不可用或刷新失败时立即撤销旧贡献和系统监听，并保留固定“打开 RabiRoute WebGUI”恢复入口；目录成功加载后只显示活动插件贡献的 WebGUI 入口。实际快捷键仍读取“设置”中保存的值，目录缺失或声明不受支持时不会注册对应快捷键，主题回退为系统主题。
- 托盘视觉主题与 RibiWebGUI 的 `RabiLight` 保持一致：使用雾蓝页面背景、白色表面、深海军蓝正文、青绿色交互强调、8px 圆角和轻量边框；托盘菜单与面板“更多操作”共用同一套配色。Windows 不再注册 Qt 隐式 `setContextMenu`；表现层 `TrayMenuController` 统一接收左键 `Trigger` 和右键 `Context`，直接调用非阻塞 `QMenu.popup()`，因此两种点击都会立即打开同一个已预热菜单。角色面板也会在托盘图标可点击前完成不可见的 QWidget/原生布局预热，避免首次点击额外承担数百毫秒构造成本；人格菜单项在用户点击回调内先同步显示、置顶并请求激活面板，再于下一轮事件循环应用缓存 DTO 和重建内容，保留 Windows 前台用户手势。菜单内容重建同样延迟到菜单关闭后执行。托盘菜单会把当前人格和最多 5 个人格聊天入口直接展开，其余人格在展开“更多人格”时按需创建；运行、警告和离线状态继续使用独立语义色。
- 托盘与 RibiWebGUI 共用同一个 Rabi Manager 后端。Route 摘要与人格展示信息来自 `/gateways?summary=1`，计划、记忆、角色聊天和头像分别来自 `/api/roles/:roleId/plans`、`/memory`、`/role-panel/messages` 和 `/avatar`；计划审批意见通过 `/api/roles/:roleId/plans/:planId/feedback` 记录。托盘不直接读取 `data/` 或人格文件。API 快照由无 Qt 依赖的 `DesktopRefreshService` 组织，再通过通用 Qt 线程池异步执行；刷新、聊天发送、审批提交、手动触发和退出请求中的 Manager I/O 都不占用主线程。隐藏面板只请求轻量 Manager/Route 摘要，不请求计划、记忆、聊天或头像，也不重建 QWidget，避免 10 秒托盘刷新反复触发大角色数据读取；托盘菜单显示期间延迟应用刷新结果；Manager DTO 的表现签名没有变化时不重建人格菜单或重复渲染面板。同一时间只保留一个刷新任务，但不会丢失手动刷新。短暂超时时保留并标记上次快照，Manager 真正离线时仍清空运行状态。
- `/gateways?summary=1` 只含人格标识、路径、头像和从文件开头提取的轻量标题等展示元数据，不读取或传输完整 persona Markdown 正文，避免 10 秒刷新重复搬运大块 persona 内容。
- 计划卡片折叠时按“标题 / 当前步骤 / 触发关键词”三层展示，其中当前步骤优先显示结构化的“第 N 步 · 步骤名”；计划和记忆的触发关键词压缩为动态单行，窗口变宽会显示更多，剩余项只显示为 `……`。展开卡片后隐藏折叠态当前步骤摘要，并显示全部关键词和完整计划详情。
- 计划卡片展开后优先完整列出 `steps`，显示完成数量和进度条，并用“当前执行：第 N 步”及高亮步骤行明确当前位置；步骤不再截断为前 6 项。有步骤时不重复展示 `nextAction`。只有 Manager 返回 `presentation.tone=blocked` 时，顶部状态、当前位置和当前步骤行才统一切换为“阻塞中 / 当前阻塞 / 已阻塞”并显示原因；原始 `blockedBy` 文本不会让托盘自行标红。旧计划没有 `steps` 时才保留旧版当前/下一步兼容区。
- 只有 Manager 的结构化当前步骤为进行中的 `qa-* / verify-*` 时，计划卡片右上角才显示紫色“等待 QA”。未来尚未开始的 QA 步骤、实施步骤正文里的“QA 门禁”或“尚未通知 QA”都不会让计划提前变色；托盘不扫描自由文本关键词。该实施/打包/QA 流程只适用于代码、Prefab、资源、配置等会改变项目内容的计划，调查、设计评审、运营、资料收集、外部依赖与控制面维护保留真实流程。
- 计划分类、阶段汇总、顺序、状态色板与审批合同都由 Rabi Manager 统一返回：`presentation.views` 决定 `current / plans / archived` 归属，`status / tone / statusLevel / sortBucket / palette` 决定标签、颜色和排序桶，`counts.stages` 提供各展示阶段计数；完整待审批合同全局置顶，随后按“待审批 → 等待 QA → 待人工核验 → 进行中 → 等待打包 → 已完成 → 已归档 → 暂停”和 `updatedAt` 排列。外部等待原因只保留在内部字段；暂停只在“计划”显示并绝对排在最后。托盘只按 API DTO 渲染，不维护第二套阶段识别、分类、排序、状态颜色或合同判断规则。
- Manager 判定当前计划/步骤需要审批时，展开卡片展示 Manager 返回的审批合同和缺项。`incomplete/enabled=false` 时显示“审批资料不完整/禁止审批”并禁用输入与提交；只有 `ready/enabled=true` 才允许提交。提交只等待 Manager 落盘，默认 5 秒请求边界；返回 `pending` 后立即结束 loading，Agent 通知在后台继续。意见关联 `planId` 与 `stepId`，记录失败时可用同一 `feedbackId` 重试。该入口不直接推进步骤或改变计划状态。
- 读取角色面板聊天记录，并向当前 Route 发送文字或文件附件；聊天视图按日期分组，每条气泡内显示发送者和时间，文件附件使用紧凑文件行，避免时间戳和嵌套卡片打断对话阅读。输入框会随内容在有限高度内增长，`Enter` 发送，`Shift+Enter` 换行。投递在后台线程等待 Manager 和 Agent adapter 确认，期间窗口仍可切换和查看其它内容；失败时保留输入草稿。
- 角色面板把输入标记为“本地用户”，不会让 Agent 误以为角色在对自己说话；只有 Route 匹配且 Agent adapter 确认 `delivered` 后才显示发送成功，禁用 Route、规则未命中或没有处理端都会明确报失败。
- 活动插件提供 `desktop.system-selection` 后，WebGUI“设置”页打开“开启滑词菜单”即可在 Windows 软件中用鼠标拖选，或用 `Shift` + 方向键 / `Home` / `End` / `PageUp` / `PageDown` 扩选文字。悬浮条按选区范围横向居中：鼠标向上拖选时优先显示在上方，向下或同一行拖选时优先显示在下方。键盘扩选优先合并扩选前后的系统插入符范围；Unity 没有系统插入符时，使用同一窗口最近一次点击位置，避免悬浮条跑到窗口角落。把光标移到“投递至”，会显示当前已启用且运行中的人格列表，点击其中一项后复用角色面板消息投递到对应 Route。划选本身不执行动作。普通软件通过 UI Automation 读取文字和选区矩形；Unity 编辑器无法提供该选区时，才临时发送受保护的 `Ctrl+C`，等待编辑器更新剪贴板，读取后恢复原剪贴板。密码控件和仍无法读取的选区直接忽略。“滑词朗读”是滑词菜单的子功能：开启时左侧显示“朗读”，点击后进入 RabiSpeech 主机 FIFO；关闭后悬浮条只保留“投递至”。只有同时开启“滑词朗读”和“高级选项”，才可选择 TTS 模型。
- 在 WebGUI“设置”中启用系统截图并配置快捷键后，任意软件都可以框选截图。截图窗口会先打开，画面不会整体变暗，可直接框选；光标移到窗口上会显示可选范围和尺寸，图片就绪后窗口以外的画面会变暗，窗口本身保持原亮度；此时该窗口已是当前操作区域，可直接按 `Enter` / `Ctrl+C` 复制、按 `F2` 发送或按贴图快捷键贴图。单击左键也可保留整个窗口作为待确认选区；拖拽后选区以外的画面变暗，选区内保持原亮度，可在选区内拖动调整位置，选区大小保持不变。图片尚未准备完时的复制、贴图或发送会在就绪后继续。拖拽只创建待确认选区：按 `Enter` 或 `Ctrl+C` 复制，按 `F2` 发送，按贴图快捷键确认并贴图；默认在确认贴图或发送时也复制到剪贴板，可在设置中关闭，关闭后仍可按 `Ctrl+C` 或点击“复制”。`Ctrl+A` 选择整个屏幕。未框选时，光标右下角会跟随显示当前静态画面的 10 倍像素采样预览、当前颜色块和 HTML 颜色代码 `#RRGGBB`；按 `C` 直接复制该代码，不确认选区、不写入截图历史，也不弹通知。按鼠标右键、`Esc` 或直接关闭截图窗口会取消本次截图，不写入截图历史。复制、贴图或发送才会保存这张截图和框选区域。截图窗口中 `<` / `>` 切换已保存的上一张和下一张屏幕截图；“贴图快捷键”默认 `Ctrl+Alt+V`，也可以明确设置 `F3`：截图窗口打开且已框选区域时，直接贴出该区域；其他时候贴出剪贴板中的图片。贴图会按框选区域的原位置和大小显示；拖动、缩放和透明度会在 RabiRoute Desktop 重启后恢复，关闭单个贴图才删除。截图窗口切换历史截图时，会恢复该截图最后一次用于复制、贴图或发送的框选区域。发送仍复用角色面板入口，Codex/DSH 会把图片作为真实图片输入接收。截图保存在项目私有 `.rabiroute-message-images/`，贴图和区域记录保存在私有 `data/desktop/`，不会写入公开示例。
- 多显示器时，触发截图快捷键会先取得每块显示器各自的原生像素截图并显示缩略图选择；选中后只在该显示器的本地画布框选，不拼接不同 DPI 的虚拟桌面。历史截图会按其保存时的显示器位置重新打开。
- YeYu 桌宠从 Manager 读取受限动作包和人格绑定，支持 GIF / PNG 序列、拖动位置、缩放、置顶、锁定、点击穿透、气泡与全屏自动隐藏。动作包可用 `idleBehavior` 配置普通待机中的随机一次性动作，以及长时间无工作或交互后进入的循环睡眠；随机动作播完回到 `idle`，且不会重置长时空闲计时。点击、拖动、打开人格页或当前人格的 `work_ended` 会唤醒并重新计时；实际拖动期间播放 `drag`，松手后恢复拖动前状态，双击打开 YeYu 人格面板。只有带 `personaId=YeYu` 的 `work_ended` 事件会触发成功或担心动作，普通任务状态和人格文件不会由桌宠直接改写。资源包导入与设置均在 WebGUI 经 Manager 完成，Qt 不直接扫描或修改 `data/roles/YeYu/desktop-pet/`；Windows 本机包可以在 `data/cache/desktop-pet-roles/` 保留当前绑定动作包的可重建缓存，避免高频 PNG 读取耗尽 NAS 句柄，人格与动作包真源仍在共享角色目录。桌宠运行请求使用 `scope=runtime`，只枚举本机缓存；设置与导入继续使用完整目录，仍可发现 NAS 上的其他动作包。
- 截图框选确定后，还可拖动四角和四边中点调整范围；工具栏支持矩形框、箭头与多行文字标注，使用红、黄、绿、蓝四种颜色。文字可移动、调整范围、双击再次编辑并调整字号；按 `Ctrl+Z` 撤销最后一笔，复制、贴图或发送会将标注写入图片。
- “设置 → Windows 登录启动”会同步当前用户的 Startup 快捷方式；关闭后移除该快捷方式。截图开关、截图快捷键、贴图快捷键和登录启动配置修改后由托盘监听文件变化，不需要重启托盘。
- 计划主体和记忆保持只读；进行中/未归档/已归档计划均可展示，只有 Manager 声明的审批步骤允许追加审批意见。
- 活动插件提供对应面板命令时，从更多菜单打开人格、计划、记忆、项目和运行状态目录。
- `manager:gateway-runtime` 的手动触发命令活动时，显示并执行人格规则中声明的 `manual_trigger` 或 `heartbeat` 动作。
- 插件目录不可用或刷新失败时撤销旧贡献，并通过固定恢复入口打开 RibiWebGUI；目录可用后由活动插件贡献该入口。刷新状态和通过 Manager 优雅退出仍由 Desktop 固定控制。

发送聊天、提交审批建议或触发规则属于显式用户动作。面板不会直接创建、修改、完成、归档或删除计划和记忆文件；审批建议由 Manager 写入独立审计记录，再由 Agent 决定是否更新计划。

## 不负责什么

- 不替代 `npm run start:manager` 或 `node dist/manager.js`。
- 不承担真实 Codex prompt 的执行；真实消息仍由 Desktop IPC 投给已加载任务。
- 不发送 QQ/NapCat 消息，也不绕过 Route policy。
- 不提供新的 MCP server、控制端口或独立任务 Runtime。
- 不把 RabiRoute 变成 Windows-only 应用。

## 安装与运行

需要 Python 3、PySide6 和 Windows UI Automation Python 适配层：

```powershell
py -m pip install -r desktop\tray-task-window\requirements.txt
```

独立启动面板，只连接已经运行的 Manager：

```powershell
py desktop\tray-task-window\main.py --manager-url http://127.0.0.1:8790
```

如果缺少 PySide6，入口会显示安装提示。关闭独立模式面板不会主动停止一个外部启动的 Manager。

### 可信 Desktop 扩展

可信 Python 包通过 `rabiroute.desktop_extensions` entry point 暴露注册函数。安装扩展不会自动启用它；启动时必须逐项加入显式允许列表：

```powershell
py desktop\tray-task-window\main.py `
  --trusted-desktop-extension example-extension `
  --trusted-desktop-extension another-extension
```

每个允许的 entry point 在 Desktop 启动阶段接收同一个 `DesktopExtensionRegistry`，可以注册命令处理器、面板动作提供器、生命周期能力、快捷键、主题、状态卡片和设置区合同。全部注册函数返回后，Desktop 冻结 Registry；运行中新增、替换或重复注册合同会被拒绝。未列入 `--trusted-desktop-extension` 的已安装包不会被导入。

这些 entry point 是与 Desktop 同进程运行的受信任代码，可以访问当前 Python 进程；面向不可信代码的进程隔离由后续 Extension Host 提供。

Manager 插件目录决定合同何时激活。面板目录操作使用 `desktop.open-role-directory`、`desktop.open-plan-directory`、`desktop.open-memory-directory`、`desktop.open-project-directory` 和 `desktop.open-runtime-directory`；手动触发使用 `desktop.manual-trigger`，系统划词使用 `desktop.system-selection`。这些命令或能力撤销后，Desktop 同步移除入口并停止对应监听。

Windows 的“Manager + 托盘”启动入口：

```powershell
Start-RabiRoute-Desktop.bat
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

RabiRoute Desktop 菜单的 `退出 RabiRoute` 会请求 `POST /manager/shutdown` 并携带明确的桌面退出标记。Manager 先把私有运行期意图原子写成 `stopped`，再停止受管 Gateway 并关闭 HTTP 服务，随后桌面界面退出。写入失败时界面保持可见，不能留下仍标记为 `running` 的监督器去反向复活进程。

Manager 暂时离线时，RabiRoute Desktop 界面保留入口、显示离线状态并继续重连，不再因连续探测失败自行退出。由 Windows 启动器或打包版 RabiRoute Desktop 建立的完整桌面运行态会同时启动 `scripts/watch-rabiroute-desktop-lifecycle.ps1`；它只维护桌面后端与界面的共同运行态，连续确认任一部分缺失后通过现有安全启动门禁恢复完整桌面运行态。QQ、NapCat、Route 和 Adapter 的巡检不属于这个监督器。

如果优雅关闭失败，界面不会静默消失，也不会强杀 Manager。普通 `npm run start:manager` 是开发或跨平台后端入口，不会隐式创建 RabiRoute Desktop 或监督器。

## 代码布局

可移植层：

- `ManagerClient`：与 RibiWebGUI 共用的 Manager HTTP 后端客户端；读取 Route、计划、记忆、聊天和头像，并发送消息、触发动作或请求关闭。
- `DesktopRefreshService`：无 Qt 依赖的 API 快照编排，只产出只读 DTO，不读取本地角色文件。
- `desktop_models` / `desktop_read_model`：Manager DTO 到托盘表现模型的转换与可重建缓存。
- `qt_async`：通用 Qt 线程池桥，只负责后台 callable 和主线程结果通知，不包含 Manager 或角色业务逻辑。
- `desktop_pet_idle`：只负责动作包声明的随机待机间隔、长时空闲计时和不连续重复选择；不读取素材，也不拥有最终动画状态。
- `system_selection`：Windows 全局鼠标拖选与键盘扩选检测、UI Automation 选区读取、Unity 专用剪贴板回退、选区外悬浮条、激活人格悬停菜单和滑词动作编排；`readAloudEnabled` 为 false 时隐藏“朗读”；只经 Manager 调用 TTS 与角色面板消息接口。
- `system_screenshot`：Windows 全局框选截图、框选区域或剪贴板贴图、屏幕截图及区域历史、可跨重启恢复的贴图窗口和角色面板图片附件投递；持久化设置由 Manager 的 `/api/desktop/settings` 管理。
- `LifecycleController`：只处理用户明确退出；Manager 在线状态属于展示快照，不决定托盘生死。
- `TaskWindow`：Route 导航、六个视图、聊天输入和渲染。
- `DesktopAdapter`：通过 Qt 打开 URL、文件和目录。
- `tray_app`：纯表现组合根，负责托盘菜单、窗口装配、缓存应用与用户事件。

平台层包含 Windows 启动器、生命周期意图与监督器、打包和应用身份。未来 macOS/Linux 入口应复用相同的 Manager HTTP 协议和 Qt 面板，而不是另建一套业务逻辑。
