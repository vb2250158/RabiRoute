# RabiLink Relay 公网中继

[English](rabilink-relay-server_en.md) | 简体中文

Relay 负责连接、鉴权和通用中转。RabiPC 负责人格、Skill、聊天记录、设备状态、ASR 设置和消息处理。启用 remoteAgent 后，已鉴权 Agent 可调用目标 PC 的全部公共 API；新增公共 API 不需要修改 Relay，也不因人格或工作区绑定缩小接口范围。

当前为实验实现。本地 fixture、构建、安装运行、生产部署和真机验收分别记录，不能相互代替。当前完整验收要求见[AIUI 验收清单](aiui-agent-acceptance.md)。

## 架构与连接顺序

Android 与 PC 的通用加密 Peer Tunnel 按 LAN → P2P → Relay 连接同一目标。Relay 提供同应用设备发现、连接信令及中继，PC 服务拥有实际接口和业务状态。人格默认来源 PC、设备配置 owner PC 与默认消息目标可以不同；调用者显式冻结本次目标。

AIUI 宿主只提供 `wx.request` 时，使用既有 buffered HTTP Relay 通道。其实际能力是 HTTP Relay 降级，不能把 Android 的 LAN/P2P 能力当成 AIUI 已验收能力。两种通道最终调用同一公共 Manager API。

Relay 保存账号与凭据、设备连接登记、同应用目标目录、opaque 请求/响应队列、传输 lease、cursor、blob 和操作状态。server 自身诊断日志可保留。人格模板、权限业务、聊天记录拼装、ASR 排序、健康数据解释和 record-first 判断均由 PC 或客户端实现。队列中的原始业务正文不由 Relay 改写或按业务白名单分发。

通用 HTTP 传输的连接身份包含首次鉴权时间 `authenticatedAt`。原队列与同操作重试沿用该时间，不能因晚到或重新认领延长连接授权；PC 使用内部 MAC 核验它。手机代眼镜建立独立身份的短租约由 PC 管理，见[设备连接授权](device-peer-connection.md)。Relay 不增加对应业务 API 分发表或公钥授权库。

## 启动与接入

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_PORT = "8788"
node scripts/rabilink-relay-server.mjs
```

先读取 `/health`，再通过 HTTPS `/manage` 注册账号、创建应用。在控制台复制电脑接入提示词，由目标 PC 的私密 Agent 使用短期一次性接入码配置连接；见[电脑接入](rabilink-pc-pairing.md)。凭据不得出现在公开日志、示例或截图中。

同应用 PC 必须各有独立 `deviceId` 和 GUID。关闭 PC“连接服务器”停止连接，不删除本机凭据或路由。能力广告可透传有界 `rabi-pc-version-<版本>`，版本用于展示，不证明完整性或授予权限。公共 API 的访问条件由实际目标 PC 的 remoteAgent 和连接鉴权合同决定。

Windows 部署使用 `scripts/deploy-rabilink-relay-windows.ps1`。`scripts/rabilink-relay-runtime-files.json` 是唯一 Relay runtime 文件清单，包含源码静态依赖及 HTTP 实际提供的配对脚本，不包含 PC 业务模块。部署前保留原应用、任务和运行状态完整私有快照；部署后检查运行版本、`/health`、连接目录与原队列 ID。真实数据文件路径由当前部署环境确定，不从示例目录猜测。

部署默认 `RuntimeOnly`，只更新 Relay runtime；`-PrepareOnly` 只在本机生成 ZIP，不连接服务器。全量 Caddy/WebGUI 更新须显式传 `-RuntimeOnly:$false`。部署停止 Relay 后，按旧/新 manifest 和固定退役清单备份代码、ws 依赖、原计划任务及完整 data，并逐文件核对 SHA-256；runtime 复制不覆盖 data/logs，不导入旧业务或推断连接 owner。备份失败时恢复原任务运行，代码替换不继续。

回滚包提供 `rollback-rabilink-relay.ps1 -Root <服务目录> -BackupRoot <该次 backups/code-...>`。该脚本先核验代码快照哈希，恢复原代码和计划任务，移除该次新增文件；保留部署后产生的实时数据。data 私有快照只供单独调查和明确授权的数据恢复，不随代码回滚覆盖。回滚后重新读取本地/公网 `/health`、原账号/任务 ID 和连接目录。

## 连接元数据

| 接口 | 用途 |
| --- | --- |
| `GET /api/rabilink/mobile/state` | 连接目录、目标和服务广告；无设备电量、人格或 ASR 排序 |
| `PATCH /api/rabilink/mobile/target` | `{targetDeviceId}`，选择默认消息目标 |
| `PATCH /api/rabilink/mobile/connection` | `{connectionOwnerDeviceId}`，首次明确登记固定应用设置 owner |
| `GET /api/rabilink/devices/connections` | 固定设备连接目录，返回应用 `connectionOwnerDeviceId` 与设备 `connectionTargetDeviceId` |
| `POST /api/rabilink/devices/token` | 登记设备独立凭据；新绑定必须明确 `connectionTargetDeviceId` |
| `GET /api/rabilink/peers` | 同应用连接与能力发现 |

应用 owner 必须是同应用、具 Manager 服务广告的 PC，登记后不可通过默认目标改变。设备同一 binding 的固定 owner 在凭据重置后保留，换 owner 需新 binding。没有明确登记时失败关闭，不从旧 tasks-only 默认目标猜业务归属。目录只表示连接和数据归属，不解析人格，更不按绑定限制公共 API 权限。

## 通用 HTTP 合同

`POST /api/rabilink/device/api` 使用已鉴权应用或设备凭据，正文为：

```json
{
  "targetDeviceId": "pc-example",
  "request": {
    "method": "PATCH",
    "path": "/api/example/future-capability",
    "headers": {"if-match": "\"revision-example\""},
    "operationId": "operation-example",
    "body": {"value": "example"}
  }
}
```

路径为安全相对公共路径，保留 query 和通用合同头；拒绝外部 URL、路径逃逸、凭据和伪造 transport 身份。`targetDeviceId` 指向同应用目标；客户端必须在原请求与回读间保持目标。Relay 不接受 profileRevision 路由字段，不读取人格来选择 PC。

省略 `targetDeviceId` 时，仅采用设备已登记的 `connectionTargetDeviceId`，或应用明确登记的 `connectionOwnerDeviceId`。缺少连接目标返回 `API_CONNECTION_TARGET_REQUIRED`；旧消息或任务的 `targetDeviceId` 不参与默认接口路由，原任务目标数据仍保留。

原始结果置于 `{code:0,data:{structuredContent:{ok,statusCode,headers,data}}}`；结果中的 PC 状态、正文和安全响应头保持原义，不能把 Relay HTTP 200 当成业务成功。具体字段以[通用 API 合同](../apps/rabilink-aiui/docs/generic-api-transport.md)为准。PC worker 只从 server 创建的连接身份建立可信来源，不接受模型正文自报 ID。

请求和响应允许新增业务头，例如 `x-token-count`、`x-secret-version`，不按名称中的敏感词拦截。仅拒绝明确的鉴权、来源身份、报文控制头及 `x-rabilink-*`、`x-forwarded-*` 内部命名空间；本机连接凭据和签名由传输层生成，调用方不能覆盖。

写请求先持久记录 `operationId`，再经同一 WebGUI HTTP queue 分发。`GET /api/rabilink/device/api/operations/{operationId}` 读取传输操作状态。相同键异意图拒绝；不确定写入不会自动重放，必须回读原 PC 资源或原业务回执。传输状态不是业务回执。当前最多 2048 个写操作记录，满后失败关闭，不淘汰原键造成重放。没有另造一套按业务 API 分发的 Relay 通道。

## 任务、下行和服务中转

Rokid/Lingzhu 外部 wire 入口仍作为传输 codec 保留：`/rokid/rabilink/input`、`/api/rabilink/devices/input` 接受原正文，创建带原 ID、lease、目标和身份的任务信封。worker 必须声明 `taskFormat=opaque-v1`，旧 decoder 请求返回 426。PC 解释文本别名、健康指标、processingPolicy、routeProfileId 和 record-first，随后调用既有消息/健康处理 owner。Relay 不补写这些业务字段。

`/worker/messages`、设备 messages/cursor/receipt 和 blob 保留通用下行传输。设备记录的“收到/播放完成/失败”是投递状态；不能当作 Agent 已正确处理。PC 决定下行内容、渠道和实际接收目标。AIUI 的完整 Agent、乐奇模型、TTS/ASR 和引导行为见[AIUI 客户端文档](../apps/rabilink-aiui/README.md)。

`/api/rabilink/speech/{path}` 中转安全相对公共 speech 路径，支持通用 HTTP 方法，不维护逐 API 白名单。选择目标、流量大小、超时和传输 fencing 属于通道；ASR/VAD、声纹、模型配置、语音库及消息处理由目标 PC 的 RabiSpeech/Manager 决定。实际官方语音链见[RabiSpeech](rabispeech-plugin.md)。`/api/rabilink/video/offer` 只中转设备与目标 PC 的连接交换。

## 新版 PC 业务与旧入口退役

人格配置和模板只使用[公共 profile API](aiui-agent-profile-http.md)。公共 PC 设置使用 `/api/rabilink/mobile/asr-settings`、`device-status`、`proof`、`proofs`；健康能力为 PC `/api/rabilink/devices/health-capabilities`。它们通过通用 Manager 传输调用，Relay 不拥有业务副本。

旧 `/manage/.../agent-profile`、`/api/rabilink/device/agent-profile*`、`/device/knowledge*`、`/mobile/aiui-*`、`/mobile/webgui`、`/mobile/routes`、`/mobile/asr-settings`、`/mobile/device-status` 和 proof 业务入口已退役，返回 404 或 410。旧配置管理页面及知识授权开关删除。更新全部客户端后按新规范明确登记并配置；不维护旧客户端代理，不迁移旧业务值，不清空原账号、任务或未知扩展字段。旧完整原数据须私有留底。

## 限额与排障

默认数据目录为 `data/rabilink-relay`，可由 `RABILINK_RELAY_DATA_DIR` 覆盖，应用文件可由 `RABILINK_RELAY_APP_STORE_FILE` 指定。常用传输参数包括 `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS`、`RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES`、`RABILINK_RELAY_SPEECH_REQUEST_WAIT_MS`、`RABILINK_RELAY_SPEECH_BODY_MAX_BYTES`、`RABILINK_RELAY_TASK_TTL_MS`、`RABILINK_RELAY_OUTBOX_TTL_MS` 和 `RABILINK_RELAY_LEASE_MS`；实际边界由源码 clamp 定义。旧 server 电量过期与 ASR 业务环境变量不再生效。

先检查 `/health` 和同应用目录，再检查目标 PC 能力与实际运行版本、PC Manager generation、原请求 ID/operationId 和回执。日志只记录必要传输诊断并过滤凭据。存储替换失败须恢复快照；损坏存储失败关闭。不能通过换目标、换键或切人格重发结果不确定的写请求。

隔离测试覆盖真实 Relay runtime staging 启动、同应用隔离、未来 API 透传、固定目标、原请求头/回执、opaque 正文保留、PC 业务 owner 重启与旧入口退役。生产部署、账号登录、硬件唤醒、双工语音和平台上传须另行验证。
