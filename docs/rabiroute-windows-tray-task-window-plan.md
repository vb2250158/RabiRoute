<!-- docs-language-switch -->
<div align="center">
<a href="./rabiroute-windows-tray-task-window-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Windows 托盘计划与记忆窗口方案

> 状态：已实现边界记录。托盘的当前运行和打包事实以 [Windows 桌面启动与完整打包](windows-launcher-and-packaging.md) 及 `desktop/tray-task-window/` 为准。

本文档记录当前托盘窗口的产品边界。旧的任务目录结构已经废弃；当前事实源统一为角色目录下的 `plans/` 和 `memory/`。

## 定位

Windows 托盘程序是 RabiRoute 的轻量桌面入口，用来查看当前人格的计划、近期记忆、沉淀记忆和运行状态。它不是 RibiWebGUI 的替代品，也不是 Agent OS、执行器或完整项目管理台。

托盘窗口只读消费角色数据，不负责新建、修改、完成、归档计划，也不负责写入记忆。写入能力统一由 manager 的 Agent 接口提供。

## 数据事实源

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

托盘窗口不读取旧任务目录，不从聊天日志合成近期记忆，也不把路由运行态当作正式计划或记忆数据库。

## 展示视图

- `聊天`：读取当前人格的角色面板 timeline；只有这个视图显示消息输入框、文件选择和发送按钮。
- `当前`：先展示状态为 `进行中` 的计划，再展示近期记忆；两类内容仍使用各自的文件事实源。
- `计划`：全部未归档计划的只读总览。
- `近期记忆`：Agent 通过 RabiRoute 接口新增或更新的近期记忆。
- `已归档`：已归档计划和沉淀记忆的只读总览。
- `诊断`：以只读表格展示 manager、gateway、角色目录、计划目录、记忆目录、路由状态目录和运行状态摘要。

六个视图都位于浮动窗口的一级导航，不再把近期记忆、已归档和诊断藏在更多菜单中。左侧栏只负责切换航线；顶部只展示当前人格、Manager/Gateway 状态和当前航线；更多菜单继续收纳目录入口、手动触发、刷新和折叠左栏等次级动作。

视觉表现复用 RibiWebGUI 的 `RabiLight` 语言：页面使用雾蓝浅色背景，导航、顶部栏、输入区和卡片使用白色表面，正文使用深海军蓝，悬停、选中和焦点使用青绿色；组件统一采用轻边框和 8px 圆角。Qt 样式只负责表现，不复制 WebGUI 配置状态或引入第二套主题事实源。

计划和记忆条目使用相同的可展开只读行：折叠状态下，触发关键词固定为一行，并按窗口可用宽度动态增加或减少完整关键词，仍有未显示内容时只以 `……` 表示；展开后显示全部关键词和现有 JSON 已提供的详情字段。界面重排不创建独立进度事实、统计、设置或第二份状态数据。

计划展开区采用“完整步骤优先”的层级：源计划提供 `steps` 时，顶部先显示完成数、进度条和 `currentStepId` 指向的“当前执行：第 N 步”，随后一次列出全部步骤，并高亮唯一的 `进行中` 步骤。完整步骤已经表达后续路径，因此不再重复展示 `nextAction`。当前步骤或计划存在 `blockedBy` 时，界面把状态、当前位置和步骤行派生为“阻塞中 / 当前阻塞 / 已阻塞”，并在步骤列表后只补一块“阻塞原因”。优先级、类型、项目、截止和更新时间压缩为摘要；来源、创建时间和文件收进可展开的计划资料。这个展示计算是只读派生，不回写计划。旧计划缺少 `steps` 时明确提示无法展示完整步骤和准确执行位置，并保留旧版当前/下一步兼容区。

## 运行边界

- Qt 代码里的 manager HTTP client、路径解析、计划仓储和记忆仓储应保持跨平台。
- Windows-only 行为只允许出现在启动器、托盘可用性判断、打包脚本等平台层。
- 打开目录时优先使用 Qt desktop services，而不是把 `explorer` 或 `os.startfile` 写进仓储层。
- 托盘程序不直接调用 NapCat，不承担普通回复回传。

## API 对齐

后续如果托盘窗口需要更稳定的只读 API，应复用现有 manager 中的角色知识接口：

```text
GET /api/roles/:roleId/plans
GET /api/roles/:roleId/memory/recent
GET /api/roles/:roleId/memory/consolidated
```

不要重新引入旧任务 API。
