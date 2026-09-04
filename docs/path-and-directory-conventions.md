<!-- docs-language-switch -->
<div align="center">
<a href="./path-and-directory-conventions_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 路径与目录规范

> 受众：接入开发者和项目维护者。这里说明代码放在哪里、运行数据放在哪里，以及接口可以接收哪类路径。

## 软件目录

| 目录 | 所有内容 | 不应放入 |
| --- | --- | --- |
| `src/adapters/` | 外部消息协议的接收与标准化 | 路由决策、Agent 提示词、Manager 页面接口 |
| `src/agentAdapters/` | 向负责实际处理的 Agent 或程序投递 | 消息平台协议实现 |
| `src/messageEndpoints/` | Manager 管理的消息端扫描、登录和进程操作 | 路由核心 |
| `src/routing/` | 路由判断和 AgentPacket 组装 | 文件持久化和客户端界面 |
| `src/messageProcessing/` | 消息处理需求的状态机、记录核验、Manager 客户端和持久化适配器 | Manager HTTP 路由、平台协议 |
| `src/manager/` | Manager 控制面、运行日志和各类受限 API | 可由 Gateway 独立拥有的协议逻辑 |
| `src/shared/` | 多个模块共同依赖、没有业务所有权的路径和配置规则 | 某一功能独有的状态机 |
| `ribiwebgui/` | 浏览器界面 | Manager 或 Gateway 的业务真源 |
| `apps/` | 可独立构建和发布的客户端 | 可复制示例、Manager 私有数据 |
| `packages/` | 多个应用复用的稳定 SDK 和合同 | 拥有产品运行状态的服务 |
| `examples/` | 可公开复制的脱敏配置和样板 | 真实账号、群号、聊天内容、token、本机绝对路径 |

功能测试默认与被测 TypeScript 文件放在同一模块目录。跨模块验收脚本放在 `scripts/`，不要用根目录临时文件替代正式测试入口。

## 数据目录

| 路径 | 数据性质 | 提交到仓库 |
| --- | --- | --- |
| `examples/data/` | 可公开复制的完整示例数据包 | 是，必须使用占位值并脱敏 |
| `data/route/` | 每条消息路线（Route）的本机配置和运行数据 | 否 |
| `data/roles/` | 人格资料、计划、记忆、聊天记录和人格级附件 | 否 |
| `data/.runtime/` | Manager 可重建或恢复所需的内部状态 | 否 |
| `data/.runtime/performance/` | 按小时分片的本机性能 JSONL，受保留时间和空间上限管理 | 否 |
| `data/.runtime/imports/` | 有时限的导入暂存文件 | 否；处理完成或过期后清理 |
| `logs/manager/` | Manager 与 Gateway 共用的结构化运行日志；包含数据变动审计，默认保留 30 天并清理历史分片 | 否；用于排障，不是业务真源 |

代码通过 `src/shared/projectDirectoryLayout.ts` 取得项目级目录，不在各模块重复拼接 `data/.runtime`、`logs/manager` 等固定路径。路线数据和人格资料分别使用 `routeDataDir`、`personaDataDir`；不得再用一个含义不清的 `dataDir` 在模块内部同时代表两者。旧配置入口仍可读取 `dataDir`，但必须在配置边界转换成上述明确字段。

## 路径接口

- 公开 API 和持久化合同优先使用带类型的引用，不用一个字符串同时表示业务 ID 和文件路径。例如项目事实记录使用 `planId`、`memoryId` 或项目相对 `relativePath`。
- 允许用户选择项目文件时，只接收相对于已声明根目录的路径。拒绝绝对路径、`..` 跳出根目录和通过符号链接或目录联接跳到根目录外的文件。
- 进程内部需要绝对路径时，先用 `src/shared/pathPolicy.ts` 解析和校验，再传给文件系统接口。
- 普通项目路径转换不猜测旧工作区。只有读取历史持久化数据时，才使用明确命名的兼容迁移函数；新写入值保存为当前项目可解释的路径。
- API 返回给浏览器或外部处理端时，除非操作本身要求打开本机文件，否则不暴露宿主绝对路径。

## 生命周期和所有权

- `examples/` 是软件发布物；`data/`、`logs/` 和导入暂存目录是本机数据。复制、打包和提交时必须分开处理。
- 状态机负责业务规则，持久化适配器负责 JSON 文件读写。`src/messageProcessing/board.ts` 不直接决定文件位置，`src/messageProcessing/persistence.ts` 负责运行状态文件。
- 日志可以删除或轮换，但计划、记忆、消息记录和发送回执有各自的数据合同，不能因为位于 `data/` 就按临时文件处理。
- 未知根目录文件和外部工具生成目录先判定所有者；没有确认前不移动、不删除，也不把它们加入公开提交。
