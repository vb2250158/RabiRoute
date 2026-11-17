<!-- docs-language-switch -->
<div align="center">
<a href="./workbuddy-agent-adapter-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# WorkBuddy 作为 Agent 端的接入方案

> 2026-11-17 验收边界修正。正式采用的 WorkBuddy 插件仍为 **0.1.5 / experimental**；当前源码和文档修改未作为新插件版本采用。0.1.5 的原任务接收、查询、历史和自动鉴权证据保留，桌面实时输入、任意任务寻址、权限保持、创建与自动初始化分别验收。

> 阅读前置：本文按 [标准 Agent 端接入需求](agent-adapter-standard-requirements.md) 编写，执行流程受 `skills/create-rabiroute-agent-adapter/SKILL.md` 和其 [owner-first 设计门](../skills/create-rabiroute-agent-adapter/references/owner-first-design-gate.md) 约束。

## 当前能力与验收

| 能力 | 已取得的证据 | 当前边界 |
| --- | --- | --- |
| 安装与采用 | Host 0.15.27 保持采用冻结的插件 0.1.5 | 文档修正不改运行字节；下一实现使用独立版本与候选 |
| 无绑定查询、原生历史分页 | 公共 Agent API 可按完整任务 ID 读取任务与字节游标历史 | 角色绑定只决定默认路由 |
| Windows 自动发现与鉴权 | 使用 Manager 已有 OS 权限核对原进程、PID、创建时间及回环网关，临时凭据进入内存 | WorkBuddy 已提升权限时需要相应的进程读取权限；不自动提升权限 |
| 原进程主会话接收 | 原任务烟测及后续通知在同一任务的原生 user/assistant 记录、原生回放和正式回执中得到确认；当前宿主为 WorkBuddy 5.11.3 | 仅覆盖已核对的原进程主会话（primary session） |
| Rabi 消息记录页面 | Persona 0.1.25 列表约 538 ms，历史分页及摘要回读通过 | 这是 Rabi 页面证据，须与 WorkBuddy 桌面实时显示分开 |
| 任意 `conversation.id` 寻址 | 当前网关 `getOrCreateSession` 优先返回 `primarySession` | 不能凭该字段推断任意目标已路由正确；未完成跨目标验收 |
| WorkBuddy 桌面实时显示 | 原生回放返回通知的 `user_message_chunk` | 尚未观察已打开桌面的即时输入显示；回放和回执不能替代该项 |
| 模型、工具与权限 | 原任务模型及工具执行已有记录；宿主 `runMessageOnSession` 会临时选择 `BypassPermissions` | 保持原任务审批/权限的合同尚未通过，不能声称完全沿用桌面审批 |
| 创建、打开、改名、未加载任务初始化 | 当前 Rabi 适配器未实现；真实 `action=create` 返回 400 | 依赖创建能力的任务迁移尚未完成；宿主内部 handler 的存在不等于已有外部桌面调用入口 |

原始已受理及 unknown 记录保持原 ID；结果待确认时只查询原回执和原任务。下面的 5.5.6 调研保留协议与历史观测，当前结论以本表为准。

## 1. 目标与范围

把 WorkBuddy（腾讯 AI 办公工作台）接成 RabiRoute 的一个 **Agent 处理端**：RabiRoute 收到消息后，把正文投递到用户配置好的 WorkBuddy 任务（会话）里，由该任务真实执行，结果回到 RabiRoute 现有回传链路。

本文覆盖查询、发现与投递，并记录创建、打开和自动初始化的目标及未完成项。不包含：

- 方向 ②（WorkBuddy 通过 MCP / Hook 调用 Rabi 接口）：属于工具接入，不是 Agent 端投递，另立方案。
- 消息入口：WorkBuddy 不是消息端，不新增 `src/adapters/` 下的消息适配器。

### Agent 会话桥与分页边界

WorkBuddy 会话桥已实现列出、读取和既有任务网关投递；实际接收证据限上表的原进程主会话。创建、改名、打开及初始化需要通过 WorkBuddy 桌面 owner 补齐。适配器未声明计划助手、记忆整理或丢失投递回执恢复能力，成熟度为 `experimental`。

列表的 `allowedWorkspaces` 在 store 内与可选单项 `workspace` 取交集，使用同一套路径规范化，再按最近活动时间降序、任务 ID 升序排序；工作空间过滤先于 10,000 行读取上限和 `offset` / `limit` 分页。空 allowlist 表示不额外限制。查询及归档过滤在该有界结果内执行，因此这不是任意规模的完整任务目录。多个工作空间交织、同名任务和较大的 offset 不再因 bridge 的页后过滤产生空洞。详情读取与 resolver 的精确 ID 路径使用参数化单行查询，不受发现列表的 10,000 行上限影响；workspace 冲突和归档校验仍保留。

验证使用临时 SQLite 数据库和 mock HTTP，不等于本轮已经完成真实桌面投递验收。真实发送继续复用唯一 session gateway，owner 不在线或 workspace 不匹配时失败关闭，不创建备用 Runtime。

## 2. 零号关卡：用户可观察目标合同

本节定义仍需达到的产品要求，实际验收状态见顶部表格。

| 要求 | 必需 | 唯一真源 | 验收证据 | 禁止替代 |
| --- | --- | --- | --- | --- |
| 消息出现在哪里 | 必需 | 用户绑定的那个 WorkBuddy 任务的对话区 | 该任务里出现逐字一致的投递正文 | 记录可读、HTTP 202、SSE 收到事件 |
| 多快可见 | 必需 | 会话进程存活时立即；否则失败关闭 | 投递后在该任务界面看到消息与执行状态 | 后台进程自己跑完、日志有输出 |
| 谁执行真实消息 | 必需 | 该会话进程的 Agent Runtime（桌面同一 owner） | 该任务使用其自带的模型、工具、审批执行该轮 | 另起 `codebuddy -p` 无头进程冒充 |
| 模型/工具/权限来源 | 必需 | 该任务的 `sessions` 记录与运行时注册 | 与实际任务设置一致 | 从提示词或另一客户端推断 |
| 新建与续投 | 必需 | 完整会话 ID | 同 ID 连续两次投递不新建任务 | 按名称模糊新建 |
| WorkBuddy 缺席时 | 必需 | 会话进程心跳文件 | Manager 正常启动并显示可行动状态，不投递、不 fallback | 启动备用 Runtime |
| RabiRoute 缺席时 | 必需 | WorkBuddy 自身 | WorkBuddy 可独立冷启动、退出、升级 | 依赖 RabiRoute 端口或环境变量 |

## 3. Owner 与生命周期

| 对象 | Owner | 谁启动/停止 | 权威状态 | RabiRoute 可读 | 可写 | 故障影响 |
| --- | --- | --- | --- | --- | --- | --- |
| Host/UI | WorkBuddy 桌面应用 | 用户 | `workbuddy.db`、渲染进程 | 只读 | 否 | 投递不可见 |
| Runtime | 每会话一个会话进程 | 桌面应用 | `~/.workbuddy/sessions/<pid>.json` | 只读 | 否 | 该会话不可投递 |
| Transport | 会话进程内置 HTTP 网关 | 会话进程 | `GET /api/v1/auth/status` | 只读 | 否 | 401，投递失败 |
| Session/task | 会话进程 + `sessions` 表 | 桌面/用户 | `sessions.id` | 只读 | 否 | resolver 失败关闭 |
| Turn | 会话进程 | 会话进程 | 运行状态查询 / SSE | 只读 | 否 | 只报 busy / 结果未知 |
| Tools/approval | 会话进程 | 会话进程 | 运行时注册结果 | 只读 | 否 | 报能力缺失，不改权限 |

硬性边界（沿用本项目既有红线）：

- RabiRoute 只探测和调用，不启动、不结束、不重启 WorkBuddy 或任何会话进程。
- 不写 WorkBuddy 用户级配置、不注入 `CODEBUDDY_*` 环境变量、不改 `app.asar` 或安装目录。
- 不把同一会话的 ID 当成同一 live owner：ID 可读 ≠ owner 已加载，必须同时校验心跳与端点。
- 一个 adapter 只有一条真实消息路径，不引入第二条备用路径。

## 4. 产品形态判定

**Desktop owner 型**，与 Codex 同类；与 DSH 的区别是 DSH 由独立 apiproxy 提供会话 API，而 WorkBuddy 的 API 由**每个会话进程自己**提供。

因此不选 CLI 类型：`codebuddy -p` 无头进程无法满足“消息出现在用户已有任务里”，只能作为最后手段的 `stub`（人工接力）以外的降级，且不得与主路径共存。

## 5. 历史协议与本机观测（WorkBuddy 5.5.6）

本节的网关报文、旧凭据配置和 Hook 调研是历史依据；其接收记录不构成当前桌面实时显示或权限保持验收。

### 5.1 会话进程描述文件

`~/.workbuddy/sessions/<pid>.json`（另有 `manual-<name>.json` 形态，带独立心跳超时）：

```json
{
  "pid": 63808,
  "sessionId": "eb2cb408-703a-45ad-88f8-35d0c7c4aa0e",
  "cwd": "C:\\work\\example",
  "kind": "interactive",
  "url": "http://127.0.0.1:6762",
  "endpoint": "http://127.0.0.1:6762",
  "mode": "local",
  "version": "2.137.1",
  "hostname": "PC-20210412FKBD",
  "startedAt": 1789370850729,
  "lastHeartbeat": 1789372891850,
  "updatedAt": 1789372891862
}
```

这是 **owner 是否加载** 的唯一可读判据，等价于 Codex Desktop 的 IPC 连通性。端口每次启动都变，正好符合本项目“不得写死 Manager 端口、必须动态发现”的既有纪律。

### 5.2 任务真源

`~/.workbuddy/workbuddy.db`（SQLite），与 Codex 状态库严格对应：

| 字段 | 含义 | 在 resolver 中的角色 |
| --- | --- | --- |
| `id` | 会话/任务身份 UUID | **任务身份**，下拉内部 value 与持久化绑定 |
| `custom_title` | 用户命名 | 下拉名称的高优先来源（等价 Codex 侧栏 `Name`） |
| `title` | 首条 prompt 自动生成标题 | **只作参考，禁止**用于下拉名称或同名查找 |
| `cwd` | 工作目录 | 规范化后用于消歧与投递前校验 |
| `status` | `working` / `completed` 等 | 运行状态展示 |
| `deleted_at` | 归档/删除标记 | 决定是否走“归档 ID → 幂等新建”分支 |
| `created_at` / `updated_at` / `last_activity_at` | 时间 | `updatedAt` 排序选唯一最新者 |
| `mode` | `craft` / 计划 / 提问 | 展示，不参与身份 |
| `model`、`thought_level`、`permission_mode` | 模型与权限 | 只读展示，不代为设置 |

同库另有 `workspaces(path, last_opened_at)`，可作为 workspace 候选来源。

### 5.3 会话记录

- `~/.workbuddy/projects/<workspace-slug>/<sessionId>.jsonl`：完整对话流水，可用于只读历史与回执核对。
- 同目录 `<sessionId>.meta.json`：当前仅见 `codebuddy.ai/hostKind`、`acpConnectionId`。

`<workspace-slug>` 由工作目录压缩而来（例如 `c-work-example`），因此“按项目列会话”可以只读文件系统完成，但**不作为绑定真源**。

### 5.4 会话本地 HTTP 网关

每个会话进程监听一个 loopback 端口，返回页面标题为“CodeBuddy Code Remote Control”，为 Express 服务，自带 OpenAPI 3.1 规范。已核实的鉴权与端点如下。

鉴权：

- `GET /api/v1/auth/status` 公开，返回 `{"authEnabled":true,"authenticated":false}`。
- 其余 `/api/v1/*` 未带凭据时返回 `401 {"error":{"code":"AUTH_REQUIRED"}}`。
- 通过方式（任一）：`?password=<password>`、Cookie `gateway_session=<hashedPassword>`、`Authorization: Bearer <password>`、专用访问令牌头，或 HMAC 签名（`x-signature` = HMAC-SHA256(`x-timestamp` + `x-nonce` + body)，带时间窗）。
- `POST /api/v1/auth/login`，body `{"password":"..."}`，成功返回 `{"success":true,"token":"<Bearer token>"}`；空密码返回 `login.error.required`；另有 429 频率限制。
- 凭据来源：会话进程环境变量 `CODEBUDDY_GATEWAY_PASSWORD`（由桌面应用注入）；该变量不存在时回落到 user 作用域设置的 `gateway.password`，缺失则随机生成并写回 user 设置。当前本机只有环境变量路径生效。

**端点与消息格式（S0 实测，修正了内置 OpenAPI 规范里过时的部分）**

实测请使用 `Authorization: Bearer <网关密码>`。所有会话进程共用同一个密码：同一个凭据在 1204、2817、3218 三个网关上均返回 `authenticated:true`；密码按桌面全局生成，不是每会话一份。

| 端点 | 实测结果 |
| --- | --- |
| `GET /api/v1/auth/status` | 公开，返回 `{"authEnabled":true,"authenticated":<bool>}` |
| `POST /api/v1/auth/login` | body `{"password"}`，成功返回 `{"success":true,"token"}`；空密码返回 `login.error.required` |
| `GET /api/v1/info` | `{"cwd","version":"5.5.6","gatewayMode":"local","tunnelUrl",uptime,"userName"}` |
| `GET /api/v1/sessions?cwd=<绝对路径>` | 默认当前工作目录；`cwd=*` 跨项目。每项实测字段：`id`、`name`、`createdAt`、`updatedAt`、`messageCount`、`isCurrent`、`projectId`、`cwd`（盘符小写）、`status`、`isPlayground`、`isUserDefinedTitle` |
| `GET /api/v1/jobs/resumable` | `{"candidates":[{"sessionId","label","updatedAt"}],"hasMore","nextOffset"}`，自带分页 |
| `GET /api/v1/jobs/dispatch-context` | 可派发的 Agent 配置（`cli` / `ptc` / `minimal` 等）与 `defaultAgentName` |
| `POST /api/v1/runs` | 外部网关投递入口。返回 `202 {"runId","status":"accepted"}` |
| `GET /api/v1/runs/{runId}` | `{"runId","active"}` |
| `GET /api/v1/jobs/events`、`GET /api/v1/jobs`、`GET /api/v1/tasks/templates` | SSE 订阅、作业列表、定时任务模板 |
| `GET /api/v1/instances`、`/api/v1/runs/{runId}/stream` | 在本次实测的网关上返回 404，不能假定可用 |

`POST /api/v1/runs`（代码里即 `handleWebhook`，与企微/微信回调同一入口）的真实报文格式：

```json
{
  "id": "<消息 ID，必填>",
  "type": "<类型，必填；\"action\" 走动作分支，其余走普通消息分支>",
  "source": {
    "platform": "rabiroute",
    "sender": { "id": "<发送者稳定标识>" },
    "conversation": { "id": "<声明的会话 ID>", "type": "direct" }
  },
  "payload": { "text": "<正文>", "attachments": [] }
}
```

两个必须记住的点：

1. 内置 OpenAPI 规范写的 `{text, sender:{id,name}}` **是错的**，实测缺 `id`/`type` 会返回 `400 BAD_REQUEST: Invalid generic message format`。字段默认值：`version`、`source`、`payload` 可省略，`payload.text` 也可由顶层 `text` 或 `prompt` 提供，`source.conversation.id` 缺省为消息 `id`。
2. **`source.conversation.id` 不能单独证明目标身份**：当前宿主的 `getOrCreateSession` 在存在 `primarySession` 时直接返回该主会话。固定该字段仍不能证明任意 ID 的寻址；须核对原任务进程、实际主会话和原任务回读。

早期临时会话键烟测曾返回 `202` 和 `active:true`，但未新增桌面任务行。当前主会话优先行为说明：这组观测既不证明新建成功，也不能证明指定的临时会话键被执行；保留原记录，不据此重投或扩大验收。

### 5.5.1 原任务记录与重复接收的历史观测

使用同一原任务进程的网关投递后，原 `<sessionId>.jsonl` 保存了逐字一致的 user 正文与随后完成的 assistant 回复，模型记录为该任务使用的模型。连续两次观测写入同一会话文件，任务表行数保持 18 → 18。

这些证据只确认被测原进程主会话接收和回复。它们不能证明 `conversation.id` 能选择其它任务、WorkBuddy 桌面即时显示了输入，或宿主保持了原审批权限。独立调用进程读取本地凭据文件的旧烟测也仅覆盖同一范围。

### 5.5.2 旧版手工凭据配置（历史参考）

早期实现未使用进程外只读探测，采用以下手工凭据来源；当前 0.1.5 自动鉴权及可选本地文件见第 8.1 节：

1. `RABI_WORKBUDDY_GATEWAY_PASSWORD` 进程环境变量（测试与包装脚本用）。
2. `<state>/data/workbuddy-auth.json` 的 `{"password":"..."}`，与 `data/dsh-auth.json` 同址同形，已被 `.gitignore` 覆盖。

两者都没有时投递直接失败关闭，绝不发未鉴权请求，也绝不重放被 401 拒绝的投递。该文件只需在一次投递前准备好；密码轮换后模块会在 5 分钟 TTL 或首个 401 时重新读取。


### 为什么这里需要凭据，而 Codex 端不需要

Codex 端“直连投递”不是因为它免鉴权，而是因为**信任由传输层建立**：`src/plugins/io.rabiroute.agent.codex/src/codexDesktopBridge.ts` 连的是 Windows 命名管道 `\\.\pipe\codex-ipc`（POSIX 上是 `$TMPDIR/codex-ipc/ipc-<uid>.sock`），裸 `net.Socket`，全文件没有任何 token、Authorization 或握手代码——只有同机同用户的进程能打开该管道，内核 ACL 就是凭据。

WorkBuddy 每个会话对外只有 loopback HTTP，操作系统不区分调用者，任何本机进程都能连；因此网关必须在应用层自己鉴权，否则本机任意脚本都能驱动用户的会话。这不是多加一道手续，而是传输方式决定的：

- 会话描述文件只声明 HTTP `url`/`endpoint`，没有 IPC 地址。
- 进程与端口印证同一结论：会话进程（如 `sessions/62288.json` 对应 `127.0.0.1:1204`）以 TCP 监听方式对外提供服务。
- 实测 `GET /api/v1/sessions` 从 loopback 发出仍返回 `401 AUTH_REQUIRED`；`/api/v1/auth/status` 是唯一公开端点，且不提供任何可用信息。

本项目对 HTTP 型 Agent 端要凭据早有先例：`src/plugins/io.rabiroute.agent.dsh/src/dshHttpAuth.ts` 整个模块就是为了获取 DSH 的令牌（从启动日志中取 `dsh web: ...?token=`，换成 HttpOnly cookie 后缓存在内存）；AstrBot 同样需要明确的会话 ID 与凭据。所以真正的待办不是“要不要凭据”，而是“独立进程如何获取一次”，且凭据只进本地忽略文件与内存缓存，不入仓库。

明确排除的替代方案：把 WorkBuddy 的 `gateway.auth` 改成 `none` 来免鉴权。这是安全降级（同机任意进程均可驱动该会话），且属于修改宿主配置，RabiRoute 不得实施；只有用户自行评估并接受风险后才可作为最后手段。

### 5.5 已实现部分（本次交付）

已落地并测试通过：

- `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionStore.ts`：会话进程描述读取（含 `prewarm` 池的命名管道只作元数据）、任务库读取、工作目录规范化比较、标准 resolver。`deliverable` 判定要求**进程存活 + 心跳未过期 + 已发布网关地址 + 非 prewarm/teammate 类型**四条同时成立。
- `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddyHttpAuth.ts`：网关凭据读取与缓存。原进程临时凭据、显式环境变量与本地文件解析；只允许回环地址；凭据只驻内存与本地文件，不入仓库、不入日志；5 分钟 TTL + 401 立即失效。
- `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionBridge.ts`：**唯一真实消息路径**。绑定读取、投递前 owner/目录再校验、`POST /api/v1/runs` 投递、`GET /runs/{runId}` 结算轮询。四种失败结局可区分：`unreachable`（可安全重试）/ `rejected`（未生效）/ `unauthorized`（未生效且不重放）/ `unknown`（可能已生效，必须先核对）。
- `src/plugins/io.rabiroute.agent.workbuddy/src/agentAdapters/workbuddyManagerApi.ts`：Manager 侧扫描/状态（`installed`、`auth`、`endpoints`、`projects`、`sessions` + 分页、`warnings`），并报告本地凭据是否已配置。
- `workbuddy` 已注册进 `agentAdapterTypes` 与 manifest，`maturity: experimental`、`transport: http/session-gateway`、`host: WorkBuddy Desktop(required)`，并声明 `managedTasks.messageProcessingAgent`（原主会话接收已验）与 `managedTasks.hooks`（生命周期 Hook 已可用）；**未**声明计划秘书与记忆整理（这两条路径走 Codex/DSH 线程驱动，尚未适配），也**未**声明 `deliveryReceiptRecovery`——网关只返回一次性受理回执，不保留可读的入站日志。
- Route 绑定与 DSH 同形：`adapterConfig.json` 只保存 `workbuddySessionId` / `workbuddySessionName` / `workbuddyCwd` / `workbuddyEndpoint`（末项仅作展示与兜底，投递始终优先用会话描述文件里的实时地址），凭据不写入路由配置。
- WebGUI：Agent 列表新增 WorkBuddy 卡片、任务下拉（带在线状态）、工作目录与可选网关地址字段。
- 生命周期 Hook：`plugins/rabi-workbuddy-context` 插件包 + `updateAgentHooks` 的 WorkBuddy 安装分支（详见 5.5.3）。


### 5.5.3 Hook 接入（本次交付）

WorkBuddy 的 CLI 内核（CodeBuddy Code）提供与 Codex 同族的生命周期 Hook：同一批事件名（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`）、同样的 `matcher` + `hooks[]` JSON 结构、同样的输入契约（`session_id` / `transcript_path` / `cwd` / `hook_event_name` / `tool_name` / `tool_input`）与同样的 `hookSpecificOutput.additionalContext` 输出。插件声明同样放在插件根的 `hooks/hooks.json`，只是插件根环境变量为 `${CODEBUDDY_PLUGIN_ROOT}`、清单目录为 `.codebuddy-plugin/`。

**已实测确认**（本机 WorkBuddy 5.5.6 / CLI 2.137.1）：在 `~/.workbuddy/settings.json` 写入 `hooks` 后，headless 会话确实触发并执行了 hook 脚本，输入 JSON 含 `session_id`、`cwd`、`hook_event_name`，`CODEBUDDY_CONFIG_DIR` 解析为 `~/.workbuddy`。所以用户级 settings 是本机可靠的安装位置。另有一条契约差异需要记住：CodeBuddy 的 `matcher` **只对 `PreToolUse` / `PostToolUse` 生效**，给生命周期事件挂 `matcher` 会让该 hook 静默不触发。

**实现选择**：`plugins/rabi-workbuddy-context` 是与 `rabi-codex-context` 同构的插件包（`hooks/hooks.json` 为唯一声明源），但安装**不走插件 CLI**：

- `codebuddy plugin` 子命令实测单次启动开销超过 90 秒（`--version` 很快，说明是子命令自身的加载与检查成本），会让「更新 Hook」按钮变成不可接受的等待；
- CLI 可执行文件位于 WorkBuddy 安装目录内（`resources/app.asar.unpacked/cli/bin/codebuddy`），随桌面版升级移动，不适合写进长期配置；
- Manager 是独立进程，调用 CLI 时的配置目录解析依赖环境变量。

因此改为：`updateAgentHooks(rootDir, "workbuddy")` 把包内脚本复制到稳定路径 `<LOCALAPPDATA>\RabiRoute\agent-hooks\rabi-workbuddy-context\`，再读 `hooks/hooks.json`、把 `process.env.CODEBUDDY_PLUGIN_ROOT` 替换为该绝对路径，最后**合并**进 `~/.workbuddy/settings.json` 的 `hooks`。

合并语义：只替换带 `rabi-workbuddy-hook.mjs` 指纹的条目，用户自己写的 hook 与其余 settings 键原样保留；重复执行幂等；settings 不是合法 JSON 时拒绝写入而**不是**覆盖用户配置。插件包仍随安装包分发，需要 `/plugin` 面板管理的用户可以自行 `codebuddy plugin marketplace add <安装目录>/dist/agent-hooks` 后安装——两条路径共用同一份 `hooks/hooks.json`。

**与 Codex/DSH 的差异**：那两端通过各自插件管理器安装、由插件系统注入插件根；WorkBuddy 侧改由 RabiRoute 直接维护用户级配置。功能对等（同样五类事件、同样上下文注入与完成回传），差别只在安装载体，换来的是免去 CLI 启动成本与路径耦合。

**Hook 自检边界（候选实现，未上线验收）**：写入配置不等于自检健康。安装器通过 Node 异步 `spawn` 执行 `--self-check`，默认最多 20 秒、stdout/stderr 合计最多 64 KiB；超时或取消必须确认子进程退出，判定以退出码优先，不能用输出中的 `ok:true` 覆盖非零退出。脚本仅在沿既有客户端路径取得非空有效上下文、且排除已知 fail-open 诊断时返回 `ok:true`。空响应（包括停用 helper 本地合成的空上下文）或 `handleHookInput` 返回 `null` 只能说明“未取得可验证上下文；尚未确认可用”，均非零退出，不能据此断定 Manager 离线。这是可验证上下文自检，不是完整 Manager 健康探针，也不代表宿主已经加载 Hook。

**尚未验收**：真实交互式任务上的 Hook 端到端验证未执行；已开启的会话需要重新加载（必要时重启会话）才能读取新配置。上述候选改动与隔离测试不代表已经构建、部署或上线。

### 5.6 待办与阻塞项

1. **原生桌面入口**：补齐能调用原 Desktop owner 的创建、打开、未加载任务初始化及投递入口，完成任务迁移。当前 Rabi 创建明确返回不支持，不转建到其它处理端。
2. **目标寻址与显示**：分别验证 primary 与其它任务的完整 ID、原生输入事件、实时运行状态及结果；原任务记录和 Rabi 页面不能替代 WorkBuddy 桌面验证。
3. **权限保持**：当前网关 handler 临时选择 `BypassPermissions`，需解决后才能宣称沿用原任务审批；不通过修改用户权限配置消除验收缺口。
4. **凭据与进程访问**：0.1.5 在现有 OS 权限下自动探测；权限不足时报告原进程访问失败，不自动提升权限。凭据轮换以 TTL 与鉴权拒绝失效处理。
5. **active turn 与幂等**：原生排队/steer/busy 语义仍需逐项实测；网关没有已确认的调用方幂等键。Rabi 保留原 intent、delivery 和 unknown，只核对原回执。
6. **生命周期与兼容**：分别独立冷启动、任务重载及宿主升级后重复验证。旧网关上的 404 作为该版本观测保留，不推断其它模式的能力。

### 5.7 能力对照：WorkBuddy 有什么，Rabi 这边就要有什么

“那边有什么能力，这边就要有什么”的落地口径：WorkBuddy 网关能提供的每一类语义，都要在 Rabi 侧的适配器合同里有明确落点；不能提供的，必须显式声明为不支持，不许虚报。

| WorkBuddy 侧实证能力 | Rabi 适配器合同 | 当前状态 |
| --- | --- | --- |
| `GET /sessions`（`id`/`name`/`cwd`/`updatedAt`/`status`/`isUserDefinedTitle`） | `listSessions(cursor/query)`、`readSession(id)` | **已实现**（`workbuddySessionStore` 读任务库，字段对齐） |
| `cwd=*` 跨项目查询 + `projectId` | `listWorkspaces()`、按工作目录筛选 | **已实现**（`listWorkbuddyWorkspaces` + 规范化比较） |
| `isUserDefinedTitle` 区分用户命名与自动标题 | 下拉名称真源 + `userNamed` | **已实现**（`custom_title` 优先，`title` 只作展示与检索） |
| `jobs/resumable`（`hasMore`/`nextOffset`） | 分页契约 `sessionPage` | **已实现**（`AgentScanSession` 分页字段） |
| 会话进程描述 + 心跳、原进程探测 | `health()`、owner 是否加载 | 已实现发现；自动探测可更新缺少地址或过期的描述，访问权限不足单独报告 |
| `POST /runs`（当前进程主会话优先） | `send(sessionId, delivery)` | 已实现网关调用；原主会话接收已验，其它目标、桌面实时输入与权限保持待验 |
| `GET /runs/{runId}` → `active` | `getTurnStatus(turnId)` | **已实现**（`waitForWorkbuddyTurn` 结算轮询，超时不视为失败） |
| CodeBuddy 生命周期 Hook（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`） | `updateAgentHooks(adapter)`、上下文注入、计划完成回传 | **已实现**（`plugins/rabi-workbuddy-context` + 用户级 settings 安装器；安装已实测，真实任务端到端待验收，见 5.5.3） |
| SSE `/jobs/events`、`/runs/{runId}/stream` | 流式事件 / `readResult` | 未实现；且实测部分网关上 404，须按能力探测后再声明 |
| `jobs/{id}/reply`（活会话立即投递 / 退出会话存 pending） | `steer` / `queue` | 未实现（语义与 `/runs` 的差异需实测确定） |
| `dispatch-context` 的 Agent 配置列表 | 模型/能力目录展示 | 未接；`modelInherited` 语义与 Rabi 的模型选择不同，需先定归属 |
| `POST /auth/login`、`auth/status` | `auth` 状态与重新登录入口 | 0.1.5 自动鉴权已在原进程验证；鉴权成功不替代目标身份和桌面显示验收 |
| 创建、打开、重命名、归档恢复与初始化 | 原 Desktop owner 元数据操作 | 当前 Rabi 适配器未实现；内部 handler 不是已接通的外部接口 |
| 附件（`payload.attachments`） | 本机图片入站 | 已接入 `type=image`、`urlType=local-path`、`url`、`name`；同一任务通过 Read 读取，正式安装与模型读取仍需运行验收 |

原则不变：业务与策略在 Rabi，宿主只提供会话与执行；不把 WorkBuddy 的作业系统建模成 Rabi 的计划或记忆真源。


## 6. 唯一真实消息路径

```text
RabiRoute event -> workbuddy adapter -> 原任务进程的 loopback 网关 -> primary session -> 原任务历史与回复
待验收：目标 ID 寻址、原生桌面实时输入/状态/结果、原权限保持
```

可能执行真实正文的代码路径数量必须为 1。`readWorkbuddySession`、`scanWorkbuddy`、`health`、以及任何只读探测都不得携带正文；这条要求要有测试守住。

## 7. 身份与 resolver 合同

以下是标准需求的目标合同。当前适配器已实现已有任务的读取与解析；归档后创建、零匹配创建、打开及初始化尚未实现，当前失败关闭。不能把目标规则作为已交付能力。

映射到标准需求的 P0 六条：

1. **有有效 `sessionId`**：读取 `sessions` 表确认 `deleted_at` 为空、`cwd` 与规范化的绑定 workspace 一致，且 `sessions/<pid>.json` 有心跳；随即精确投递该 ID，**不比较** `custom_title`、`title` 或任务默认目录。
2. **ID 归档**：真实投递或保存提交点按“旧 ID 隔离的幂等键”新建任务，不复用其它同名任务；扫描/刷新只报告归档状态。
3. **ID 为空/非法/不存在**：按 `custom_title` + 规范化 `cwd` 查询；一个或多个候选按 `updated_at` 降序绑定唯一最新者；最大时间并列才要求用户选择；零匹配且姓名由用户显式输入时幂等创建一次。
4. **保存即切换**：保存提交点复用与真实投递相同的 resolver，成功前写回完整 `sessionId`、名称、workspace。
5. **改名与默认目录变化不改变目标**：`custom_title` 变化、`title` 变化、`cwd` 默认值变化都继续同一 ID；用户在 Rabi 端显式输入新名称时，UI 先清空旧 ID。
6. **扫描按需**：进入设置界面自动一次，之后只由显式点击扫描触发；展开、输入、`blur`、保存、健康轮询和计时器都不得扫描。

create 幂等键：`agentProfile + normalizedWorkspace + requestedName`，single-flight，创建结果未知时先按幂等键重查。

## 8. 能力等级

**`experimental`**。当前 0.1.5 有查询、原生历史、自动鉴权和原主会话接收证据。任意任务寻址、原生桌面实时显示、权限保持、创建/初始化及独立生命周期验收未完成，不能升为 `verified`。包中声明消息处理与 Hook，不声明计划助手、记忆整理或宿主丢失回执恢复；声明可用入口不等于这些待验项已通过。

```ts
// 已落地的声明（只声明已经成立的事实）
workbuddy: {
  type: "workbuddy",
  label: "WorkBuddy（腾讯 AI 办公工作台）",
  maturity: "experimental",
  transport: { protocol: "http", mode: "session-gateway" },
  host: { name: "WorkBuddy Desktop", required: true },
  // 声明消息处理与 Hook 入口；原生桌面与权限验收边界见上表。
  // 计划助手、记忆整理和宿主丢失回执恢复尚未适配。
  capabilities: {
    managedTasks: {
      messageProcessingAgent: true,
      hooks: true
    }
  }
}
```

## 8.1 自动鉴权与可选本地凭据

Windows 0.1.5 首次扫描或投递使用 Manager 已有权限只读探测原任务进程，核对进程名、PID、创建时间与回环网关。凭据通过私有管道进入按端点隔离的内存缓存。目标进程不可访问时返回原因，不改变 OS 权限或 WorkBuddy 配置。

已配置的 `RABI_WORKBUDDY_GATEWAY_PASSWORD` 和本地凭据文件仍可使用。文件入口为扫描诊断返回的插件存储路径，也可通过 `RABI_WORKBUDDY_AUTH_FILE` 指定绝对路径；旧版 `data/workbuddy-auth.json` 仅是历史配置位置，不是当前自动鉴权的必填步骤。

```json
{ "password": "<WorkBuddy 会话网关密码>" }
```

鉴权拒绝使缓存失效；不重放被拒绝的请求。通信中断、5xx 或不可解析的成功响应继续保留原 unknown，并查询原回执。

## 9. 代码落点

按 skill 的“代码入口”清单，本方案需要改动：

| 文件 | 改动 |
| --- | --- |
| `src/shared/agentAdapterCapabilities.ts` | 新增 `workbuddy` 到 `agentAdapterTypes` 与 `manifestsByAgentType` |
| `src/agentAdapters/types.ts` | 无需额外分支，走统一 `parseAgentAdapterType` |
| `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionBridge.ts`（新） | 会话发现、resolver、投递、结果读取；结构对齐 `src/plugins/io.rabiroute.agent.dsh/src/dshSessionBridge.ts` |
| `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddyHttpAuth.ts`（新） | 凭据获取与缓存；结构对齐 `src/plugins/io.rabiroute.agent.dsh/src/dshHttpAuth.ts`（只存端点与来源路径，不存凭据） |
| `src/workbuddyWorkspaces.ts`（新） | 工作目录收集与规范化比较 |
| `src/agentAdapters/workbuddyAdapter.ts`（新） | 接口化 adapter，注册到 `builtinAgentAdapters.ts` |
| `src/plugins/io.rabiroute.agent.workbuddy/src/agentAdapters/workbuddyManagerApi.ts`（新） | `scanWorkbuddyAgent` / `getWorkbuddyStatus` / `openWorkbuddy` 等，由 `managerApi.ts` 聚合 |
| `src/agentAdapters/managerApi.ts` | 聚合新端，接入 `/api/scan/agents` 的 `agents.workbuddy` |
| `src/manager.ts` | 只做通用接线，不放 WorkBuddy 专属逻辑 |
| `ribiwebgui/src/types.ts`、`pages/RouteConfigPage.vue`、`components/QuickSetupDialog.vue` | Agent 卡片、参数面板、状态与动作按钮 |
| `README.md`、`docs/configuration.md`、`docs/current-capabilities.md` | 用户可见说明与成熟度口径 |

投递端绑定配置沿用 DSH 的形态：Route 的 `adapterConfig.json` 只保存 `workbuddySessionId` / `workbuddySessionName` / `workbuddyCwd` / `workbuddyEndpoint`；**凭据不写入路由配置**，另放本地忽略文件（参考 `data/dsh-auth.json` 只存端点与来源路径的做法）。

本次已落地（打勾）/ 待落地：

- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionStore.ts`（新）— 描述文件 + 任务库 + 规范化 + resolver
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionStore.test.ts`（新）— 8 个用例，含真实数据形态的回归
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddyHttpAuth.ts`（新）— 凭据读取与缓存、回环限制、TTL 与失效
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionBridge.ts`（新）— 绑定解析、投递前校验、投递、结算轮询
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/workbuddySessionBridge.test.ts`（新）— 12 个历史用例：报文格式、声明的目标字段、401/不可达/无 runId/空正文、超时、绑定与失败关闭
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/agentAdapters/workbuddyManagerApi.ts`（新）— `scanWorkbuddyAgentAdapter`，含凭据配置状态
- [x] `src/plugins/io.rabiroute.agent.workbuddy/src/agentAdapters/workbuddyManagerApi.test.ts`（新）— 3 个用例：真实形态列会话、分页与筛选、干净机器上的可行动空结果
- [x] `src/shared/agentAdapterCapabilities.ts` — 类型与 manifest（声明 `managedTasks.messageProcessingAgent` 与 `hooks`，不声明计划秘书、记忆整理与 `deliveryReceiptRecovery`）
- [x] `plugins/rabi-workbuddy-context/` — WorkBuddy Hook 插件包（`.codebuddy-plugin/plugin.json` + `hooks/hooks.json` + `scripts/`），与 `rabi-codex-context` 同构
- [x] `src/agentAdapters/hookInstallation.ts` — WorkBuddy 安装分支（复制到稳定路径 + 合并进 `~/.workbuddy/settings.json`，幂等、保留用户 hooks、拒绝覆盖非法 JSON）
- [x] `.codebuddy-plugin/marketplace.json` + `scripts/build-agent-hook-packages.mjs` — 插件 marketplace 随包分发
- [x] `src/agentAdapters/managerApi.ts` — 聚合到 `agents.workbuddy`、选项与 types 导出
- [x] `src/agentAdapters/builtinAgentAdapters.ts` — 接入 `notifyWorkbuddySession`
- [x] `src/manager/messageProcessingDeliveryTarget.ts`、`src/plugins/io.rabiroute.endpoint.rabilink/src/forwarding.ts` — 主人格投递目标支持 `workbuddy`
- [x] `src/shared/gatewayConfigModel.ts`、`src/plugins/io.rabiroute.agent.codex/src/config.ts` — 绑定字段、规范化与回环校验
- [x] `src/shared/agentInstance.ts` — 实例绑定白名单补齐 `workbuddy`
- [x] `ribiwebgui/` — Agent 卡片、任务下拉（带在线状态）、工作目录与网关地址字段
- [x] `README.md`、`docs/README.md`、`docs/current-capabilities.md`、`版本更新日志.md` 的本轮口径同步


## 10. 分阶段实施

| 阶段 | 内容 | 退出条件（必须留证据） |
| --- | --- | --- |
| **S0 探测** | 网关、会话、凭据与 owner 探测 | 报文与鉴权已观测；`primarySession` 优先，不能把 `conversation.id` 当作任意 ID 寻址保证 |
| **S1 最小纵向链路** | 原任务投递与桌面显示分别核对 | 原主会话 user/assistant 记录、回放及回执通过；原生桌面实时输入仍待验 |
| **S2 同 ID 复投** | 同一已核对原主会话重复接收 | 历史两次记录及任务数未变；不外推其它 `conversation.id` 目标 |
| **S3 负例** | owner 缺席、ID 归档、cwd 冲突、凭据失效 | 单测覆盖（不可达 / 401 / 无 runId / 空正文 / owner 缺席 / 无绑定）；尚未在真实网关上逐项制造 |
| **S4 WorkGUI** | 卡片、参数面板、扫描、诊断、动作按钮 | 卡片与参数面板已落地；扫描计数符合 P0 第 6 条；不写脏配置 |
| **S5 端到端与冷启动** | RabiRoute 停 → WorkBuddy 独立启动；WorkBuddy 停 → Manager 独立启动 | 未做：需在真实 Manager 进程上验证冷启动与重启后重新发现 |
| **S6 文档与成熟度** | 文档与实际验收一致 | 文档边界修正；升 `verified` 仍需原生显示、寻址、权限、创建/初始化和独立生命周期验收 |

任何阶段发现需要“第二条执行路径”“写用户级配置”或“只能证明记录可读”，立即停止并按停止条件回到设计门。

## 11. 验收测试矩阵

沿用标准需求第 9 节与本 skill 的验证清单，WorkBuddy 至少要覆盖：

- 会话列表：超过默认页大小仍可访问全部结果；`cwd=*` 与按目录查询结果一致。
- 同名消歧：同 `custom_title` + 同 `cwd` 按 `updated_at` 选唯一最新者；并列要求选择；`title` 变化不影响同 ID 续投。
- 幂等：并发保存只创建一个任务；创建返回但列表未刷新时立即重试返回同一 ID；超时先重查。
- 投递：同会话两次投递不新建；active turn 走排队或明确 busy；结果未知与明确失败可区分。
- 扫描计数：进入设置页 +1，显式点扫描 +1，展开/输入/`blur`/保存/空闲不增长。
- 冷启动：两端分别独立启停。
- 安全：`git diff` 确认未改用户级环境变量、注册表、WorkBuddy 配置与安装目录；凭据不出现在日志、示例与仓库。

## 12. 安全与隐私

- 凭据只存在于本地忽略文件或进程内存缓存，带过期与失效重取；不得进入仓库、示例、日志和构建产物。
- 只连接 loopback 端点；非回环地址直接拒绝，避免把本地启动凭据发到远端。
- 只在允许根目录内读取；不遍历用户其它文档。
- 投递正文与截图不进公开包；诊断输出脱敏端口以外的账号信息。
- RabiRoute 的 Action Gate 与 WorkBuddy 自身审批相互独立，WorkBuddy 的审批拒绝不得被绕过。

## 13. 风险与停止条件

| 风险 | 处理 |
| --- | --- |
| 凭据无法在进程外获取 | S0 未解决前不写投递代码；若只能由宿主交接，则按“宿主增强只补必要能力”单独评审，最小化到凭据交接一件事 |
| 网关 API 未文档化、随版本变 | 声明 `versionSensitive`，把端点探测集中在 `workbuddyHttpAuth.ts` / bridge 两个模块，升级前后跑同一套合同测试 |
| 投递进入的是“作业”而不是用户任务 | 判定为不满足 P0 第 3 条，保持 `experimental` 并明确写出缺口，不退化为后台 Runtime |
| 与 WorkBuddy 自带 IM 渠道冲突 | 不接管、不改写 WorkBuddy 的 wechat/wecom 渠道配置；RabiRoute 只做投递 |

停止条件（与设计门一致）：需要第二个 Runtime 才能隐藏错误、需要写用户级环境或宿主启动配置、测试只能证明记录可读、无法指出真实正文的唯一执行位置。

## 14. 与现有文档的关系

- [标准 Agent 端接入需求](agent-adapter-standard-requirements.md)：本文的实现标准。
- [Agent 端接入：历史问题、正确边界与验证手册](agent-adapter-integration-lessons.md)：解释这些边界为什么存在。
- [DSH Web 会话桥认证](dsh-browser-auth.md)：本地启动凭据获取的既有先例。
- [配置与接入](configuration.md)：用户侧如何配置已有 adapter。
- `skills/create-rabiroute-agent-adapter/SKILL.md`：把标准转成执行工作流。
