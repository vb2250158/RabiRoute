<!-- docs-language-switch -->
<div align="center">
<a href="./unified-agent-api_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# CLI 与 MCP 统一接口

CLI 与 MCP 共用 operation SDK，通过现有 HTTP、SSE 或 WebSocket 调用 Manager 与业务插件。DSH、手机和其他宿主通过已有通用 HTTP、CLI 或 MCP 工具转接同一目录、schema 与执行 owner。Agent 可发现并调用当前运行版的全部公共业务与管理接口；已配置且鉴权的连接默认可用，用户显式限制由对应配置解释。

状态为本批源码实现。最终构建、安装和实际运行范围随对应发布验收记录确认。

## 先找到功能

独立客户端产物目录使用 `node rabi-cli.mjs <命令>`；完整源码根使用下面的路径。入口通过 Host 发现当前 Manager，命令结果以 JSON 写入 stdout。独立 CLI/MCP 客户端更新不需要重启 Manager。

```sh
node apps/rabi-agent/rabi-cli.mjs categories
node apps/rabi-agent/rabi-cli.mjs list --category messages --limit 20
node apps/rabi-agent/rabi-cli.mjs search "QQ群历史" --category messages
node apps/rabi-agent/rabi-cli.mjs describe agent.qq.history.read --view input
node apps/rabi-agent/rabi-cli.mjs call agent.qq.history.read --input-file request.json
```

已接入远端电脑使用同一入口，并提供原私有连接配置、Agent 类型和完整会话 ID。

```sh
node apps/rabi-agent/rabi-cli.mjs search "聊天历史" --config /private/rabi-agent.json --agent-type codex --id <完整会话ID>
```

标准 MCP 默认目录展示六个工具，参数与 CLI 使用同一模型。已有通用 HTTP、CLI 或 MCP 工具的宿主直接转接公共合同，无须另注册这六个原生工具或复刻业务接口；宿主从同源目录取得短提示，负责协议转接与呈现。

| 工具 | 用途 |
| --- | --- |
| `rabi_categories` | 列出业务分类和插件自定义分类 |
| `rabi_list` | 按分类、provider 或 owner 列出短摘要 |
| `rabi_search` | 按中英关键词和可选分类检索操作 |
| `rabi_describe` | 读取某个 operation 的输入、结果或完整合同 |
| `rabi_call` | 使用结构化 input 执行当前 operation |
| `rabi_session` | 读取、发送或关闭原流式 / WebSocket 会话 |

先读摘要，选定功能后读取 `view=input`。`view=result` 提供结果约定，`view=full` 提供完整可执行合同。CLI 默认 describe 视图为 input。MCP 宿主启动入口和配置见 [Rabi MCP](../apps/rabi-mcp/README.md)。

## 分类和关键词

| 稳定分类 ID | 内容 |
| --- | --- |
| `messages` | 消息连接、会话、搜索、历史、发送、回复与消息附件 |
| `agents` | Agent 软件、执行会话、协作投递、原生历史和回执 |
| `knowledge` | 记忆、计划、步骤、Skill 与计划材料 |
| `devices` | 电脑、终端、文件、窗口、家庭设备和媒体能力 |
| `settings` | 角色、人格、路由与 Rabi PC 设置 |
| `automation` | 规则、定时事件、Hook 与执行记录 |
| `runtime` | Rabi 插件安装卸载、版本、启停、状态与诊断 |

插件在 operation definition 的 `discovery` 中登记分类、标题、关键词和 provider，显式声明优先。既有 API 缺少中文导航字段时，在公共发现插件的基础导航数据补齐，保留原执行合同、schema、owner 和权限，不为搜索虚构接口。自定义分类保留稳定 ID、可选父类和插件归属，随活动快照更新。缺少分类的公开接口仍能通过全局搜索找到。跨类标签和相关操作引用同一个 operation。

`category` 用于筛选范围，搜索按真实标题、关键词和短语相关性匹配；中英文同义组在 query 侧展开，不把整类词注入该分类的每个 operation。目录 `provider` 表示能力提供方；模型厂商在文档中称为 ModelProvider，原 wire 字段保持不变。

## HTTP 发现合同

| 入口 | 返回 |
| --- | --- |
| `GET /api/agent/categories` | `data.categories`，含分类说明、父类及当前数量 |
| `GET /api/agent/operations` | `data.items` 短摘要、`count`、`total` 和 `nextCursor` |
| `GET /api/agent/operations/:operationId?view=input` | `data.operation` 的输入合同、参数来源和相关操作 |

列表接受 `category`、`query`、`provider`、`owner`、`method`、`pathPrefix`、`limit` 和 `cursor`。默认每页 20 条，`limit` 支持 1–200。关键词覆盖 ID、alias、标题、摘要、路径及声明的词，分类字段负责范围筛选。游标绑定原快照和筛选条件，409 后重新发现当前页。

响应携带 `schemaVersion`、Manager 身份、`pluginGenerationId`、`catalogRevision` 与 `catalogDigest`。完整兼容帮助 `/api/agent/help` 和 OpenAPI 导出仍可使用。日常发现使用短摘要和单项 describe。

## 从接口能力读到业务资源

`categories`、`list` 和 `search` 返回接口能力。列表中的 `total` 是匹配接口数，不是电脑数、消息数或计划数。先用“电脑列表”“群历史”等场景词找到真实接口，describe 取得输入与 `inputSources`，再调用业务目录读取设备、在线状态或消息。空搜索和空终端会话列表不能证明没有设备控制能力。

DSH 通用 HTTP 桥同样可执行上述三个发现 GET；已有桥接工具配合同源短提示即可使用公共业务。Rabi 读取 Codex/DSH 原生会话、历史、Codex Desktop owner 或 DSH 原生插件管理，则由对应平台 adapter 接入真实 owner。两条调用方向的职责见 [标准 Agent 端接入需求](agent-adapter-standard-requirements.md)。

## 同一输入与请求身份

CLI 的 `--input-file`、`--input-json` 或 `--input-stdin` 与 MCP `input` 使用相同 JSON。路径、查询和正文保留各自命名空间。

```json
{
  "pathParams": {},
  "query": { "routeId": "example-route", "kind": "group", "target": "123456789", "limit": 50 }
}
```

| 字段 | 含义 |
| --- | --- |
| `operation` | 稳定业务接口 ID，CLI 的 call 位置参数与它对应 |
| `input.pathParams` | 路径参数，SDK 按当前 pathTemplate 编码 |
| `input.query` | 查询参数，标量或标量数组按合同传输 |
| `input.body` | JSON 正文，字符串也按 JSON 字符串传输 |
| `input.bodyBase64` | 原二进制正文的 base64 表示 |
| `input.headers` | 业务合同要求的请求头 |
| `requestId` / `idempotencyKey` | 本次写请求和幂等身份，保留原意图及回执 |
| `expectedRevision` | 原资源强 ETag，对应 CLI `--if-match` |

接口目录中的 `operationId` 标识能力。部分旧传输字段中的 `operationId` 标识一次请求，适配入口负责精确映射。固定接口 ID 不作为多次写入共用的幂等键。

输入来源 `inputSources` 引用真实 operation、参数映射和结果字段。例如 QQ 历史需要先取得 Route 与联系人目录，再使用原 `routeId`、`kind`、`target`。错误保留字段、合法参数发现入口、HTTP 状态和回执。结果中的 `accepted`、`committed`、`delivered` 与 `uncertain` 按原 owner 的实际阶段解释。

## 文件和长连接

有限下载使用 CLI `--output` 或 MCP `input.outputPath`。SSE 需要输出文件或原流消费者。WebSocket CLI 用 `--output frames.jsonl` 捕获帧，需要输入时使用 `--frames-stdin`。原会话随该命令退出和取消收尾。

MCP 的流式调用返回 `sessionId`，后续通过 `rabi_session` 读取帧、发送帧或关闭原会话。连接 ACK 与业务结果分别由传输状态和原回执说明。未知写入按原编号读回。

## Agent 原生能力

| Provider | 当前公开路径与归属 |
| --- | --- |
| Codex | `/api/agent/providers/codex/sessions`、`/sessions/:sessionId`、`/sessions/:sessionId/history`，由 Codex 插件读取真实目录和原生记录 |
| DSH | `/api/agent/providers/dsh/sessions` 与对应详情、历史，历史转接原 `session/events` |
| DSH 插件 | 同 provider 下的 `/plugins`、`/bundles`、`/plugin-market`、市场 search、插件 install/update/remove 转接 DSH 原 PluginManager / PluginMarket |

Codex 历史保留原事件、工具 ID、物理序号和返回游标，普通 JSONL 后续页按位置续读。DSH 历史保留原 seq、cursor 与覆盖字段。Rabi 的投递与回复记录保存另一类业务事实，查询时按目录说明选择数据来源。

## Skill 与自动化模板

角色 Skill 保留原列表、详情和下载入口。编辑先读 `GET /api/roles/:roleId/skills/:skillId/source` 获取完整文档、附属文件索引和强 ETag。

- `POST /api/roles/:roleId/skills` 创建 Skill，正文包含 `id`、`content` 和可选 `files`。
- `PUT /api/roles/:roleId/skills/:skillId` 更新文档和相对附属文件。
- `DELETE /api/roles/:roleId/skills/:skillId` 删除原 Skill。
- 写入使用稳定 `Idempotency-Key`，更新和删除带原 `If-Match`。
- `GET /api/roles/:roleId/skill-operations/:requestId` 查询原写入回执。

`GET /api/automation/templates` 分页返回默认和插件模板摘要，`GET /api/automation/templates/:templateId` 返回完整可编辑内容。添加自动化时选择模板后展开成普通规则，周期、目标、忙时策略及正文可编辑，执行复用统一调度器。

“记忆整理与 Skill 维护”模板让 Agent 读取记忆、对照已有 Skill、更新或创建可复用流程、提交并回读整理结果，再汇总变更。另有阶段复盘、计划核对、消息摘要、运行巡检和空白投递模板。

## 插件迭代与查询对等

发现元数据随活动 registry snapshot 发布。分类和关键词更新目录 revision，执行合同变化更新 `contractDigest`。SDK 缓存单项合同，并在目录事件、重连或身份变化后刷新。

界面、CLI 和 MCP 使用同源查询验证列表、全文、关联记录、群成员、图片和合并转发的 ID、字段与分页覆盖。单项异常在所属项报告，健康数据继续可查询。实际安装版本与外部宿主工具加载以对应发布和运行验收为准。验收同时记录实际宿主 tools、加载提示和 adapter 版本，用“电脑列表”“群历史”等关键词发现真实 API 并读取业务资源；HTTP 200、Host 版本和 source build 分别只证明各自范围。

## 旧数据升级

应用完全启动后，WebGUI 读取 `GET /api/data-upgrades` 的缓存状态。有待升级项时显示升级概览，按实际迁移 owner 列出类别、来源与目标版本或布局、状态、升级内容及已知数量和大小。未知数量显示待检查。首屏读取轻状态，升级发现由独立受控子进程完成。

用户确认后调用 `POST /api/data-upgrades/start`，正文为 `{ "operationId": "<本次升级请求ID>", "expectedRevision": 1 }`。`expectedRevision` 使用刚读到的状态 revision。这里的 `operationId` 是一次升级请求的稳定身份。接收响应返回原升级状态，后台执行状态通过 `data-upgrade-status` 事件和原状态入口更新。

需要原数据 owner 退出后才能迁移的项目，界面显示“确认升级并重启”。已接受的操作持久保存，再通过正式 Host 入口执行一次重启。关闭窗口后原操作继续，恢复连接后读取原状态。普通事务恢复与格式升级各自执行，健康读取和无依赖功能继续可用，进度沿事件更新。
