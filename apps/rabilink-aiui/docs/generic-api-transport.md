# AIUI 与手机的通用接口传输

[English](generic-api-transport_en.md) | 简体中文

状态：客户端源码与回归验证。当前重构尚未作为真机运行版本验收；构建、部署、模型调用和实际连接路径分别核对。

## 职责

服务器维护连接目录、鉴权、目标 PC 选择和中转。人格、Skill、配置事务、聊天记录及业务接口由 PC 提供。新增公共 Manager HTTP 接口复用通用传输，不新增服务器业务分发器。

| 调用 | 数据与执行归属 |
| --- | --- |
| `/api/rabilink/mobile/state`、`/mobile/target`、`/devices/connections` | 服务器连接目录与目标元数据；没有人格配置真源 |
| `/api/rabilink/device/api` | AIUI 有限 HTTP 传输，携带 `{targetDeviceId, request}`；不解释人格或 `profileRevision` |
| PC `/api/rabilink/agent-devices/{id|self}/profile`、`/profile/receipt` | 固定设备连接 owner PC 的配置事务与应用回执 |
| PC `/api/rabilink/persona-template` | 所选来源 PC 的人格与 Skill 指引 |
| PC `/api/roles/{roleId}/chat-history/aiui` | 本轮固定人格所在 PC 的实际用户文字和回复 |
| PC `/api/rabilink/mobile/device-status`、`/asr-settings` | 应用连接目录的 `connectionOwnerDeviceId` 保存电量与 ASR 优先级；不跟随聊天或人格目标切换 |
| PC 其他公共路径 | 同一个方法、路径、必要请求头和正文传输；目标接口处理其自身合同 |

`self` 由已鉴权连接身份解析，不能用 SN、自报 `appId` 或请求头冒充。配置只有一个可写 owner PC。选择其他 PC 的人格仅修改 owner 的一份配置，工具和记录使用该人格来源 PC。

## 实际连接能力

Android 通过 `RabiLinkManagerHttpTransport` 注入应用持有的连接。`RabiManagerHttpTransport` 复用既有 `RabiSpeechTunnel` 的 manager 服务：已鉴权局域网连接优先，失败后尝试 P2P，最后中转。响应报告实际 `lan`、`p2p` 或 `relay`；不能用接口名称代替实际连接证据。连接失败可选择下一条线路，业务请求派发后不会换线路重放。

SDK 没有 socket 或业务状态所有权。未配对手机桥时，AIUI 使用有限 HTTP 中转，明确报告 `lan=false`、`p2p=false`、`streaming=false`、`websocket=false`。配对手机后，通用请求使用眼镜独立身份的加密 Manager 连接；手机应用身份仅负责连接目录与信令，不能冒充眼镜领取消息。

手机眼镜设置中的“手机直连 / 眼镜配对”显示当前连接地址和五分钟配对码。AIUI 顶栏“手机直连”打开独立连接表单，输入地址和配对码后取得十五分钟本机凭据。眼镜设备凭据、独立密钥和本机凭据只存在私有连接配置，不进入人格、Skill、模型上下文或聊天记录。重新配对或连接切换使原连接失效，已派发请求不改用中转重试。

眼镜凭据经已有 `/device/api` 向目标 PC 的 `/api/rabilink/peer/device-bootstrap` 登记公钥。签名包含原绝对期限；授权最多 45 秒，续租必须再次经过真实设备鉴权。同一有效公钥续租保留 epoch；过期、换钥、重启或连接撤销关闭原通道，不能退回手机身份。普通应用握手拒绝 `glasses-*` 身份。

手机桥协议提供 `/manager-http` 的状态、请求头、正文与 `bodyBase64`，`/manager-stream` 保留流式 HTTP/SSE 与二进制块，`/manager-ws` 透传目标 PC 的原 `101` 升级及双向帧。目标和原路径放在请求头，本机凭据只放授权头。AIUI 通过标准 `fetch` 流与 `wx.connectSocket` 接入；运行时缺少对应 API 时明确失败。

模型实际使用同一 `rabi_api_call`：`mode=http|stream|websocket`，流式结果返回 `chunksBase64`，WebSocket 的 `messages` 可发送文字或 `{bodyBase64}`，观察返回文字/二进制消息。每次观察由 `maxBytes`、`maxMessages`、`maxMs` 有界结束，不按业务路径增加工具。WebSocket 发送有写副作用，保留原操作编号和指纹；收到帧不代表业务写入已确认，断连或有限观察后的原写入只能回读，不能自动重连重发。无发送消息的连接按只读观察处理。官方 `SocketTask` 使用 `send(data)` 和 `close()`，不使用小程序对象式发送参数。

本机协议测试不证明真实 AIUI 已能访问手机私网地址。官方生产网络要求 HTTPS 与域名白名单；当前手机 HTTP 地址用于开发验证，可信 HTTPS 地址、设备网络可达性、固件 API 和实际 LAN/P2P 路径仍需真机验收。官方依据：[网络规则](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/0-guide/basic/network/usage.md)、[WebSocket API](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/3-api/network/websocket.md)。

## 目标、幂等与结果

`rabi_api_help` 和 `rabi_api_call` 可传 `targetDeviceId`。省略时使用创建本轮模型时固定的人格来源 PC；未绑定人格时固定当前连接选择。其他 PC 必须属于该应用的已鉴权连接范围。人格不会增加或缩减权限。

写入带原 `operationId`、`Idempotency-Key` 和接口要求的版本条件。操作指纹包含实际目标 PC、方法、路径、请求头与正文摘要。同一编号不同目标或内容被拒绝；超时、断连和身份复核失败保留未确认状态，只查询原回执或资源，不自动重放。客户端记录摘要，不额外复制敏感正文。

`/meta` 校验非空 application generation 和 Manager instance；普通业务同时校验对应就绪状态。写后只复核身份，健康波动不自动等同切代。HTTP 返回、业务受理、业务完成及手机/眼镜实际应用分别报告；`202` 不代表业务完成。

有限 HTTP 中转仍有正文、结果体积及时间边界。手机桥的流和升级使用同一加密帧协议，逐次检查眼镜授权；持续事件流、WebSocket 和大文件使用流入口，不经缓冲接口压缩为一次 JSON 结果。

## 验证入口

手机写入记录以 Relay 地址和稳定眼镜 ID 为范围，重置设备凭据不清除原编号。已确认结果缓存保留七天且最多 128 份；整理后仍保留原编号、指纹和终态摘要，旧请求只能核对原资源，不能再次派发。未知结果不按年龄清理；最多允许 128 个未确认意图，达到后新写入在网络发送前明确失败，读取与原请求核对仍可使用。流式写入仅在原响应正常结束、状态非 5xx 且身份复核通过后保存确认终态；断连和 5xx 保留未知。

`Smoke-GenericManagerTransport.mjs` 验证未知新增 API、通用配置、原目标历史回执、原写入保留、跨目标重复拒绝及无敏感正文记录。`Smoke-AiuiPersonaIntegration.mjs` 验证本轮默认 PC 固定与记录结算。Android `ManagerHttpTransportTest` 验证 SDK 注入、未知 API、目标连接范围和派发失败不重试。真实 LAN/P2P/中转、宿主模型与 ASR/TTS 并行仍需实际运行证据。

`Smoke-PhoneEyeTransport.mjs` 通过实际 HTTP、SSE 和 WebSocket 验证 AIUI 配对协议及字节回读。Android `TunnelCryptoTest` 校验实际 PC 委托签名；`TunnelHttpExchangeTest` 通过真实 PC Runtime 和独立眼镜加密握手验证未来路径、二进制、SSE 与升级；`PhoneEyeHttpServerTest` 验证真实手机桥 socket 协议。这些分别验证协议层，不等同眼镜固件或完整手机真机执行。

打开手机眼镜设置时会刷新有效期5分钟的配对码，并复用同一连接服务，不撤销已配对眼镜。眼镜本地连接凭据有效期15分钟；活动连接每分钟检查一次，在剩余5分钟时调用本地 `/session/renew`。手机使用配对时保存的原设备凭据重新向Relay核验实际设备ID，在请求前后复核原连接范围和session，成功后只延长同一私有access的期限。PC45秒委托授权仍按原设备token链独立续租。鉴权失败、撤销、范围变化或凭据已过期时停止连接，不复活旧session、不重派业务写入；长连接也会在续期失败时断开。

续租失败会保留已失效的配对配置，后续请求继续拒绝；只有用户明确重新配对或清除连接后才改变传输选择，不自动退回有限Relay HTTP重派写入。
