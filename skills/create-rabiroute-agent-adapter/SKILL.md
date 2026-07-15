---
name: create-rabiroute-agent-adapter
description: 新增或改造 RabiRoute Agent 端适配器时使用。覆盖后端 agent adapter、独立 Agent Manager API 模块、扫描/安装/登录/健康检查 API、RibiWebGUI 自动化配置、项目目录筛选会话、消息投递协议、运行状态诊断和验证流程；适用于 Codex runtime、Copilot CLI、Marvis、AstrBot、Hermes、脚本、Webhook 或其他 Agent 处理端。
---

# 创建 RabiRoute Agent 端适配器

## 目标

新增 Agent 端时，不只接上一条 `deliver(message)`。必须让用户能在 WebGUI 里尽量自动完成配置：

1. 自动发现安装位置、运行状态、登录状态、插件状态、项目目录和会话。
2. 如果有项目概念，先选 Agent 路径或服务地址，再选项目目录，最后选会话。
3. 如果设置了项目目录，会话列表必须按项目目录过滤；没有项目概念就隐藏项目目录。
4. 能扫描的不要让用户手填；必须提供刷新、安装、打开下载页、登录、部署/更新插件、健康检查等动作入口。
5. 添加 Agent 端后必须在 WebGUI 展示“环境和依赖”清单：安装状态、登录状态、插件/扩展、Endpoint、项目/会话发现、下载或文档入口、缺失项和下一步动作。
5. 运行态要能解释“为什么不可用”，不能只给一个空输入框或沉默失败。

Codex runtime 目前是已跑通的基线：RabiRoute 使用官方 `codex app-server` stdio JSONL，能发现并恢复会话、校验工作目录、显示运行状态和错误。ChatGPT desktop 只是可选宿主，不能作为 transport、绑定真源或健康条件。其他 Agent 在没有完成本 skill 的验证清单前，都按“实验/未验证”处理，不能在 UI、README 或示例里暗示已经稳定可用。

AstrBot 这类服务型 Agent 不能只给“地址 + 部署”按钮；至少要补上服务健康、插件健康、认证状态、可选会话/工作区发现，或者明确显示“该后端无会话概念”。

## 统一能力模型

每个 Agent adapter 都要先声明自己支持哪些能力，再决定 UI 显示什么字段：

```ts
type AgentAdapterCapability = {
  type: AgentAdapterType;
  label: string;
  maturity: "verified" | "experimental" | "stub";
  requiresInstall: boolean;
  requiresAuth: boolean;
  hasAgentPath: boolean;
  hasServiceEndpoint: boolean;
  hasProject: boolean;
  hasSession: boolean;
  canListProjects: boolean;
  canListSessions: boolean;
  canFilterSessionsByProject: boolean;
  canDeployPlugin: boolean;
  canHealthCheck: boolean;
};
```

能力模型是产品合同，不只是类型定义：

- `verified`：本机或 CI 已验证扫描、配置、投递、失败诊断四条路径。
- `experimental`：代码存在，但没有完成端到端验证；WebGUI 必须显示“实验/未验证”提示。
- `stub`：只是占位或打开外部页面；不能默认启用，必须说明缺哪段能力。
- `hasProject=false` 时不要显示项目目录。
- `hasSession=false` 时不要显示会话输入框，要显示“该 Agent 无可选会话”。
- `canListSessions=false` 时不要伪装成下拉框；用说明和后续任务替代。
- `canFilterSessionsByProject=false` 且 `hasProject=true` 时，要显示项目/会话可能不一致的风险。

当前已有 Agent 的默认基线：

| Agent | 默认等级 | 说明 |
| --- | --- | --- |
| Codex runtime | `verified` | 使用 app-server stdio；作为会话发现/恢复、项目目录、运行状态诊断和 fail-closed 审批的参照。 |
| Copilot CLI | `experimental` | 需要验证安装检测、登录、`-C` 项目目录、`--resume` 会话和 Windows 长 prompt 路径。 |
| Marvis | `stub`/`experimental` | 目前更像打开 App/复制 prompt，不应宣称有可靠会话绑定或回传。 |
| AstrBot | `experimental` | 必须补服务、认证、插件、默认会话/管线说明后才能接近可用。 |

新增或改造时，不要靠口头记忆这些等级；让 Manager scan/status API 返回 `maturity` 和 `warnings`，让 WebGUI 显示出来。

## 先判断 Agent 类型

实现前先确认目标 Agent 属于哪类：

- **Agent runtime 型**：有正式进程协议、会话列表和项目目录，例如 Codex runtime / app-server。桌面宿主若存在也不等于 transport。
- **CLI 项目型**：有可执行文件、登录状态、`cwd` 或 workspace、session/resume 名称，例如 Copilot CLI。
- **服务/机器人框架型**：有 dashboard URL、插件、token/password、bot 实例、会话或通道，例如 AstrBot。
- **网页/桌面跳转型**：只能打开页面或 app、复制 prompt，通常没有可靠回传，例如 Marvis。
- **Webhook/script 型**：有 endpoint、命令、脚本路径、输出协议，可能没有会话。

不要为了统一 UI 强行显示不存在的字段。字段由能力决定。

## 先摸清真实 API

做任何 Agent 端适配前，先用最小脚本或临时命令验证目标 Agent 的真实能力。不要先写 WebGUI，不要先设计配置表单。

必须按这个顺序探测：

1. **健康检查**：确认 Agent app / CLI / service 是否存在、能启动、能连接。
2. **认证检查**：确认是否需要 token、password、cookie、device code 或本机登录态。
3. **列出会话线程**：优先找官方 API、CLI 命令或插件 API，拿到 thread/session 列表。本地索引只能作为明确标记的迁移候选，不能替代官方恢复/绑定协议。
4. **列出项目或 workspace**：如果会话带 cwd/project/workspace，记录字段名和路径格式。
5. **创建会话线程**：如果 API 支持，创建一个测试会话，名称用公开占位，例如 `RabiRoute Smoke Test`。
6. **消息注入测试**：向新建会话发送一条测试消息。
7. **同会话重复注入测试**：向同一个会话再发送第二条测试消息，确认不会新建另一个会话线程。
8. **如果不能创建会话**：选择第一个可用会话线程，连续注入两条明确的测试消息。
9. **读取结果或状态**：能读回复就读回复；不能读回复也要确认消息已被目标 Agent 接收。

测试消息必须无害、可识别、可公开：

```text
RabiRoute adapter smoke test. If you see this, reply with: RabiRoute injection OK.
```

第二条消息必须带序号，用来确认同一会话是否支持重复发送：

```text
RabiRoute adapter smoke test #2 in the same thread. Reply with: RabiRoute repeat injection OK.
```

如果目标 Agent 是中文场景，也可以使用：

```text
RabiRoute Agent 端适配烟测消息。如果你收到这条消息，请回复：RabiRoute 注入成功。
```

第二条中文测试消息：

```text
RabiRoute Agent 端适配烟测消息 #2。请在同一个会话里回复：RabiRoute 重复注入成功。
```

探测结果要沉淀成一小段事实记录，至少包括：

- 使用了哪个 API / CLI / 文件路径。
- 能否列会话。
- 会话字段有哪些：id、name、updatedAt、projectPath/cwd。
- 能否按项目目录筛选。
- 能否创建会话。
- 能否向指定会话注入消息。
- 能否向同一会话重复注入消息。
- 第二次注入后是否错误地创建了新会话。
- 注入后能否读取回复或确认接收。
- 失败点、错误原文摘要和下一步。

如果列会话、建会话或注入消息任何一步没有跑通，该 Agent 的 `maturity` 只能是 `experimental` 或 `stub`。在成功前，只允许提交探测代码、mock、诊断 UI 或明确标注未验证的入口；不要把它做成默认推荐 Agent。

不要用“看起来应该可以”代替真实探测。接口不清楚时，先写临时探测脚本，成功后再把逻辑迁入 Manager scan/status API 和正式 adapter。

## 代码入口

新增一个 Agent 类型通常要改这些位置：

- `src/agentAdapters/types.ts`：扩展 `AgentAdapterType`、`parseAgentAdapterType`。
- `src/agentAdapters/agentAdapter.ts`：把 type 映射到 `deliver(message)`。
- `src/agentAdapters/<name>Adapter.ts`：优先新增接口化 adapter；旧式模块只作为兼容。
- `src/agentAdapters/managerApi.ts` 或同目录按端拆分的 manager-facing 模块：实现扫描、状态、安装、登录、部署、打开外部应用等 Agent 专属逻辑。
- `src/manager.ts`：只扩展通用 `GatewayDefinition` 字段、env 注入、运行态 state 读取和 HTTP 路由接线；不要把 Agent 专属扫描/安装/登录/部署实现写进 manager。
- `ribiwebgui/src/types.ts`：同步 gateway 字段和扫描结果类型。
- `ribiwebgui/src/pages/RouteConfigPage.vue`：添加 Agent 卡片、参数面板、自动扫描、状态和动作按钮。
- `ribiwebgui/src/components/QuickSetupDialog.vue`：如果该 Agent 适合首次配置，也同步快速配置。
- `README.md`、`docs/configuration.md` 或示例：只补公开、安全、可复制的说明。

如果新增的是消息入口，不要用本 skill；消息入口走 `src/adapters/`。

## Manager 模块化边界

`src/manager.ts` 是 Agent 端编排层，不是某个 Agent 的实现层。新增或改造 Agent 端时，遵守这个边界：

- Agent 专属逻辑放在 `src/agentAdapters/`：安装/登录检测、Dashboard/API 探测、项目/会话扫描、插件部署、打开外部 app、scan payload 组装。
- `manager.ts` 只构造上下文 `ctx` 并接 HTTP API：`rootDir`、runtime 读取器、通用 HTTP 检查、通用安装路径 helper。Agent 会话必须通过该 Agent 的公开运行时协议发现，不读取私有索引文件。
- 通用 runtime 管理、配置 normalize、env 注入和状态文件读取可以暂留 `manager.ts`；不要为了新增一个 Agent 把专属逻辑塞进 manager。
- 新模块不能 import `src/manager.ts`，也不能依赖 `ribiwebgui`、浏览器 `window/document` 或前端状态。
- `/api/scan/agents` 应调用 `scanAgentAdapters(ctx)` 或各 Agent scan 函数组合；旧平铺字段只作为兼容输出。

当前参考模块：

- `src/agentAdapters/managerApi.ts`：Codex/Copilot/Marvis/AstrBot 的 manager-facing scan、status、login、deploy、open 动作。

如果某个 Agent 后续变复杂，优先新增 `src/agentAdapters/<type>ManagerApi.ts` 并由 `managerApi.ts` 聚合，不要继续扩大 `src/manager.ts`。

## UX 合同

Agent 参数面板的顺序固定按依赖关系走：

1. **Agent 路径 / 服务地址 / App ID / CLI 路径**
2. **项目目录 / workspace / bot 实例 / channel**（仅当该 Agent 有项目或工作区概念）
3. **会话 / thread / session / resume name**（必须受上一步筛选）
4. **认证、安装、部署、健康检查动作**
5. **运行时诊断**

不要让“会话”排在最前面。用户要先知道自己连的是哪个 Agent、哪个项目，然后才知道该选哪个会话。

Agent 卡片本身必须显示统一状态：

- 名称和简短说明。
- 等级 chip：已验证 / 实验 / 占位。
- 连接 chip：未安装 / 未登录 / 未启动 / 已连接 / 插件缺失。
- 如果不是 `verified`，展开面板顶部显示一条短 warning，说明还没验证哪几段。

能自动化的字段使用控件，不用裸输入框：

- 路径：`v-combobox` + 扫描按钮 + 最近配置 + 文件存在状态。
- URL：默认值 + 健康检查 + 打开 dashboard + 最近成功地址；可手填但不是唯一入口。
- 会话：`v-combobox` / `v-select`，来源于扫描 API；按项目目录过滤。
- 安装：状态 chip + 安装按钮或下载链接；安装失败显示 stderr 摘要。
- 登录：状态 chip + 登录按钮；device code 或浏览器链接要清楚展示下一步。
- 插件：状态 chip + 部署/更新按钮 + 打开插件目录/插件页。
- 无会话概念：显示“该 Agent 无会话概念”，不要留一个空白会话输入框。

## 扫描 API 要求

每个新 Agent 都要在 Manager 侧提供扫描/状态能力。可以先扩展 `/api/scan/agents`，复杂时新增：

```text
GET  /api/agents/<type>/scan
GET  /api/agents/<type>/status
POST /api/agents/<type>/install
POST /api/agents/<type>/login
POST /api/agents/<type>/deploy-plugin
```

实现时优先让 `src/agentAdapters/managerApi.ts` 或 `src/agentAdapters/<type>ManagerApi.ts` 暴露这些函数，再由 `manager.ts` 接线：

```ts
scanAgentAdapters(ctx)
scan<Type>Agent(ctx)
test<Type>Login(ctx, request)
get<Type>Status(ctx, request)
deploy<Type>Plugin(ctx, request)
open<Type>(ctx, request)
```

返回 JSON shape 必须和 WebGUI 已消费的结构兼容。迁移旧逻辑时先接新模块再删除 manager 内旧实现，并运行 `npm run build`。

扫描结果至少表达这些信息：

```ts
type AgentScanResult = {
  type: AgentAdapterType;
  label: string;
  maturity: "verified" | "experimental" | "stub";
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  auth?: { required: boolean; loggedIn?: boolean; loginUrl?: string; message?: string };
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  projects?: Array<{ label: string; path: string; exists: boolean }>;
  sessions?: Array<{
    id?: string;
    name: string;
    projectPath?: string;
    updatedAt?: string;
    userNamed?: boolean;
  }>;
  plugins?: Array<{ id: string; name: string; installed: boolean; version?: string; healthy?: boolean }>;
  warnings?: string[];
};
```

当前代码还是平铺的 `threadNames/cwdOptions/copilotSessions/copilotBins/marvisAppIds`；新增适配时可以兼容旧字段，但新能力优先按 Agent 分组，避免不同 Agent 的会话混在一起。

推荐返回结构：

```ts
type AgentScanResponse = {
  agents: Record<AgentAdapterType, AgentScanResult>;
  legacy?: {
    threadNames?: string[];
    cwdOptions?: string[];
    copilotSessions?: Array<{ name: string; cwd?: string; userNamed?: boolean }>;
    copilotBins?: string[];
    marvisAppIds?: string[];
  };
};
```

WebGUI 读取 `agents[type]` 优先；旧字段只作为迁移兼容。

## 项目目录与会话筛选

如果 Agent 有项目目录或 workspace：

1. 扫描项目目录：从 Agent 会话记录、已有 gateway 配置、最近 workspace、仓库兄弟目录中收集。
2. 路径必须规范化后比较：处理大小写、斜杠、尾部分隔符、符号链接失败时保持原始值。
3. 用户选择目录后，会话下拉只显示 `session.projectPath === selectedProjectPath` 的项。
4. 如果未选择目录，会话按项目分组或显示项目标签，不要让用户猜。
5. 选择会话时，如果当前项目目录为空且该会话带 `projectPath`，自动回填项目目录。
6. 如果项目目录与会话项目不一致，显示 warning，不要静默投递。

没有项目概念的 Agent 不显示项目目录。只有服务地址/插件/频道概念的 Agent，用对应字段替代。

## 安装、登录和插件检查

每个 Agent 都要有“可行动”的状态：

- 未安装：显示检测来源，提供安装按钮或官方下载/文档链接。
- 未登录：显示登录方式；能自动启动登录就提供按钮，不能就打开登录页。
- 服务未启动：提供打开 dashboard、复制启动命令或打开安装目录。
- 插件缺失：提供部署/更新按钮，并显示部署目标路径。
- 权限不足：显示需要的权限名和配置位置。

不要只写“请设置环境变量”。如果确实需要 env，要在 UI 里显示变量名、当前是否缺失、哪里保存、是否需要重启 Manager。

## 消息投递协议

`deliver(message: string)` 可以继续兼容纯文本，但新 Agent 应优先能接收结构化上下文。最少要保留这些信息：

- 渲染后的正文 prompt。
- route kind、input adapter、output adapter/pipeline。
- 来源信息：群聊/私聊/Webhook/手动触发/语音转写。
- 角色信息：`agentRoleId`、`agentRolePath`、`agentRoleDir`。
- 上下文路径：日志、消息记录、附件或 transcript 路径。
- 期望输出：纯文本、QQ 草稿、JSON、语音短回复、Webhook payload 等。

如果目标 Agent 只能收纯文本，就把结构化字段渲染进 prompt；如果它有 HTTP/plugin API，就发送 JSON，并在 adapter 内做版本兼容。

正式 adapter 的第一条集成测试必须来自“先摸清真实 API”的探测结果：

- 支持创建会话：测试创建会话，向同一个会话连续注入两条测试消息，并确认没有创建新会话。
- 不支持创建会话但能列会话：测试向第一个可用会话连续注入两条测试消息。
- 能列会话但不能稳定复用同一会话：不能标 `verified`，UI 要提示该 Agent 可能每次投递新开线程。
- 不能列会话但能投递到默认管线：测试默认管线注入，并在 UI 标明“无可选会话”。
- 只能打开外部页面或复制剪贴板：不能称为“线程消息注入”，只能标为 `stub` 或人工接力型 adapter。

## 状态文件和诊断

每个 Agent 需要写自己的 state 文件到当前 route 的 `dataDir`，例如：

```json
{
  "agentAdapterType": "astrbot",
  "monitorThreadId": "optional-session-id",
  "monitorThreadName": "optional-session-name",
  "monitorThreadSource": "http://127.0.0.1:6185",
  "bound": true,
  "notificationCount": 3,
  "lastNotificationAt": "2026-06-07T00:00:00.000Z",
  "lastNotificationError": null,
  "lastPromptPath": "...",
  "lastResponsePreview": "..."
}
```

WebGUI 诊断区至少显示：连接/绑定状态、目标来源、最后成功、最后错误、状态文件路径。错误要转成用户能行动的中文提示。

## WebGUI 实现要求

- 打开 Agent 参数面板时自动触发该 Agent 的状态检查。
- 扫描按钮总是可见；列表为空时显示“扫描”而不是空下拉。
- 关键动作按钮使用图标：刷新、下载/安装、登录、打开、部署、复制。
- 保存前校验必要字段：路径存在、URL 可达、插件安装、会话与项目匹配。
- 不要把多个 Agent 的会话混在一个未标注的列表里。
- 添加 Agent 后自动展开参数面板，并立即扫描。

快速配置只放最常用链路，但顺序也必须是：Agent 类型 -> 路径/地址 -> 项目目录 -> 会话 -> 人格。

## AstrBot 改造特别要求

AstrBot 不应只有“地址”和“部署”：

- 扫描默认 dashboard：`http://127.0.0.1:6185`，并允许发现最近配置的 URL。
- 检查 dashboard 是否在线、登录是否可用、`rabiroute_agent` 插件是否安装且 endpoint 健康。
- 部署按钮旁要显示部署目标目录和部署结果，不要只弹 alert。
- 如果 AstrBot API 能列会话、bot、平台账号、群/私聊 channel，就做下拉选择。
- 如果它没有 RabiRoute 可用的会话 API，UI 必须明确写“当前 AstrBot 适配器使用插件默认会话/管线，无可选会话”，并给出下一步：配置插件默认会话或升级插件 API。
- 密码/token 缺失时显示缺失字段和重启/保存要求，不要等投递时才失败。

## 验证清单

完成后至少执行：

```text
npm run webgui:build
npm run build
```

如果改了 WebGUI，启动本地页面并用浏览器检查：

- Agent 面板可以渲染，无前端运行时错误。
- 字段顺序符合“路径/地址 -> 项目目录 -> 会话”。
- 扫描按钮、安装/登录/部署按钮不会让配置变脏，除非真的改了配置。
- 项目目录筛选会话有效。
- 缺安装、缺登录、缺插件、服务断开时都有可行动提示。

如果改了投递逻辑，至少用一个 mock 或本地假 endpoint 验证成功和失败两条路径都会写 state。

验证结果要回写到能力等级：

- 只验证了 UI 构建，不算 `verified`。
- 只验证了扫描，不算 `verified`。
- 没有真实投递目标时，保留 `experimental`，并记录 mock 验证范围。
- 真实跑通过扫描、配置保存、消息投递、失败诊断后，才升为 `verified`。
