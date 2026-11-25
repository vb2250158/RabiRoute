# RabiLink Relay 公网中继

[English](rabilink-relay-server_en.md) | 简体中文

Relay 负责连接、鉴权和通用中转。RabiPC 负责角色、Skill、聊天记录、设备状态、ASR 设置和消息处理。启用 remoteAgent 后，已鉴权 Agent 可调用目标 PC 的全部公共 API；新增公共 API 不需要修改 Relay，也不因角色或工作区绑定缩小接口范围。

当前为实验实现。本地 fixture、构建、安装运行、生产部署和真机验收分别记录，不能相互代替。当前完整验收要求见[AIUI 验收清单](aiui-agent-acceptance.md)。

## 架构与连接顺序

Android 与 PC 的通用加密 Peer Tunnel 按 LAN → P2P → Relay 连接同一目标。Relay 提供同应用设备发现、连接信令及中继，PC 服务拥有实际接口和业务状态。角色默认来源 PC、设备配置 owner PC 与默认消息目标可以不同；调用者显式冻结本次目标。

支持账号隧道的 Rabi 主机端会在同一服务器、同一账号内自动发现彼此，按 LAN、WebRTC、Relay 的顺序建立加密会话。SSE 和 WebSocket 走同一隧道。Relay 核验两台主机各自的设备凭据，隧道再用各自的公钥确认对端。登出、重签或事件连接失效会关闭受影响的隧道。旧版主机可沿用原连接，接收新版账号端通过有限 HTTP 或语音队列发来的请求。

AIUI 宿主只提供 `wx.request` 时，使用既有 buffered HTTP Relay 通道。其实际能力是 HTTP Relay 降级，不能把 Android 的 LAN/P2P 能力当成 AIUI 已验收能力。两种通道最终调用同一公共 Manager API。

Relay 保存账号与凭据、设备连接登记、同应用目标目录、opaque 请求/响应队列、传输 lease、cursor、blob 和操作状态。server 自身诊断日志可保留。角色模板、权限业务、聊天记录拼装、ASR 排序、健康数据解释和 record-first 判断均由 PC 或客户端实现。队列中的原始业务正文不由 Relay 改写或按业务白名单分发。

通用 HTTP 传输的连接身份包含首次鉴权时间 `authenticatedAt`。原队列与同操作重试沿用该时间，不能因晚到或重新认领延长连接授权。PC 将它纳入内部签名，普通 HTTP 转发使用 PC 自己签发的短期凭据校验时效，支持不同的电脑时钟和时区。需要确认授权是否撤销或租约是否有效的接口各自校验相关时间。手机代眼镜建立独立身份的短租约由 PC 管理，见[设备连接授权](device-peer-connection.md)。Relay 不增加对应业务 API 分发表或公钥授权库。

## 启动与接入

```powershell
cd C:\Path\To\RabiRoute
$env:RABILINK_RELAY_PORT = "0"
node scripts/rabilink-relay-server.mjs
```

直接启动且未指定 `PORT` 或 `RABILINK_RELAY_PORT` 时，由系统分配可用端口；显式设为 `0` 也使用系统分配。监听成功后输出 `RABILINK_RELAY_READY` JSON（含进程 ID、主机和实际端口），调用者使用该地址。显式指定的非零端口保持不变，占用时报告启动失败。Windows 部署固定使用回环地址与端口 `0`：原 Relay 启动器发布原子进程 READY、PID、启动身份和实际端口，原 Caddy 启动器核实实际监听后生成上游。后端重启撤销旧地址，等待原 Caddy 子进程退出后更新上游。公开 `80`/`443` 和显式 `PublicHttpPort` 保持原约定。

RuntimeOnly 同时更新原有服务启动器；已有受管 Caddy 任务时，仅迁移已知 Relay 路由到 `Caddyfile.template`，保留公开地址与自定义路由；无法识别的旧上游会在代码替换前停止迁移。受管模板关闭不需要的 Caddy 管理监听。`logs/relay-endpoint.json` 是可撤销的运行发现提示，必须结合当前进程与套接字身份核实。残留旧子进程会阻止新实例启动。

先读取 `/health`，再通过 HTTPS `/manage` 注册账号、创建应用。在控制台复制电脑接入提示词，由目标 PC 的私密 Agent 使用短期一次性接入码配置连接；见[电脑接入](rabilink-pc-pairing.md)。凭据不得出现在公开日志、示例或截图中。

同应用 PC 必须各有独立 `deviceId` 和 GUID。关闭 PC“连接服务器”停止连接，不删除本机凭据或路由。能力广告可透传有界 `rabi-pc-version-<版本>`，版本用于展示，不证明完整性或授予权限。公共 API 的访问条件由实际目标 PC 的 remoteAgent 和连接鉴权合同决定。

Windows 部署使用 `scripts/deploy-rabilink-relay-windows.ps1`。`scripts/rabilink-relay-runtime-files.json` 是唯一 Relay runtime 文件清单，包含源码静态依赖及 HTTP 实际提供的配对脚本，不包含 PC 业务模块。部署前保留原应用、任务和运行状态完整私有快照；部署后检查运行版本、`/health`、连接目录与原队列 ID。真实数据文件路径由当前部署环境确定，不从示例目录猜测。

部署默认 `RuntimeOnly`，只更新 Relay runtime；`-PrepareOnly` 只在本机生成 ZIP，不连接服务器。全量 Caddy/WebGUI 更新须显式传 `-RuntimeOnly:$false`。部署停止 Relay 后，按旧/新 manifest 和固定退役清单备份代码、ws 依赖、原计划任务及完整 data，并逐文件核对 SHA-256；runtime 复制不覆盖 data/logs，不导入旧业务或推断连接 owner。备份失败时恢复原任务运行，代码替换不继续。

回滚包提供 `rollback-rabilink-relay.ps1 -Root <服务目录> -BackupRoot <该次 backups/code-...>`。该脚本先核验代码快照哈希，恢复原代码和计划任务，移除该次新增文件；保留部署后产生的实时数据。data 私有快照只供单独调查和明确授权的数据恢复，不随代码回滚覆盖。回滚后重新读取本地/公网 `/health`、原账号/任务 ID 和连接目录。

## 连接元数据

Android 消息页通过 `GET /api/rabilink/mobile/account` 读取登录账号的资料。请求使用 `X-RabiLink-Token` 中的应用凭据，Relay 根据应用所有者返回账号 ID、用户名、昵称、状态和可空的 160 × 160 PNG 头像（Base64）。`PATCH /api/rabilink/mobile/account/status` 使用相同凭据保存该账号的状态，请求体以 `status` 传入 `online`、`away`、`busy` 或 `do-not-disturb`，保存后返回账号 ID 和状态。账号尚未设置时默认在线。

| 接口 | 用途 |
| --- | --- |
| `GET /api/rabilink/mobile/state` | 连接目录、目标和服务广告；无设备电量、角色或 ASR 排序 |
| `PATCH /api/rabilink/mobile/target` | `{targetDeviceId}`，选择默认消息目标 |
| `PATCH /api/rabilink/mobile/connection` | `{connectionOwnerDeviceId}`，首次明确登记固定应用设置 owner |
| `GET /api/rabilink/devices/connections` | 固定设备连接目录，返回应用 `connectionOwnerDeviceId` 与设备 `connectionTargetDeviceId` |
| `POST /api/rabilink/devices/token` | 登记设备独立凭据；新绑定必须明确 `connectionTargetDeviceId` |
| `GET /api/rabilink/peers` | 同应用连接与能力发现 |

应用 owner 必须是同应用、具 Manager 服务广告的 PC，登记后不可通过默认目标改变。设备同一 binding 的固定 owner 在凭据重置后保留，换 owner 需新 binding。没有明确登记时失败关闭，不从旧 tasks-only 默认目标猜业务归属。目录只表示连接和数据归属，不解析角色，更不按绑定限制公共 API 权限。

## 手机文件操作

Android 使用安装时生成的稳定设备 ID。Manager 从 `GET /api/rabilink/peers?includePortable=phone` 读取已连接手机，用原设备别名入口保存名称。支持手机控制的客户端公布 `phone-file-control-v1`。文件操作默认启用，Android 的「所有文件访问权限」由手机用户在系统设置授予。可访问主共享存储里的现有文件，如 `Download`、`Documents` 和 `DCIM`。应用私有目录和受保护的 `Android/data`、`Android/obb` 由 Android 隔离。

调用 Manager 的 `POST /api/rabi/link-home/devices/{deviceId}/files`，正文传入发现结果的 `targetGuid`（可能是空字符串）以及下表参数。Manager 使用已保存的 Relay 连接。直接连接 Relay 的客户端可调用 `POST /api/rabilink/mobile/files`，另传 `targetId`，使用 `X-RabiLink-Token` 中的应用凭据或同账号 PC 凭据。手机只从当前连接领取请求。支持主共享存储下的绝对路径，也可用相对路径浏览。读取和上传动作沿用电脑端的分块与回执字段。

| `action` | 输入与结果 |
| --- | --- |
| `file.settings.read`、`file.settings.update` | 查询或更新 `enabled`，返回开关状态和 Android 的 `permissionGranted`。 |
| `file.list` | 主共享存储根目录传空字符串。每页最多 100 项，续页把返回的 `next` 和 `version` 作为 `after` 和 `version` 传回。 |
| `file.stat` | `path`，返回名称、类型、大小、修改时间和 `version`。 |
| `file.read` | `path`、`version`、`offset`。返回 Base64 数据、块 SHA-256、`nextOffset` 及 `eof`，每块最多 64 KiB。 |
| `file.mkdir` | `path`，创建一级目录。 |
| `file.rename` | `path`、`version`、`to`。在主共享存储内移动或重命名。目标路径须空闲。 |
| `file.delete` | `path`、`version`。删除指定文件或空目录。 |
| `upload.begin` | `uploadId`（客户端生成的 UUID）、`path`、`size`、`sha256`。替换已有文件时传入原 `version`。单文件上限 512 MiB。 |
| `upload.write` | `uploadId`、`offset`、`data`（Base64）、块 `sha256`。按顺序传输，每块最多 64 KiB。 |
| `upload.status`、`upload.commit`、`upload.abort` | 传 `uploadId`，查询进度、校验并提交、或取消。完整 SHA-256 校验通过后原子替换或创建目标文件。 |

结果为 `{code: 0, data: {...}}` 或 HTTP 错误和 `errorCode`。上传中断后用原 `uploadId` 回读。上传回执在手机进程内保留最多一小时。手机重启进程后，已提交文件可通过 `file.stat` 核实。移动和删除结果不确定时先回读原路径。

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

路径为安全相对公共路径，保留 query 和通用合同头；拒绝外部 URL、路径逃逸、凭据和伪造 transport 身份。`targetDeviceId` 指向同应用目标；客户端必须在原请求与回读间保持目标。Relay 不接受 profileRevision 路由字段，不读取角色来选择 PC。

省略 `targetDeviceId` 时，仅采用设备已登记的 `connectionTargetDeviceId`，或应用明确登记的 `connectionOwnerDeviceId`。缺少连接目标返回 `API_CONNECTION_TARGET_REQUIRED`；旧消息或任务的 `targetDeviceId` 不参与默认接口路由，原任务目标数据仍保留。

原始结果置于 `{code:0,data:{structuredContent:{ok,statusCode,headers,data}}}`；结果中的 PC 状态、正文和安全响应头保持原义，不能把 Relay HTTP 200 当成业务成功。具体字段以[通用 API 合同](../apps/rabilink-aiui/docs/generic-api-transport.md)为准。PC worker 只从 server 创建的连接身份建立可信来源，不接受模型正文自报 ID。

请求和响应允许新增业务头，例如 `x-token-count`、`x-secret-version`，不按名称中的敏感词拦截。仅拒绝明确的鉴权、来源身份、报文控制头及 `x-rabilink-*`、`x-forwarded-*` 内部命名空间；本机连接凭据和签名由传输层生成，调用方不能覆盖。

写请求先持久记录 `operationId`，再经同一 WebGUI HTTP queue 分发。`GET /api/rabilink/device/api/operations/{operationId}` 读取传输操作状态。相同键异意图拒绝；不确定写入不会自动重放，必须回读原 PC 资源或原业务回执。传输状态不是业务回执。当前最多 2048 个写操作记录，满后失败关闭，不淘汰原键造成重放。没有另造一套按业务 API 分发的 Relay 通道。

## 任务、下行和服务中转

Rokid/Lingzhu 外部 wire 入口仍作为传输 codec 保留：`/rokid/rabilink/input`、`/api/rabilink/devices/input` 接受原正文，创建带原 ID、lease、目标和身份的任务信封。worker 必须声明 `taskFormat=opaque-v1`，旧 decoder 请求返回 426。PC 解释文本别名、健康指标、processingPolicy、routeProfileId 和 record-first，随后调用既有消息/健康处理 owner。Relay 不补写这些业务字段。

`/worker/messages`、设备 messages/cursor/receipt 和 blob 保留通用下行传输。设备记录的“收到/播放完成/失败”是投递状态；不能当作 Agent 已正确处理。PC 决定下行内容、渠道和实际接收目标。AIUI 的完整 Agent、乐奇模型、TTS/ASR 和引导行为见[AIUI 客户端文档](../apps/rabilink-aiui/README.md)。

`/api/rabilink/speech/{path}` 中转安全相对公共 speech 路径，支持通用 HTTP 方法，不维护逐 API 白名单。选择目标、流量大小、超时和传输 fencing 属于通道；ASR/VAD、声纹、模型配置、语音库及消息处理由目标 PC 的 RabiSpeech/Manager 决定。实际官方语音链见[RabiSpeech](rabispeech-plugin.md)。`/api/rabilink/video/offer` 只中转设备与目标 PC 的连接交换。

## 新版 PC 业务与旧入口退役

角色配置和模板只使用[公共 profile API](aiui-agent-profile-http.md)。公共 PC 设置使用 `/api/rabilink/mobile/asr-settings`、`device-status`、`proof`、`proofs`；健康能力为 PC `/api/rabilink/devices/health-capabilities`。它们通过通用 Manager 传输调用，Relay 不拥有业务副本。

旧 `/manage/.../agent-profile`、`/api/rabilink/device/agent-profile*`、`/device/knowledge*`、`/mobile/aiui-*`、`/mobile/webgui`、`/mobile/routes`、`/mobile/asr-settings`、`/mobile/device-status` 和 proof 业务入口已退役，返回 404 或 410。旧配置管理页面及知识授权开关删除。更新全部客户端后按新规范明确登记并配置；不维护旧客户端代理，不迁移旧业务值，不清空原账号、任务或未知扩展字段。旧完整原数据须私有留底。

## 限额与排障

默认数据目录为 `data/rabilink-relay`，可由 `RABILINK_RELAY_DATA_DIR` 覆盖，应用文件可由 `RABILINK_RELAY_APP_STORE_FILE` 指定。常用传输参数包括 `RABILINK_RELAY_WEBGUI_REQUEST_WAIT_MS`、`RABILINK_RELAY_WEBGUI_BODY_MAX_BYTES`、`RABILINK_RELAY_SPEECH_REQUEST_WAIT_MS`、`RABILINK_RELAY_SPEECH_BODY_MAX_BYTES`、`RABILINK_RELAY_TASK_TTL_MS`、`RABILINK_RELAY_OUTBOX_TTL_MS` 和 `RABILINK_RELAY_LEASE_MS`；实际边界由源码 clamp 定义。旧 server 电量过期与 ASR 业务环境变量不再生效。

先检查 `/health` 和同应用目录，再检查目标 PC 能力与实际运行版本、PC Manager generation、原请求 ID/operationId 和回执。日志只记录必要传输诊断并过滤凭据。存储替换失败须恢复快照；损坏存储失败关闭。不能通过换目标、换键或切角色重发结果不确定的写请求。

隔离测试覆盖真实 Relay runtime staging 启动、同应用隔离、未来 API 透传、固定目标、原请求头/回执、opaque 正文保留、PC 业务 owner 重启与旧入口退役。生产部署、账号登录、硬件唤醒、双工语音和平台上传须另行验证。
