<!-- docs-language-switch -->
<div align="center">
<a href="./workbuddy-agent-adapter-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# WorkBuddy 作为 Agent 端的接入方案

> 状态：**设计中；发现层已实现，投递层未实现**。文中“已核实事实”来自对 WorkBuddy 5.5.6 本机安装的探测（只读 + 一次无害烟测消息）。会话发现、任务库读取与标准 resolver 已落地并通过自动化测试；投递与凭据获取仍未验收，`maturity` 保持 `experimental`，不得写成 `verified`。
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
  "cwd": "C:\\Data\\CottonProject\\RabiRoute",
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

`<workspace-slug>` 由工作目录压缩而来（例如 `c-Data-CottonProject-RabiRoute`），因此“按项目列会话”可以只读文件系统完成，但**不作为绑定真源**。

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

未通过的一项：用临时会话键投递烟测消息后返回 `202`、`GET /runs/{runId}` 返回 `active:true`，但 30 秒内**没有**产生新的桌面任务行，也没有出现在 `sessions?cwd=*` 里。也就是说，消息确实被接收并执行了，但“进入用户已有任务、由该任务 owner 执行、在桌面任务列表可见”尚未得到证明——这是 P0 第 3 条，也是当前唯一的阻塞缺口。


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
- `src/agentAdapters/workbuddyManagerApi.ts`：Manager 侧扫描/状态（`installed`、`auth`、`endpoints`、`projects`、`sessions` + 分页、`warnings`）。
- `workbuddy` 已注册进 `agentAdapterTypes` 与 manifest，`maturity: experimental`、`transport: http/session-gateway`、`host: WorkBuddy Desktop(required)`，并且**没有**声明 `managedTasks` 能力（避免在投递验收前虚报）。
- 投递保持失败关闭：`builtinAgentAdapters.ts` 里的 `workbuddy` 工厂在 `deliver` 直接抛出“投递尚未实现”，不引入第二条执行路径。
- WebGUI **故意不加卡片**：在投递未验收前让用户能选中一个必然失败的投递端，比不显示更糟。

### 5.6 待办与阻塞项

1. **桌面可见性**（阻塞）：证明 `POST /api/v1/runs` 的消息进入用户已有任务的对话区并由同一 owner 执行。若证明不了，等级只能是 `experimental`，并必须在文档写清缺口。
2. **凭据获取**：RabiRoute Manager 是独立进程，拿不到会话进程的 `CODEBUDDY_GATEWAY_PASSWORD`。候选路径：桌面“远程控制/配对”入口由用户一次性录入；或 user 设置显式写入 `gateway.password`；或宿主侧最小凭据交接。确定前不写投递代码。
3. **凭据轮换**：`regeneratePassword()` 的触发条件与频次，决定内存缓存的失效策略。
4. **steer / 排队**：任务正在执行时，投递是排队、`steer`，还是直接 busy。要求同会话连续两次投递不得新建任务。
5. **幂等键**：`/api/v1/runs` 实测未发现调用方幂等键；需要时由 RabiRoute 侧的去重账本承担。
6. **端点不一致**：`/api/v1/instances` 与 `/runs/{runId}/stream` 在实测网关上 404，说明内置 OpenAPI 规范包含未启用或模式相关的端点，集成时不能按规范假定可用。

### 5.7 能力对照：WorkBuddy 有什么，Rabi 这边就要有什么

“那边有什么能力，这边就要有什么”的落地口径：WorkBuddy 网关能提供的每一类语义，都要在 Rabi 侧的适配器合同里有明确落点；不能提供的，必须显式声明为不支持，不许虚报。

| WorkBuddy 侧实证能力 | Rabi 适配器合同 | 当前状态 |
| --- | --- | --- |
| `GET /sessions`（`id`/`name`/`cwd`/`updatedAt`/`status`/`isUserDefinedTitle`） | `listSessions(cursor/query)`、`readSession(id)` | **已实现**（`workbuddySessionStore` 读任务库，字段对齐） |
| `cwd=*` 跨项目查询 + `projectId` | `listWorkspaces()`、按工作目录筛选 | **已实现**（`listWorkbuddyWorkspaces` + 规范化比较） |
| `isUserDefinedTitle` 区分用户命名与自动标题 | 下拉名称真源 + `userNamed` | **已实现**（`custom_title` 优先，`title` 只作展示与检索） |
| `jobs/resumable`（`hasMore`/`nextOffset`） | 分页契约 `sessionPage` | **已实现**（`AgentScanSession` 分页字段） |
| 会话进程描述 + 心跳 | `health()`、owner 是否加载 | **已实现**（进程存活 + 心跳 + 已发布端点三重判定） |
| `POST /runs`（网关投递入口，`conversation.id` 即会话路由键） | `send(sessionId, delivery)` | **未实现**（凭据 + 桌面可见性未验收，当前失败关闭） |
| `GET /runs/{runId}` → `active` | `getTurnStatus(turnId)` | 未实现（依赖投递） |
| SSE `/jobs/events`、`/runs/{runId}/stream` | 流式事件 / `readResult` | 未实现；且实测部分网关上 404，须按能力探测后再声明 |
| `jobs/{id}/reply`（活会话立即投递 / 退出会话存 pending） | `steer` / `queue` | 未实现（语义与 `/runs` 的差异需实测确定） |
| `dispatch-context` 的 Agent 配置列表 | 模型/能力目录展示 | 未接；`modelInherited` 语义与 Rabi 的模型选择不同，需先定归属 |
| `POST /auth/login`、`auth/status` | `auth` 状态与重新登录入口 | 部分实现（`auth.required=true` + 文案；`loggedIn` 未知时**不显示已登录**） |
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

起步 **`experimental`**，已经在 `src/shared/agentAdapterCapabilities.ts` 注册，并且必须在扫描结果里写明“未完成端到端桌面可见性验证”。只有 S5 的真实端到端证据齐备后才可升 `verified`。

```ts
// 已落地的声明（只声明已经成立的事实）
workbuddy: {
  type: "workbuddy",
  label: "WorkBuddy（腾讯 AI 办公工作台）",
  maturity: "experimental",
  transport: { protocol: "http", mode: "session-gateway" },
  host: { name: "WorkBuddy Desktop", required: true },
  // 投递验收前不声明 managedTasks，避免把“消息处理 Agent / 计划秘书 /
  // 记忆整理 / Hook”四项能力虚报成可用。
  capabilities: {}
}
```

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
- [x] `src/agentAdapters/workbuddyManagerApi.ts`（新）— `scanWorkbuddyAgentAdapter`
- [x] `src/agentAdapters/workbuddyManagerApi.test.ts`（新）— 3 个用例：真实形态列会话、分页与筛选、干净机器上的可行动空结果
- [x] `src/shared/agentAdapterCapabilities.ts` — 类型与 manifest
- [x] `src/agentAdapters/managerApi.ts` — 聚合到 `agents.workbuddy`、选项与 types 导出
- [x] `src/agentAdapters/builtinAgentAdapters.ts` — 失败关闭的工厂
- [ ] `src/workbuddyHttpAuth.ts`（新）— 凭据获取与缓存：等 S0 定下获取路径
- [ ] `src/workbuddySessionBridge.ts`（新）— 投递与结果读取：等 P0 第 3 条验收
- [ ] `ribiwebgui/` 卡片与参数面板：投递可用后再加；现在**故意不显示**，避免用户选中一个必然失败的投递端
- [x] `README.md`、`docs/README.md`、`docs/current-capabilities.md`、`版本更新日志.md` 的本轮口径同步


## 10. 分阶段实施

| 阶段 | 内容 | 退出条件（必须留证据） |
| --- | --- | --- |
| **S0 探测** | 用临时脚本回答 5.6 的问题；只读 + 一次无害烟测 | **部分完成**：鉴权模型、会话列表字段、`runs` 报文格式、`conversation.id` 路由键已确认；桌面可见性与凭据获取仍开放 |
| **S1 最小纵向链路** | 发现一个真实任务 → 投递一条标记消息 → 在**桌面任务里**看到它 | 未通过：烟测消息被接受并执行，但没有进入用户已有任务，30 秒内未产生新的桌面任务 |
| **S2 同 ID 复投** | 向同一 ID 投第二条消息 | 不新建任务；会话总数不变 |
| **S3 负例** | owner 缺席、ID 归档、cwd 冲突、active turn、凭据失效 | 全部可行动失败，无 fallback，无第二会话 |
| **S4 WorkGUI** | 卡片、参数面板、扫描、诊断、动作按钮 | 扫描计数符合 P0 第 6 条；不写脏配置 |
| **S5 端到端与冷启动** | RabiRoute 停 → WorkBuddy 独立启动；WorkBuddy 停 → Manager 独立启动 | 双向冷启动通过；两次独立退出不互相拖死 |
| **S6 文档与成熟度** | README、配置、当前能力、中英文同步；必要时升 `verified` | 文档与代码一致；`npm run build` 通过 |

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
