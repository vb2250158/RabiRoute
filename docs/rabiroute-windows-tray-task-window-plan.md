# RabiRoute Windows 托盘计划与记忆窗口方案

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

- `当前`：状态为 `进行中` 的计划。
- `计划`：未归档计划总览，并显示已归档数量。
- `近期记忆`：Agent 通过 RabiRoute 接口新增或更新的近期记忆。
- `沉淀记忆`：RabiRoute 记忆整理流程写入的沉淀记忆。
- `状态`：manager、gateway、adapter 和运行目录状态。

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
