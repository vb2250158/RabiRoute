---
name: create-rabiroute-message-adapter
description: 新增或改造 RabiRoute 消息端适配器时使用。覆盖平台接入、多个实例/账号、启动后台、WebSocket/HTTP/Webhook/定时触发、事件规范化、消息历史、路由触发、安全外发边界、独立消息端 Manager 模块、RibiWebGUI 自动化配置和验证流程；适用于 NapCat/OneBot、小米音箱/小爱、FenneNote/芬妮笔记、Heartbeat、QQ、微信、飞书、Discord、Slack、Telegram、AstrBot 平台入口、通用 Webhook 或其他消息来源。
---

# 创建 RabiRoute 消息端适配器

## 目标

新增消息端时，不只是接收一段文本。必须让用户能在 WebGUI 里尽量自动完成配置、启动、检查和诊断：

1. 自动发现安装位置、运行状态、登录状态、WebUI/Dashboard、HTTP/WS 端口和可用实例。
2. 平台支持多账号/多实例时，必须按“实例列表”建模，不能把多个账号塞进一个输入框。
3. 能启动的后台要提供启动按钮；不能启动的要提供打开目录、打开管理页、复制启动命令或安装链接。
4. 能扫描的不要让用户手填；必须提供刷新、打开、检查、复制地址、健康检查等动作入口。
5. 运行态要能解释“为什么不可用”，不能只给一个空输入框或沉默失败。
6. 外部发送、群发、写平台消息默认必须有安全边界；配置/健康检查不能偷偷发送真实消息。
7. 添加消息端后必须显示“环境和依赖”清单：需要安装什么、当前识别到什么、缺什么、去哪下载/打开文档、下一步怎么配置。

NapCat / OneBot 是多实例消息端的基线：一个 route 可以配置多个 NapCat 实例，每个实例有自己的 WS 监听端口、HTTP 地址、WebUI、token、启动命令和工作目录。收到哪个实例的事件，就必须用哪个实例的 HTTP 地址发送回复，避免串号。

## 命名规范：不要把具体来源都叫 Webhook

`webhook` 是传输方式，不是多数用户要理解的消息端名称。除非新增的入口确实是“给开发者随便 POST 的通用 Webhook”，否则 WebGUI、配置项、日志、状态和文档都必须使用具体来源名：

- 小爱 / 小米音箱入口显示为“小米音箱”或“小爱音箱”，不要显示成“Webhook”。
- FenneNote 语音转写入口显示为“FenneNote”或“芬妮笔记”，不要显示成“Webhook”。
- Home Assistant、桌面语音、插件桥、平台回调等都按真实来源命名。
- 技术字段可以保留 `webhookUrl`、`webhookPath`、`adapterType: "webhook"` 这类底层兼容字段，但用户可见标题、按钮、日志标题和消息文件分组必须用具体来源名。

新增消息端前先回答两个问题：

1. 用户看到它时会把它理解成哪个“来源/设备/应用”？
2. 如果日志里出现三条事件，用户能不能一眼分清是“小米音箱”、 “芬妮笔记”还是“通用 Webhook”？

如果答案不清楚，就不要新增一个泛泛的 `Webhook` 卡片；应该新增具体消息端或至少在实例名中固定写明来源。

## 统一能力模型

每个消息端都要先声明能力，再决定 UI 显示什么字段：

```ts
type MessageAdapterCapability = {
  type: MessageAdapterType;
  label: string;
  maturity: "verified" | "experimental" | "stub";
  requiresInstall: boolean;
  requiresAuth: boolean;
  hasInstances: boolean;
  canListInstances: boolean;
  canLaunchInstance: boolean;
  hasDashboard: boolean;
  hasInboundHttp: boolean;
  hasInboundWebSocket: boolean;
  hasOutboundApi: boolean;
  canHealthCheck: boolean;
  canReadLoginInfo: boolean;
  canDryRun: boolean;
};
```

能力模型是产品合同：

- `verified`：真实跑通过安装/启动检查、接收事件、路由、失败诊断；如有外发 API，也验证了 dry-run 或受控发送。
- `experimental`：代码存在，但没有完成端到端验证；WebGUI 必须显示“实验/未验证”提示。
- `stub`：只是占位、打开页面或复制命令；不能默认启用。
- `hasInstances=true` 时 UI 必须是实例列表，可添加/删除/启用/检查/启动。
- `canLaunchInstance=false` 时不要显示“启动后台”，改显示启动说明或打开目录。
- `hasOutboundApi=false` 时不要显示“回复/发送已可用”，只显示接收能力。
- `canReadLoginInfo=false` 时健康检查不能伪装成已登录，只能显示连接可达。

## 先判断消息端类型

实现前先确认目标消息端属于哪类：

- **平台机器人型**：QQ/NapCat、微信、飞书、Discord、Slack、Telegram；通常有账号、登录态、收消息和发消息 API。
- **OneBot/协议桥型**：NapCat、Lagrange、go-cqhttp 类；通常有 WS 事件入口和 HTTP action 出口。
- **Webhook 型**：外部系统 POST 到 RabiRoute；通常没有会话和登录态，但要有 secret、样例 payload 和 curl。
- **定时/内部触发型**：heartbeat、manual trigger；没有外部平台，但会主动制造内部事件。
- **语音/设备事件型**：FenneNote、小爱、Home Assistant；需要保留来源、转写、设备、附件或上下文路径。
- **平台框架插件型**：AstrBot 等框架内插件；可能由插件把平台事件转成 RabiRoute 事件。

不要为了统一 UI 强行显示不存在的字段。字段由能力决定。

## 先摸清真实 API

做任何消息端适配前，先用最小脚本或临时命令验证目标平台的真实能力。不要先写 WebGUI。

必须按这个顺序探测：

1. **安装/进程检查**：确认平台 app、协议桥、插件或服务是否存在。
2. **启动方式**：确认能否通过命令、服务、Shell、URL 或插件后台启动；记录启动命令和工作目录。
3. **认证/登录检查**：确认是否需要二维码、账号、token、cookie、device code、secret 或本机登录态。
4. **实例/账号检查**：如果支持多账号，确认实例 id、QQ/账号、端口、配置文件位置和 WebUI。
5. **入站事件测试**：用 mock 或真实平台测试收到一条无害事件，确认 raw payload 能落盘。
6. **事件规范化测试**：确认能转成 RabiRoute 的统一字段：来源、时间、目标、发送者、消息、回复链、附件。
7. **路由触发测试**：确认普通消息、@、直接回复、间接回复、私聊、Webhook、心跳等 route kind 正确。
8. **外发能力测试**：如果平台支持发送，先只测读取登录态或 dry-run；真实外发必须用户明确授权。
9. **同实例回路测试**：确认某实例收到的消息只会用同一实例的出口回复，不会串到另一个账号。
10. **重复事件/重连测试**：确认断线重连、重复 message id、重复 webhook 不会重复投递 Agent。

测试消息必须无害、可识别、可公开。真实平台外发测试必须先征得用户明确同意。

探测结果要沉淀成事实记录，至少包括：

- 使用了哪个 API / CLI / 配置文件 / WebUI。
- 能否列实例或账号。
- 每个实例字段有哪些：id、name、account、wsPort、httpUrl、webuiUrl、token、launchCommand。
- 能否启动后台，启动后如何确认成功。
- 能否读取登录资料或账号状态。
- 能否接收入站事件，raw payload 示例的字段摘要。
- 能否外发，外发是否需要安全门。
- 是否支持多实例，是否验证了“同实例入口 -> 同实例出口”。
- 失败点、错误原文摘要和下一步。

没跑通前，该消息端只能标 `experimental` 或 `stub`。不要因为 UI 已经有字段就暗示稳定可用。

## 代码入口

新增一个消息端通常要改这些位置：

- `src/adapters/messageAdapter.ts`：扩展 `MessageAdapterType`。
- `src/adapters/<name>Adapter.ts`：实现 `MessageAdapter.start()`，负责接收事件、规范化、落盘、路由。
- `src/index.ts`：把 type 映射到 adapter，并支持多 adapter 并存。
- `src/config.ts`：解析环境变量和结构化配置；多实例用 JSON 配置。
- `src/messageEndpoints/<name>Manager.ts` 或同目录聚合模块：实现该消息端的扫描、健康检查、启动、打开管理页、实例发现和修复建议。
- `src/manager.ts`：只扩展通用 `GatewayDefinition` 字段、normalize、env 注入和 HTTP 路由接线；不要把消息端专属扫描/启动/健康检查实现写进 manager。
- `ribiwebgui/src/types.ts`：同步 gateway 字段、实例类型和状态类型。
- `ribiwebgui/src/utils/gatewayHelpers.ts`：默认值、校验、错误解释。
- `ribiwebgui/src/pages/RouteConfigPage.vue`：消息端卡片、参数面板、实例列表、检查/启动/打开/复制按钮。
- `ribiwebgui/src/components/QuickSetupDialog.vue`：如果适合首次配置，提供精简但不误导的入口。
- `ribiwebgui/src/pages/RuntimeLogPage.vue`：显示运行态、实例态、最近错误和日志。
- `README.md`、`docs/configuration.md` 或示例：只补公开、安全、可复制的说明。

如果新增的是 Agent 处理端，不要用本 skill；Agent 端走 `create-rabiroute-agent-adapter`。

## Manager 模块化边界

`src/manager.ts` 是编排层，不是消息端实现层。新增或改造消息端时，遵守这个边界：

- 消息端专属逻辑放在 `src/messageEndpoints/`：进程发现、Dashboard/WebUI token、插件目录扫描、服务 health、实例列表、启动命令、修复建议和 scan payload 组装。
- `manager.ts` 只构造上下文 `ctx` 并接 HTTP API：`rootDir`、runtime 读取器、状态读取器、日志追加、通用 HTTP 检查、通用路径/配置 helper。
- 通用配置 normalize、runtime start/stop、日志读取、端口校验可以暂留 `manager.ts`；不要为了新增一个端把通用逻辑重写一份。
- 新模块不能 import `src/manager.ts`，也不能依赖 `ribiwebgui`、浏览器 `window/document` 或前端状态。
- 多端扫描用组合方式：`messageAdapterScanPayload()` 调 `scan<Name>Endpoint(ctx)`，再拼成统一响应。

当前参考模块：

- `src/messageEndpoints/napcatManager.ts`：NapCat 进程、WebUI token、health、launch、scan。
- `src/messageEndpoints/webhookLikeScans.ts`：FenneNote / XiaoAI / 通用 Webhook scan。

如果一个消息端后续变复杂，优先新增自己的 `src/messageEndpoints/<type>Manager.ts`，不要继续扩大 `webhookLikeScans.ts`。

## UX 合同

消息端参数面板的顺序固定按依赖关系走：

1. **消息端类型 / 实例列表**
2. **环境和依赖清单**：安装状态、外部服务、桥接层、插件、下载/文档入口、缺失项。
3. **安装位置 / 启动命令 / 工作目录**（如果可启动）
4. **入站地址**：WS 端口、Webhook URL、插件 endpoint
5. **出站地址**：HTTP API、token、发送 API
6. **Dashboard / WebUI 地址**
7. **认证、健康检查、启动、打开、复制动作**
8. **运行时诊断**

不要让用户先填“会话”或抽象字段。消息端先要明确“哪个平台/哪个账号/哪个端口”。

能自动化的字段使用控件，不用裸输入框：

- 多实例：列表或表格；每行有启用、名称、端口、HTTP、WebUI、启动命令、检查、打开、复制、删除。
- URL：默认值 + 最近成功地址 + 打开按钮 + 健康检查。
- 端口：数字输入 + 自动递增 + 端口占用提示。
- 启动命令：可以手填，但要显示“保存后启动”；不要执行未保存命令。
- token/secret：显示是否填写；避免泄露明文，必要时用 password field。
- Webhook/HTTP 回调：用户可见名称优先使用真实来源；显示完整 URL、复制 curl 示例、payload 示例，不自动 POST。
- Heartbeat：显示间隔、消息、立即触发按钮；按钮点击才投递内部事件。

消息端卡片必须显示统一状态：

- 名称和简短说明。
- 等级 chip：已验证 / 实验 / 占位。
- 连接 chip：未安装 / 未登录 / 未启动 / 已连接 / HTTP 异常 / 插件缺失。
- 如果不是 `verified`，展开面板顶部显示短 warning。
- 展开面板顶部必须有依赖清单，不要只给 URL 输入框。依赖项要能区分“已满足 / 缺少 / 未发现 / 需人工确认”。

## 依赖、安装和下载入口

每个消息端都要提供 Manager 扫描结果，至少能回答：

- 需要安装哪些外部工具、插件、桥接服务或桌面端。
- 当前本机是否发现安装、进程、服务、Dashboard、WebUI 或回调入口。
- 哪些项是必需项，哪些是可选项。
- 如果缺失，用户下一步应点击哪里：下载页、官方文档、本地 runbook、WebUI、配置目录或复制启动命令。
- 哪些状态无法自动判断，必须明确标记为“需人工确认”，不能伪装成已通过。

推荐统一返回结构：

```ts
type MessageAdapterScanResult = {
  type: MessageAdapterType;
  label: string;
  maturity: "verified" | "experimental" | "stub";
  installed: boolean;
  installCandidates?: Array<{ label: string; url?: string; path?: string }>;
  endpoints?: Array<{ label: string; url: string; healthy?: boolean }>;
  requirements?: Array<{
    id: string;
    label: string;
    required?: boolean;
    ok?: boolean;
    detail?: string;
    actionLabel?: string;
    url?: string;
    path?: string;
  }>;
  warnings?: string[];
};
```

`ok` 的语义固定：

- `true`：自动检测通过。
- `false`：自动检测失败或缺失。
- `undefined`：不能自动判断，需要用户确认或依赖外部工具自身状态。

具体来源要求：

- **FenneNote / 芬妮笔记**：必须说明 RabiRoute 不内置 FenneNote；需要安装并运行 FenneNote/语音转写端，把转写 webhook 指到 RabiRoute；需要播报时再接 OumuQ/TTS worker。UI 要显示 RabiRoute 回调入口、FenneNote 播放/回复端是否可达、最近是否收到转写事件。
- **小米音箱 / 小爱**：必须说明 RabiRoute 不能直接连接音箱；需要 PC 侧桥接服务（如 `plugin-adapters/xiaoai-rabiroute`）以及音箱侧 open-xiaoai/xiaogpt/自定义桥。UI 要显示桥服务 `/health`、小爱回调入口、runbook、open-xiaoai/xiaogpt 文档和最近事件。
- **NapCat / OneBot**：必须显示 NapCat/QQNT 进程、WebUI、OneBot HTTP 登录资料、WS 地址和多实例状态；支持添加多个 QQ 实例。
- **通用 Webhook**：必须强调它是兜底入口；如果来源有具体名称，应新增具体消息端而不是继续叫 Webhook。

## 多实例要求

平台支持多账号或多后台时，必须用结构化实例数组：

```ts
type MessageAdapterInstance = {
  id: string;
  name?: string;
  enabled?: boolean;
  accountId?: string;
  gatewayPort?: number;
  httpUrl?: string;
  webuiUrl?: string;
  accessToken?: string;
  launchCommand?: string;
  workingDir?: string;
};
```

兼容旧字段，但不要只停留在旧字段：

- 旧 `gatewayPort`、`napcatHttpUrl`、`napcatWebuiUrl` 自动映射为 `instances[0]`。
- 保存时可以继续写旧字段，作为默认实例兼容；新逻辑以 `instances` 为准。
- 新增实例时端口自动递增，id 自动去重。
- 删除最后一个实例时阻止删除或自动创建默认实例。
- 禁用实例后不启动它的监听，也不显示为已连接。

多实例最重要的安全要求：

- 入站事件必须携带 `instanceId` 或等价上下文。
- 外发 API 必须根据事件来源实例选择 endpoint。
- 不能用全局 `config.napcatHttpUrl` 回复所有实例。
- 状态文件要按实例记录连接、登录、消息数、最后错误。
- UI 要显示每个实例的 WS、HTTP、WebUI 和登录资料，不能只显示总状态。

## Manager API 要求

每个消息端都要在 Manager 侧提供扫描/状态能力。可以扩展通用 API，也可以按类型新增：

```text
GET  /api/message/<type>/scan
GET  /api/message/<type>/status
POST /api/message/<type>/health
POST /api/message/<type>/launch
POST /api/message/<type>/open
POST /api/message/<type>/dry-run
```

实现时优先让 `src/messageEndpoints/<type>Manager.ts` 暴露这些函数，再由 `manager.ts` 接线：

```ts
scan<Type>Endpoint(ctx)
test<Type>Health(ctx, request)
launch<Type>Instance(ctx, request)
open<Type>Dashboard(ctx, request)
```

返回 JSON shape 必须和 WebGUI 已消费的结构兼容。迁移旧逻辑时先接新模块再删除 manager 内旧实现，并运行 `npm run build`。

健康检查结果至少表达：

```ts
type MessageAdapterHealth = {
  ok: boolean;
  message?: string;
  instanceId?: string;
  install?: { found: boolean; candidates?: Array<{ label: string; path?: string }> };
  process?: { found: boolean; candidates?: Array<{ name: string; pid: string }> };
  inbound?: { reachable?: boolean; url?: string; connected?: boolean };
  outbound?: { ok?: boolean; status?: number; message?: string };
  dashboard?: { reachable?: boolean; url?: string };
  auth?: { loggedIn?: boolean; accountId?: string; nickname?: string; message?: string };
  warnings?: string[];
};
```

启动 API 要求：

- 只启动已保存配置中的实例，不执行请求体里临时传入的任意命令。
- 启动结果写入 runtime log。
- 如果缺启动命令，返回可行动错误：“请填写启动命令并保存”。
- 不要自动填 QQ/平台密码，不绕过二维码、设备锁、风控或验证码。

## 事件规范化

每个消息端都要把 raw event 转成 RabiRoute 可路由记录。至少保留：

- `adapterType`
- `instanceId`
- `routeKind`
- `time`
- `messageTarget`
- `targetType`
- `targetId`
- `sender`
- `senderId`
- `messageId`
- `rawMessage`
- `normalizedText`
- `repliedMessageId`
- `repliedMessage`
- `attachments`
- `rawPayloadPath`

Raw payload 要落盘，方便重放和排障。规范化失败也要写错误日志，不要吞事件。

## 路由与安全边界

消息端只负责接收、规范化、落盘和触发路由，不应该直接决定 Agent 如何处理复杂任务。

外发规则：

- 健康检查、扫描、打开页面、复制命令不能发送真实平台消息。
- 自动外发默认关闭；只有配置明确允许或用户当场授权时才能 commit。
- QQ/群聊/私聊等外发要走现有 action safety gate 或明确的发送函数。
- 语音转写要求“发到 QQ”时，必须检查目标、内容和授权是否足够；不足则生成草稿或追问。
- 防反馈回路：忽略 self message、识别 TTS 回录、记录已处理 message id。

## 状态文件和诊断

每个消息端需要写状态到当前 route 的 `dataDir/gateway-status.json`。多实例建议：

```json
{
  "messageAdapter": {
    "type": "napcat",
    "status": "running",
    "message": "NapCat / OneBot 消息适配端已启动：2 个实例。",
    "updatedAt": "2026-06-07T00:00:00.000Z"
  },
  "napcatInstances": {
    "main": {
      "connected": true,
      "activeConnections": 1,
      "gatewayPort": 8789,
      "httpUrl": "http://127.0.0.1:3000",
      "webuiUrl": "http://127.0.0.1:6099/webui",
      "botUserId": "123",
      "botNickname": "Rabi",
      "lastMessageAt": "2026-06-07T00:00:00.000Z",
      "lastLoginInfoAt": "2026-06-07T00:00:00.000Z",
      "loginInfoError": ""
    }
  }
}
```

WebGUI 诊断区至少显示：运行状态、实例状态、WS 连接、HTTP 登录资料、WebUI 可达、最后消息、最后断开、最后错误、状态文件路径。

错误要转成用户能行动的中文提示：

- 端口占用：显示占用端口和建议换端口。
- HTTP 不可用：显示当前 HTTP 地址和打开 WebUI 按钮。
- 未登录：显示登录/扫码/管理页入口。
- 启动命令缺失：提示填写启动命令并保存。
- 实例禁用：说明不会启动监听。

## WebGUI 实现要求

- 打开消息端参数面板时自动触发该消息端的状态检查或显示最近状态。
- 扫描/检查/打开/复制按钮总是可见；列表为空时显示“添加实例”而不是空白。
- 添加消息端后自动展开参数面板。
- 多实例每行都能独立检查、打开、复制、启动。
- 保存前校验必要字段：端口合法、URL 格式合理、实例 id 非空且去重。
- 启动按钮只对已保存实例可靠；未保存时提示先保存。
- 快速配置只放最常用链路，但必须复用同一套概念：类型 -> 实例/地址 -> 检查/打开/复制 -> Agent -> 人格。
- 不要把消息端做成一堆 checkbox；应使用下拉/多选和参数面板。

## NapCat 特别要求

NapCat 支持多账号/多后台管理时，RabiRoute 也要支持多实例：

- 每个实例配置自己的 `gatewayPort`、`httpUrl`、`webuiUrl`、`accessToken`、`launchCommand`、`workingDir`。
- WS 监听可以由 RabiRoute 启动多个端口。
- HTTP action 必须按来源实例选择，不允许所有实例共享一个全局 HTTP 地址。
- 健康检查至少检查 OneBot `get_login_info`、WebUI 是否可达、本机 QQ/NapCat 相关进程、当前 WS 地址。
- WebUI 登录 Token 和 OneBot HTTP Access Token 是两个不同配置：UI 必须分别命名，不允许都叫 `token`。能读取 `config/webui.json` 时，提供“打开带 Token”和“复制 WebUI Token”，但不要明文展示完整 token。
- 启动后台按钮只启动保存过的 `launchCommand`；不替用户登录 QQ，不保存 QQ 密码。
- UI 要能复制 `ws://127.0.0.1:<gatewayPort>`，方便填到 NapCat WebSocket Client。
- 如果配置了多个实例但只有一个连接，状态要按实例显示，不要只显示总“已连接”。

## Webhook / HTTP 回调特别要求

先判断它是不是“通用 Webhook”：

- 如果是小米音箱/小爱、FenneNote/芬妮笔记、Home Assistant、桌面语音、插件桥等具体入口，UI 卡片标题、日志区、消息文件区和快速配置选项都用具体名称。
- 只有面向任意外部系统的兜底入口才叫“通用 Webhook”。
- 不要把多个来源塞进一个 Webhook 卡片；不同来源有不同 payload、日志、消息文件和排障入口时，应该拆成独立消息端或独立实例。

- 显示完整 URL，不只显示端口和 path。
- 提供复制 URL 和复制 curl 示例。
- curl 示例默认只复制，不自动发送。
- 如支持 secret，显示 secret 是否已配置，不显示明文。
- 支持 payload 示例、最近请求状态和 raw payload 日志路径。
- 真实 POST 会触发路由；自动测试前必须提醒用户或使用 dry-run endpoint。

## Heartbeat / Manual Trigger 特别要求

- 间隔和消息可配置。
- 提供“立即触发”按钮；按钮点击才投递内部事件。
- 触发后跳转或提示去运行日志看结果。
- 运行态显示下一次触发时间、最后触发时间、最后错误。
- 不要把 heartbeat 伪装成外部平台连接。

## 验证清单

完成后至少执行：

```text
npm run build
npm run check:config
```

如果改了 WebGUI，启动打包版 Manager 并检查：

- 只跑 `dist/manager.js`，不要额外占用 Vite 端口，除非明确在开发调试。
- 消息端面板可以渲染，无前端运行时错误。
- 添加实例、删除实例、启用/禁用、保存后配置仍合法。
- 检查/打开/复制/启动按钮有反馈。
- 缺启动命令时显示明确错误。
- 多实例状态按实例显示。
- 端口和 URL 改动后保存并重启生效。

如果改了接收或外发逻辑：

- 用 mock 或真实但无害事件验证 raw payload 落盘。
- 验证 route kind 正确。
- 验证重复 event 不重复投递。
- 验证多实例不会串号：A 实例入站只能用 A 的 HTTP endpoint。
- 真实外发测试必须有用户明确授权，并记录测试目标和结果。

验证结果要回写能力等级：

- 只验证 UI 构建，不算 `verified`。
- 只验证健康检查，不算 `verified`。
- 没有真实入站事件时，保留 `experimental`。
- 没有验证外发安全边界时，不能宣称完整可用。
- 真实跑通过安装/启动、接收、路由、诊断、多实例隔离后，才升为 `verified`。
