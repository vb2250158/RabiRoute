<!-- docs-language-switch -->
<div align="center">
<a href="./workbuddy-agent-adapter-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# WorkBuddy 作为 Agent 端的接入方案

> 状态：**已实现；投递链路已端到端验证，凭据获取仍需手工一步**。文中“已核实事实”来自对 WorkBuddy 5.5.6 本机安装的探测与实测。会话发现、任务库读取、标准 resolver、凭据读取与投递桥均已落地并通过自动化测试，投递在独立进程（无 `CODEBUDDY_*` 环境变量）下验证：消息进入绑定任务的对话区、由同一任务 owner 执行、同 ID 复投不新建任务。因凭据仍需用户手工录入本地文件、桌面配对入口尚未提供，`maturity` 保持 `experimental`，不得写成 `verified`。
>
> 阅读前置：本文按 [标准 Agent 端接入需求](agent-adapter-standard-requirements.md) 编写，执行流程受 `skills/create-rabiroute-agent-adapter/SKILL.md` 和其 [owner-first 设计门](../skills/create-rabiroute-agent-adapter/references/owner-first-design-gate.md) 约束。

## 1. 目标与范围

把 WorkBuddy（腾讯 AI 办公工作台）接成 RabiRoute 的一个 **Agent 处理端**：RabiRoute 收到消息后，把正文投递到用户配置好的 WorkBuddy 任务（会话）里，由该任务真实执行，结果回到 RabiRoute 现有回传链路。

本文只解决“RabiRoute → WorkBuddy 的投递与发现”。不包含：

- 方向 ②（WorkBuddy 通过 MCP / Hook 调用 Rabi 接口）：属于工具接入，不是 Agent 端投递，另立方案。
- 消息入口：WorkBuddy 不是消息端，不新增 `src/adapters/` 下的消息适配器。

## 2. 零号关卡：用户可观察合同

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

## 5. 已核实事实（WorkBuddy 5.5.6，本机只读探测）

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
    "conversation": { "id": "<会话路由键>", "type": "direct" }
  },
  "payload": { "text": "<正文>", "attachments": [] }
}
```

两个必须记住的点：

1. 内置 OpenAPI 规范写的 `{text, sender:{id,name}}` **是错的**，实测缺 `id`/`type` 会返回 `400 BAD_REQUEST: Invalid generic message format`。字段默认值：`version`、`source`、`payload` 可省略，`payload.text` 也可由顶层 `text` 或 `prompt` 提供，`source.conversation.id` 缺省为消息 `id`。
2. **`source.conversation.id` 是会话路由键**：处理函数随后执行 `getOrCreateSession(source.conversation.id)`，同一个 `conversation.id` 复用同一个会话。这把 P0 的“同 ID 续投、不重复创建”变成协议原生能力：RabiRoute 把 `conversation.id` 固定为绑定的完整 `sessionId` 即可。

未通过的一项（**已解决**，见 5.5.1）：用临时会话键投递烟测消息后返回 `202`、`GET /runs/{runId}` 返回 `active:true`，但 30 秒内**没有**产生新的桌面任务行。当时的判断“消息没进用户任务”是错的——根因是把“新增任务行”当成了成功证据，而投递到指定 ID 的已有任务时**本来就不该**新建任务行。

### 5.5.1 桌面可见性与同 ID 复投（本次实测通过）

用绑定的真实 `sessionId` 作为 `source.conversation.id` 投递后，在 `~/.workbuddy/projects/<project-slug>/<sessionId>.jsonl` 中观察到：

- 一条 `type: "message" / role: "user"` 记录，`parentId` 指向该会话原有的最后一条 assistant 消息，正文与投递内容逐字一致。也就是说它是一条**正式用户回合**，不是旁路作业。
- 紧随其后是一条 `role: "assistant" / status: "completed"` 回复，`providerData.model` 为该会话自身的模型（实测 `deepseek-v4.1-flash`），由该任务的 Agent Runtime 执行。
- 连续两次投递写入**同一个** `<sessionId>.jsonl`；`sessions` 表行数保持不变（18 → 18），确认“同 ID 续投不新建任务”为协议原生行为。

独立进程复现（关键：该进程**没有** `CODEBUDDY_GATEWAY_PASSWORD`）：删除环境变量后，仅凭本地凭据文件读取网关密码，动态发现存活会话进程，投递成功返回 `202`，任务总数不变，消息出现在目标任务。这证明凭据获取路径与投递链路不依赖会话进程环境。

### 5.5.2 凭据获取（已定：本地忽略文件）

桌面把 `CODEBUDDY_GATEWAY_PASSWORD` 注入每个会话进程，RabiRoute Manager 是独立进程，读不到别人的环境。已实现的解析顺序：

1. `RABI_WORKBUDDY_GATEWAY_PASSWORD` 进程环境变量（测试与包装脚本用）。
2. `<state>/data/workbuddy-auth.json` 的 `{"password":"..."}`，与 `data/dsh-auth.json` 同址同形，已被 `.gitignore` 覆盖。

两者都没有时投递直接失败关闭，绝不发未鉴权请求，也绝不重放被 401 拒绝的投递。该文件只需在一次投递前准备好；密码轮换后模块会在 5 分钟 TTL 或首个 401 时重新读取。


### 为什么这里需要凭据，而 Codex 端不需要

Codex 端“直连投递”不是因为它免鉴权，而是因为**信任由传输层建立**：`src/codexDesktopBridge.ts` 连的是 Windows 命名管道 `\\.\pipe\codex-ipc`（POSIX 上是 `$TMPDIR/codex-ipc/ipc-<uid>.sock`），裸 `net.Socket`，全文件没有任何 token、Authorization 或握手代码——只有同机同用户的进程能打开该管道，内核 ACL 就是凭据。

WorkBuddy 每个会话对外只有 loopback HTTP，操作系统不区分调用者，任何本机进程都能连；因此网关必须在应用层自己鉴权，否则本机任意脚本都能驱动用户的会话。这不是多加一道手续，而是传输方式决定的：

- 会话描述文件只声明 HTTP `url`/`endpoint`，没有 IPC 地址。
- 进程与端口印证同一结论：会话进程（如 `sessions/62288.json` 对应 `127.0.0.1:1204`）以 TCP 监听方式对外提供服务。
- 实测 `GET /api/v1/sessions` 从 loopback 发出仍返回 `401 AUTH_REQUIRED`；`/api/v1/auth/status` 是唯一公开端点，且不提供任何可用信息。

本项目对 HTTP 型 Agent 端要凭据早有先例：`src/dshHttpAuth.ts` 整个模块就是为了获取 DSH 的令牌（从启动日志中取 `dsh web: ...?token=`，换成 HttpOnly cookie 后缓存在内存）；AstrBot 同样需要明确的会话 ID 与凭据。所以真正的待办不是“要不要凭据”，而是“独立进程如何获取一次”，且凭据只进本地忽略文件与内存缓存，不入仓库。

明确排除的替代方案：把 WorkBuddy 的 `gateway.auth` 改成 `none` 来免鉴权。这是安全降级（同机任意进程均可驱动该会话），且属于修改宿主配置，RabiRoute 不得实施；只有用户自行评估并接受风险后才可作为最后手段。

### 5.5 已实现部分（本次交付）

已落地并测试通过：

- `src/workbuddySessionStore.ts`：会话进程描述读取（含 `prewarm` 池的命名管道只作元数据）、任务库读取、工作目录规范化比较、标准 resolver。`deliverable` 判定要求**进程存活 + 心跳未过期 + 已发布网关地址 + 非 prewarm/teammate 类型**四条同时成立。
- `src/workbuddyHttpAuth.ts`：网关凭据读取与缓存。多来源按序解析（环境变量 → 本地忽略文件）；只允许回环地址；凭据只驻内存与本地文件，不入仓库、不入日志；5 分钟 TTL + 401 立即失效。
- `src/workbuddySessionBridge.ts`：**唯一真实消息路径**。绑定读取、投递前 owner/目录再校验、`POST /api/v1/runs` 投递、`GET /runs/{runId}` 结算轮询。四种失败结局可区分：`unreachable`（可安全重试）/ `rejected`（未生效）/ `unauthorized`（未生效且不重放）/ `unknown`（可能已生效，必须先核对）。
- `src/agentAdapters/workbuddyManagerApi.ts`：Manager 侧扫描/状态（`installed`、`auth`、`endpoints`、`projects`、`sessions` + 分页、`warnings`），并报告本地凭据是否已配置。
- `workbuddy` 已注册进 `agentAdapterTypes` 与 manifest，`maturity: experimental`、`transport: http/session-gateway`、`host: WorkBuddy Desktop(required)`，并声明 `managedTasks.messageProcessingAgent`（投递已可用）与 `managedTasks.hooks`（生命周期 Hook 已可用）；**未**声明计划秘书与记忆整理（这两条路径走 Codex/DSH 线程驱动，尚未适配），也**未**声明 `deliveryReceiptRecovery`——网关只返回一次性受理回执，不保留可读的入站日志。
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

**尚未验收**：真实交互式任务上的 hook 端到端验证未执行（已打开的会话需重启后才加载新配置），因此 §11 验收矩阵的 Hook 一行仍标注为待验收。

### 5.6 待办与阻塞项

1. **桌面可见性**（**已解决**，见 5.5.1）：投递进入用户已有任务的对话区，并由同一 owner 以该会话自身的模型执行；同 ID 复投不新建任务。
2. **凭据获取**（**已定，仍需手工一步**）：RabiRoute Manager 是独立进程，拿不到会话进程的 `CODEBUDDY_GATEWAY_PASSWORD`。当前由用户在 `<state>/data/workbuddy-auth.json` 一次性录入。**未解决问题**：桌面侧的“远程控制/配对”入口尚未提供自动交接，因此仍是手工步骤，也是等级停在 `experimental` 的主因。
3. **凭据轮换**：`regeneratePassword()` 的触发条件与频次未知；当前用 5 分钟 TTL + 401 立即失效兜底，轮换足够快时表现为一次可行动的失败而非错误投递。
4. **steer / 排队**：任务正在执行时，投递是排队、`steer`，还是直接 busy。已知同会话连续两次投递不新建任务且都能执行；具体排队语义尚未逐项验证。
5. **幂等键**：`/api/v1/runs` 实测未发现调用方幂等键；需要时由 RabiRoute 侧的去重账本承担。
6. **端点不一致**：`/api/v1/instances` 与 `/runs/{runId}/stream` 在实测网关上 404，说明内置 OpenAPI 规范包含未启用或模式相关的端点，集成时不能按规范假定可用。当前未依赖这两个端点。

### 5.7 能力对照：WorkBuddy 有什么，Rabi 这边就要有什么

“那边有什么能力，这边就要有什么”的落地口径：WorkBuddy 网关能提供的每一类语义，都要在 Rabi 侧的适配器合同里有明确落点；不能提供的，必须显式声明为不支持，不许虚报。

| WorkBuddy 侧实证能力 | Rabi 适配器合同 | 当前状态 |
| --- | --- | --- |
| `GET /sessions`（`id`/`name`/`cwd`/`updatedAt`/`status`/`isUserDefinedTitle`） | `listSessions(cursor/query)`、`readSession(id)` | **已实现**（`workbuddySessionStore` 读任务库，字段对齐） |
| `cwd=*` 跨项目查询 + `projectId` | `listWorkspaces()`、按工作目录筛选 | **已实现**（`listWorkbuddyWorkspaces` + 规范化比较） |
| `isUserDefinedTitle` 区分用户命名与自动标题 | 下拉名称真源 + `userNamed` | **已实现**（`custom_title` 优先，`title` 只作展示与检索） |
| `jobs/resumable`（`hasMore`/`nextOffset`） | 分页契约 `sessionPage` | **已实现**（`AgentScanSession` 分页字段） |
| 会话进程描述 + 心跳 | `health()`、owner 是否加载 | **已实现**（进程存活 + 心跳 + 已发布端点三重判定） |
| `POST /runs`（网关投递入口，`conversation.id` 即会话路由键） | `send(sessionId, delivery)` | **已实现**（`deliverWorkbuddyMessage`，失败关闭 + 四类结局可区分） |
| `GET /runs/{runId}` → `active` | `getTurnStatus(turnId)` | **已实现**（`waitForWorkbuddyTurn` 结算轮询，超时不视为失败） |
| CodeBuddy 生命周期 Hook（`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`） | `updateAgentHooks(adapter)`、上下文注入、计划完成回传 | **已实现**（`plugins/rabi-workbuddy-context` + 用户级 settings 安装器；安装已实测，真实任务端到端待验收，见 5.5.3） |
| SSE `/jobs/events`、`/runs/{runId}/stream` | 流式事件 / `readResult` | 未实现；且实测部分网关上 404，须按能力探测后再声明 |
| `jobs/{id}/reply`（活会话立即投递 / 退出会话存 pending） | `steer` / `queue` | 未实现（语义与 `/runs` 的差异需实测确定） |
| `dispatch-context` 的 Agent 配置列表 | 模型/能力目录展示 | 未接；`modelInherited` 语义与 Rabi 的模型选择不同，需先定归属 |
| `POST /auth/login`、`auth/status` | `auth` 状态与重新登录入口 | 部分实现（`auth.required=true` + 文案；只声明本地凭据**已配置**，不做假的登录校验） |
| 会话重命名、删除、归档恢复 | — | 按需再定；Rabi 当前不主张改写宿主任务元数据 |
| 附件（`payload.attachments`） | 图片/附件入站 | 未实现，等投递通道验收后再评估 |

原则不变：业务与策略在 Rabi，宿主只提供会话与执行；不把 WorkBuddy 的作业系统建模成 Rabi 的计划或记忆真源。


## 6. 唯一真实消息路径

```text
RabiRoute event -> workbuddy adapter -> loopback HTTP (会话网关) -> 该 sessionId 的会话进程 -> turn -> 桌面任务可见结果
```

可能执行真实正文的代码路径数量必须为 1。`readWorkbuddySession`、`scanWorkbuddy`、`health`、以及任何只读探测都不得携带正文；这条要求要有测试守住。

## 7. 身份与 resolver 合同

映射到标准需求的 P0 六条：

1. **有有效 `sessionId`**：读取 `sessions` 表确认 `deleted_at` 为空、`cwd` 与规范化的绑定 workspace 一致，且 `sessions/<pid>.json` 有心跳；随即精确投递该 ID，**不比较** `custom_title`、`title` 或任务默认目录。
2. **ID 归档**：真实投递或保存提交点按“旧 ID 隔离的幂等键”新建任务，不复用其它同名任务；扫描/刷新只报告归档状态。
3. **ID 为空/非法/不存在**：按 `custom_title` + 规范化 `cwd` 查询；一个或多个候选按 `updated_at` 降序绑定唯一最新者；最大时间并列才要求用户选择；零匹配且姓名由用户显式输入时幂等创建一次。
4. **保存即切换**：保存提交点复用与真实投递相同的 resolver，成功前写回完整 `sessionId`、名称、workspace。
5. **改名与默认目录变化不改变目标**：`custom_title` 变化、`title` 变化、`cwd` 默认值变化都继续同一 ID；用户在 Rabi 端显式输入新名称时，UI 先清空旧 ID。
6. **扫描按需**：进入设置界面自动一次，之后只由显式点击扫描触发；展开、输入、`blur`、保存、健康轮询和计时器都不得扫描。

create 幂等键：`agentProfile + normalizedWorkspace + requestedName`，single-flight，创建结果未知时先按幂等键重查。

## 8. 能力等级

**`experimental`**（投递可用，凭据手工配置）。已在 `src/shared/agentAdapterCapabilities.ts` 注册，并声明 `managedTasks.messageProcessingAgent` 与 `managedTasks.hooks`；**不声明**计划秘书与记忆整理（尚未适配），也**不声明** `deliveryReceiptRecovery`（网关只返回一次性受理回执，不保留可读的入站日志）。只有 S5 冷启动验证完成、且桌面配对入口可用后，才可升 `verified`。

```ts
// 已落地的声明（只声明已经成立的事实）
workbuddy: {
  type: "workbuddy",
  label: "WorkBuddy（腾讯 AI 办公工作台）",
  maturity: "experimental",
  transport: { protocol: "http", mode: "session-gateway" },
  host: { name: "WorkBuddy Desktop", required: true },
  // 只声明已经验证过的两条路径：计划秘书与记忆整理要走 Codex/DSH 线程驱动，
  // 适配完成前不声明，界面也就不会给出必然失败的操作面板。凭据仍需手工一步，
  // 故同样不声明回执恢复。
  capabilities: {
    managedTasks: {
      messageProcessingAgent: true,
      hooks: true
    }
  }
}
```

## 8.1 凭据准备（使用前唯一的手工步骤）

在 `<stateRoot>/data/workbuddy-auth.json` 写入（该路径已被 `.gitignore` 覆盖）：

```json
{ "password": "<WorkBuddy 会话网关密码>" }
```

未配置时扫描会给出可行动提示，投递直接失败关闭，不会发出未鉴权的请求。若已配置但被拒绝，请更新该文件后重试——RabiRoute 不会重放被 401 拒绝的投递。

## 9. 代码落点

按 skill 的“代码入口”清单，本方案需要改动：

| 文件 | 改动 |
| --- | --- |
| `src/shared/agentAdapterCapabilities.ts` | 新增 `workbuddy` 到 `agentAdapterTypes` 与 `manifestsByAgentType` |
| `src/agentAdapters/types.ts` | 无需额外分支，走统一 `parseAgentAdapterType` |
| `src/workbuddySessionBridge.ts`（新） | 会话发现、resolver、投递、结果读取；结构对齐 `src/dshSessionBridge.ts` |
| `src/workbuddyHttpAuth.ts`（新） | 凭据获取与缓存；结构对齐 `src/dshHttpAuth.ts`（只存端点与来源路径，不存凭据） |
| `src/workbuddyWorkspaces.ts`（新） | 工作目录收集与规范化比较 |
| `src/agentAdapters/workbuddyAdapter.ts`（新） | 接口化 adapter，注册到 `builtinAgentAdapters.ts` |
| `src/agentAdapters/workbuddyManagerApi.ts`（新） | `scanWorkbuddyAgent` / `getWorkbuddyStatus` / `openWorkbuddy` 等，由 `managerApi.ts` 聚合 |
| `src/agentAdapters/managerApi.ts` | 聚合新端，接入 `/api/scan/agents` 的 `agents.workbuddy` |
| `src/manager.ts` | 只做通用接线，不放 WorkBuddy 专属逻辑 |
| `ribiwebgui/src/types.ts`、`pages/RouteConfigPage.vue`、`components/QuickSetupDialog.vue` | Agent 卡片、参数面板、状态与动作按钮 |
| `README.md`、`docs/configuration.md`、`docs/current-capabilities.md` | 用户可见说明与成熟度口径 |

投递端绑定配置沿用 DSH 的形态：Route 的 `adapterConfig.json` 只保存 `workbuddySessionId` / `workbuddySessionName` / `workbuddyCwd` / `workbuddyEndpoint`；**凭据不写入路由配置**，另放本地忽略文件（参考 `data/dsh-auth.json` 只存端点与来源路径的做法）。

本次已落地（打勾）/ 待落地：

- [x] `src/workbuddySessionStore.ts`（新）— 描述文件 + 任务库 + 规范化 + resolver
- [x] `src/workbuddySessionStore.test.ts`（新）— 8 个用例，含真实数据形态的回归
- [x] `src/workbuddyHttpAuth.ts`（新）— 凭据读取与缓存、回环限制、TTL 与失效
- [x] `src/workbuddySessionBridge.ts`（新）— 绑定解析、投递前校验、投递、结算轮询
- [x] `src/workbuddySessionBridge.test.ts`（新）— 12 个用例：报文格式、路由键、401/不可达/无 runId/空正文、超时、绑定与失败关闭
- [x] `src/agentAdapters/workbuddyManagerApi.ts`（新）— `scanWorkbuddyAgentAdapter`，含凭据配置状态
- [x] `src/agentAdapters/workbuddyManagerApi.test.ts`（新）— 3 个用例：真实形态列会话、分页与筛选、干净机器上的可行动空结果
- [x] `src/shared/agentAdapterCapabilities.ts` — 类型与 manifest（声明 `managedTasks.messageProcessingAgent` 与 `hooks`，不声明计划秘书、记忆整理与 `deliveryReceiptRecovery`）
- [x] `plugins/rabi-workbuddy-context/` — WorkBuddy Hook 插件包（`.codebuddy-plugin/plugin.json` + `hooks/hooks.json` + `scripts/`），与 `rabi-codex-context` 同构
- [x] `src/agentAdapters/hookInstallation.ts` — WorkBuddy 安装分支（复制到稳定路径 + 合并进 `~/.workbuddy/settings.json`，幂等、保留用户 hooks、拒绝覆盖非法 JSON）
- [x] `.codebuddy-plugin/marketplace.json` + `scripts/build-agent-hook-packages.mjs` — 插件 marketplace 随包分发
- [x] `src/agentAdapters/managerApi.ts` — 聚合到 `agents.workbuddy`、选项与 types 导出
- [x] `src/agentAdapters/builtinAgentAdapters.ts` — 接入 `notifyWorkbuddySession`
- [x] `src/manager/messageProcessingDeliveryTarget.ts`、`src/forwarding.ts` — 主人格投递目标支持 `workbuddy`
- [x] `src/shared/gatewayConfigModel.ts`、`src/config.ts` — 绑定字段、规范化与回环校验
- [x] `src/shared/agentInstance.ts` — 实例绑定白名单补齐 `workbuddy`
- [x] `ribiwebgui/` — Agent 卡片、任务下拉（带在线状态）、工作目录与网关地址字段
- [x] `README.md`、`docs/README.md`、`docs/current-capabilities.md`、`版本更新日志.md` 的本轮口径同步


## 10. 分阶段实施

| 阶段 | 内容 | 退出条件（必须留证据） |
| --- | --- | --- |
| **S0 探测** | 用临时脚本回答 5.6 的问题；只读 + 一次无害烟测 | **已完成**：鉴权模型、会话列表字段、`runs` 报文格式、`conversation.id` 路由键、凭据解析顺序全部确认 |
| **S1 最小纵向链路** | 发现一个真实任务 → 投递一条标记消息 → 在**桌面任务里**看到它 | **已通过**：消息以正式用户回合写入目标 `<sessionId>.jsonl`，由该任务以自身模型执行并回复；独立进程（无环境变量）复现成功 |
| **S2 同 ID 复投** | 向同一 ID 投第二条消息 | **已通过**：两次投递写入同一会话文件，任务总数 18 → 18 不变 |
| **S3 负例** | owner 缺席、ID 归档、cwd 冲突、凭据失效 | 单测覆盖（不可达 / 401 / 无 runId / 空正文 / owner 缺席 / 无绑定）；尚未在真实网关上逐项制造 |
| **S4 WorkGUI** | 卡片、参数面板、扫描、诊断、动作按钮 | 卡片与参数面板已落地；扫描计数符合 P0 第 6 条；不写脏配置 |
| **S5 端到端与冷启动** | RabiRoute 停 → WorkBuddy 独立启动；WorkBuddy 停 → Manager 独立启动 | 未做：需在真实 Manager 进程上验证冷启动与重启后重新发现 |
| **S6 文档与成熟度** | README、配置、当前能力、中英文同步；必要时升 `verified` | 文档与代码一致；构建通过。升 `verified` 的前置是 S5 完成且桌面配对入口可用 |

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
