# AIUI 与手机的通用接口传输

[English](generic-api-transport_en.md) | 简体中文

状态：客户端源码与回归验证。当前重构尚未作为真机运行版本验收；构建、部署、模型调用和实际连接路径分别核对。

## 职责

服务器维护连接目录、鉴权、目标 PC 选择和中转。角色、Skill、配置事务、聊天记录及业务接口由 PC 提供。新增公共 Manager HTTP 接口复用通用传输，不新增服务器业务分发器。

| 调用 | 数据与执行归属 |
| --- | --- |
| `/api/rabilink/mobile/state`、`/mobile/target`、`/devices/connections` | 服务器连接目录与目标元数据；没有角色配置真源 |
| `/api/rabilink/device/api` | AIUI 有限 HTTP 传输，携带 `{targetDeviceId, request}`；不解释角色或 `profileRevision` |
| PC `/api/rabilink/agent-devices/{id|self}/profile`、`/profile/receipt` | 固定设备连接 owner PC 的配置事务与应用回执 |
| PC `/api/rabilink/persona-template` | 所选来源 PC 的角色与 Skill 指引 |
| PC `/api/roles/{roleId}/chat-history/aiui` | 本轮固定角色所在 PC 的实际用户文字和回复 |
| PC `/api/rabilink/mobile/device-status`、`/asr-settings` | 应用连接目录的 `connectionOwnerDeviceId` 保存电量与 ASR 优先级；不跟随聊天或角色目标切换 |
| PC 其他公共路径 | 同一个方法、路径、必要请求头和正文传输；目标接口处理其自身合同 |

`self` 由已鉴权连接身份解析，不能用 SN、自报 `appId` 或请求头冒充。配置只有一个可写 owner PC。选择其他 PC 的角色仅修改 owner 的一份配置，工具和记录使用该角色来源 PC。

## 实际连接能力

Android 通过 `RabiLinkManagerHttpTransport` 注入应用持有的连接。`RabiManagerHttpTransport` 复用既有 `RabiSpeechTunnel` 的 manager 服务：已鉴权局域网连接优先，失败后尝试 P2P，最后中转。响应报告实际 `lan`、`p2p` 或 `relay`；不能用接口名称代替实际连接证据。连接失败可选择下一条线路，业务请求派发后不会换线路重放。

SDK 没有 socket 或业务状态所有权。未配对手机桥时，AIUI 使用有限 HTTP 中转，明确报告 `lan=false`、`p2p=false`、`streaming=false`、`websocket=false`。配对手机后，通用请求使用眼镜独立身份的加密 Manager 连接；手机应用身份仅负责连接目录与信令，不能冒充眼镜领取消息。

手机眼镜设置中的“手机直连 / 眼镜配对”显示当前连接地址和五分钟配对码。AIUI 顶栏“手机直连”打开独立连接表单，输入地址和配对码后取得十五分钟本机凭据。眼镜设备凭据、独立密钥和本机凭据只存在私有连接配置，不进入角色、Skill、模型上下文或聊天记录。重新配对或连接切换使原连接失效，已派发请求不改用中转重试。

眼镜凭据经已有 `/device/api` 向目标 PC 的 `/api/rabilink/peer/device-bootstrap` 登记公钥。签名包含原绝对期限；授权最多 45 秒，续租必须再次经过真实设备鉴权。同一有效公钥续租保留 epoch；过期、换钥、重启或连接撤销关闭原通道，不能退回手机身份。普通应用握手拒绝 `glasses-*` 身份。

手机桥协议提供 `/manager-http` 的状态、请求头、正文与 `bodyBase64`，`/manager-stream` 保留流式 HTTP/SSE 与二进制块，`/manager-ws` 透传目标 PC 的原 `101` 升级及双向帧。目标和原路径放在请求头，本机凭据只放授权头。AIUI 通过标准 `fetch` 流与 `wx.connectSocket` 接入；运行时缺少对应 API 时明确失败。

模型实际使用同一 `rabi_api_call`：`mode=http|stream|websocket`，流式结果返回 `chunksBase64`，WebSocket 的 `messages` 可发送文字或 `{bodyBase64}`，观察返回文字/二进制消息。每次观察由 `maxBytes`、`maxMessages`、`maxMs` 有界结束，不按业务路径增加工具。WebSocket 发送有写副作用，保留原操作编号和指纹；收到帧不代表业务写入已确认，断连或有限观察后的原写入只能回读，不能自动重连重发。无发送消息的连接按只读观察处理。官方 `SocketTask` 使用 `send(data)` 和 `close()`，不使用小程序对象式发送参数。

本机协议测试不证明真实 AIUI 已能访问手机私网地址。官方生产网络要求 HTTPS 与域名白名单；当前手机 HTTP 地址用于开发验证，可信 HTTPS 地址、设备网络可达性、固件 API 和实际 LAN/P2P 路径仍需真机验收。官方依据：[网络规则](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/0-guide/basic/network/usage.md)、[WebSocket API](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/3-api/network/websocket.md)。

## 目标、幂等与结果

`rabi_api_help` 和 `rabi_api_call` 可传 `targetDeviceId`。省略时使用创建本轮模型时固定的角色来源 PC；未绑定角色时固定当前连接选择。其他 PC 必须属于该应用的已鉴权连接范围。角色不会增加或缩减权限。

`rabi_api_help` 复用 Manager 的 `cursor` / `limit` 分页，`limit` 为 1–200 的整数。不指定接口时默认每页 32 条，模型只收到接口编号、方法、路径、描述及合同摘要标识；`apiHelpView=index`、`completeContracts=false` 明确这不是参数合同。按 `nextCursor` 原样翻页，保持目标及原筛选；指定 `operationId` 或精确 `path` 时默认每页 1 条，保留完整原合同。目录快照变化的 409 和无效游标的 400 原样返回，不自动重试，不拼接不同快照。索引仅缩减模型观察，服务端仍传输所选页的完整合同；超大单接口及传输大小限制仍需按实际错误处理，不能称为任意规模目录验收。

恢复编号以目标合同为准：工具 `operationId`、业务 `deliveryId`、服务端 `requestId` 不能互换。例如 `/api/agent/send` 的回执按原 `deliveryId` 查询；本地 `requestIdentity` 不保证拥有全部业务编号，也不凭空提供后端查询能力。

写入带原 `operationId`、`Idempotency-Key` 和接口要求的版本条件。操作指纹包含实际目标 PC、方法、路径、请求头与正文摘要。同一编号不同目标或内容被拒绝；超时、断连和身份复核失败保留未确认状态，只查询原回执或资源，不自动重放。客户端记录摘要，不额外复制敏感正文。

AIUI 页面的工具账本由 `api-tool-ledger.js` 拥有，以现有连接范围的摘要分区保存。旧单范围账本在首次打开任意连接时先迁移其原范围，再分配新会话；失败不把旧账本当空记录。会话编号隔离本地 `callId`，操作编号跨模型重建和页面重开继续生效。写前保存后读回，存储失败、owner 被替换或在身份查询期间释放时不得派发。页面重开保留写入摘要并清理旧会话读取记录，不自动重跑未知操作。

工具观察的 `requestIdentity` 保留原 `callId`、会话、自动生成或显式传入的 `operationId` 及已核对的目标电脑。它只用于关联原请求，不是业务回执。传输抛错时返回 `TOOL_OUTCOME_UNCONFIRMED`，不把任意异常文本交给模型；结算保存失败返回 `TOOL_RECEIPT_SAVE_UNCONFIRMED`，同时保留已经收到的原结果与身份，旧 pending 记录仍阻止重放。重复调用返回 `resultAvailable=false`，本地 completed 摘要不能恢复原结果或证明业务完成；模型须按已查接口合同读取原回执/资源。身份预检已证实尚未派发的错误继续明确拒绝，不混同为已经发出的请求。

眼镜候选当前每连接范围最多保留 128 个操作摘要（包含已确认与未确认），另有每会话 128 个读取记录；写入满额只阻止新写入，不挤占查询回执的读取容量。尚无用户侧归档/清理流程，不按年龄自动遗忘操作编号。它与下文手机账本的 128 个未确认意图限额不同，不能混为同一实现。

`/meta` 校验非空 application generation 和 Manager instance；普通业务同时校验对应就绪状态。写后只复核身份，健康波动不自动等同切代。HTTP 返回、业务受理、业务完成及手机/眼镜实际应用分别报告；`202` 不代表业务完成。

有限 HTTP 中转仍有正文、结果体积及时间边界。手机桥的流和升级使用同一加密帧协议，逐次检查眼镜授权；持续事件流、WebSocket 和大文件使用流入口，不经缓冲接口压缩为一次 JSON 结果。

## 普通异步任务跟进

`rabi_task_follow` 是页面本地工具，不新增服务端派发器。模型先从真实接口合同和受理回执取得原 `taskId`、`targetDeviceId`、只读 GET `path`、JSON Pointer `statusPointer` 与 `terminalValues`，再用 `watch` 登记。Pointer 从 HTTP JSON 正文根开始；可用 `resultPointer` 选择需要保留的结果。不得猜测编号、状态字段或终态，不能用它重复派发原业务。正式设备 mailbox 投递仍由原消费者处理。

| action | 行为 |
| --- | --- |
| `watch` | 保存查询合同；同一目标/任务/路径重复登记返回原记录，合同冲突拒绝，不复活已停止或已通知的记录 |
| `list` | 读取本地记录摘要及查询错误码 |
| `read` | 按返回的记录 `id` 读取原合同、已保存结果与摘要 |
| `stop` | 停止此记录的查询和通知；不取消后端任务 |

页面每次查询复用现有鉴权传输和 `/meta` 身份检查，查询间隔默认 10 秒，可设 1–60 秒。仅前台运行，隐藏时释放，重开同一连接、目标及角色提示绑定后恢复。结果未知、缺字段、存储失败、旧 owner 晚回都不确认完成；只接受合同中声明的终态。终态结果上限 60000 字符、摘要上限 16000 字符；超限保留原订阅并显示错误码。最多 16 个待查询/待通知记录，另保留最近 32 个已通知/已停止记录。整理这些只读订阅不清除 API 写入身份；轮询也不占每会话 128 个工具读取记录。

任务结果与摘要在设备私有存储中保存，不存额外请求头或凭据。摘要由同一助手、同一全局提示生成，通知时禁用工具并让前台语音和播放优先；不伪造用户消息或写入普通聊天历史。先保存摘要，再等待当前页面 `setData` 回调确认更新，之后才允许入播报队列。确认表示本地页面更新，不能证明用户看见、听见或音频已播放。若确认后进程退出，恢复不会重新播报，但仍能用 `read` 查询结果。尚未实现事件推送或隐藏应用后台运行。

13 项 `Smoke-TaskFollow.mjs` 回归及编译/指定 AIX 页面集成覆盖保存恢复、参数快照、存储失败、停止竞争、旧 owner、前台优先与同一模型串行通知。它们使用夹具，不证明真实 PC 任务或设备声音。

## 验证入口

`Smoke-AiuiApiDiscoveryHttp.mjs` 使用真实 Manager 注册表和隔离 HTTP 服务、夹具模型/业务数据：43 个接口的完整目录为 1,254,942 字符；两页模型索引观察为 10,021 / 4,262 字符，选中合同观察为 64,859 字符，目标接口调用一次。3 项测试覆盖跨页无重漏、完整合同、目录变更、无效游标及参数校验；编译页面与指定 AIX 另验证实际页面适配器的索引和详情。它不证明正式 PC、Relay 或真机已经连接。

手机写入记录以 Relay 地址和稳定眼镜 ID 为范围，重置设备凭据不清除原编号。已确认结果缓存保留七天且最多 128 份；整理后仍保留原编号、指纹和终态摘要，旧请求只能核对原资源，不能再次派发。未知结果不按年龄清理；最多允许 128 个未确认意图，达到后新写入在网络发送前明确失败，读取与原请求核对仍可使用。流式写入仅在原响应正常结束、状态非 5xx 且身份复核通过后保存确认终态；断连和 5xx 保留未知。

`Smoke-GenericManagerTransport.mjs` 验证未知新增 API、通用配置、原目标历史回执、原写入保留、跨目标重复拒绝及无敏感正文记录。`Smoke-AiuiPersonaIntegration.mjs` 验证本轮默认 PC 固定与记录结算。Android `ManagerHttpTransportTest` 验证 SDK 注入、未知 API、目标连接范围和派发失败不重试。真实 LAN/P2P/中转、宿主模型与 ASR/TTS 并行仍需实际运行证据。

`Smoke-PhoneEyeTransport.mjs` 通过实际 HTTP、SSE 和 WebSocket 验证 AIUI 配对协议及字节回读。Android `TunnelCryptoTest` 校验实际 PC 委托签名；`TunnelHttpExchangeTest` 通过真实 PC Runtime 和独立眼镜加密握手验证未来路径、二进制、SSE 与升级；`PhoneEyeHttpServerTest` 验证真实手机桥 socket 协议。这些分别验证协议层，不等同眼镜固件或完整手机真机执行。

打开手机眼镜设置时会刷新有效期5分钟的配对码，并复用同一连接服务，不撤销已配对眼镜。眼镜本地连接凭据有效期15分钟；活动连接每分钟检查一次，在剩余5分钟时调用本地 `/session/renew`。手机使用配对时保存的原设备凭据重新向Relay核验实际设备ID，在请求前后复核原连接范围和session，成功后只延长同一私有access的期限。PC45秒委托授权仍按原设备token链独立续租。鉴权失败、撤销、范围变化或凭据已过期时停止连接，不复活旧session、不重派业务写入；长连接也会在续期失败时断开。

续租失败会保留已失效的配对配置，后续请求继续拒绝；只有用户明确重新配对或清除连接后才改变传输选择，不自动退回有限Relay HTTP重派写入。

眼镜从已鉴权的设备 profile 响应获取 `timeoutOverrides`，按 Relay、账号摘要与目标电脑缓存。`aiui.http.request` 覆盖通用 HTTP 的旧 8/12/30/45 秒默认值，`aiui.phone.request` 覆盖手机桥的 60 秒默认值；刷新设备 profile 后用于后续请求，清空覆盖恢复各调用默认值。缓存不存凭据，不跨目标电脑复用。源码烟测通过，真机安装与运行验收待完成。

`aiui.model.*` 配置模型单次响应、整轮处理、会话创建、可用性和配置理解；`aiui.playback` 配置播放结束等待。HTTP 预算通过 `X-Rabi-Timeout-Ms` 传给已鉴权的 Relay 请求，不改变其他客户端或 Relay 全局参数。
