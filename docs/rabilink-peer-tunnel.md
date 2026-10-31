# 跨电脑通用连接与语音服务器

[English](rabilink-peer-tunnel_en.md) | 简体中文

状态：实验实现。自动化覆盖本机双端局域网、真实 WebRTC、隔离中转、HTTP 流、WebSocket、取消及 RTT；真实双 PC、公网跨运营商和目标语音模型仍需验收。源码与测试通过不等于远端设备已经升级。

## 使用方式

RabiLink 主页和角色来源选择显示设备自身上报的 RabiPC 版本；未上报时显示“版本未知”。主页用设备 ID 和 GUID 核对本机标记，来源选择的本机项显示实际名称和当前运行版本；本机不会作为另一台远端 PC 列出。版本只帮助核对运行版，不参与鉴权、服务权限或功能能力判断。

WebGUI 的“语音服务”顶部提供“语音服务器”。每项展示设备名称、在线状态、实际线路和实测往返延迟，例如“工作站 · 在线 · P2P直连 · 42 ms”。本机显示“本机调用”，不伪造 0 ms。

打开下拉框会检测最多十个可用目标，最多同时建立两条连接；选中目标优先。未升级的设备显示“需要升级”，尚未握手的同应用设备显示“将自动连接”。离线项不能新选择；已选设备离线后保留选择，不偷偷切回本机。

设备在线、通道连通、语音服务可用是不同状态。没有健康连接时不显示历史线路；RTT 超过三十秒没有刷新时显示“延迟待检测”。RTT 是同一加密通道的 ping/pong 往返，不包含模型加载、TTS 合成或 ASR 识别。页面通过事件更新，打开菜单时维护可见目标的连接心跳，关闭后只保留所选目标；未使用的连接六十秒后释放。

选择 B 后，模型、音色、TTS 和手动 ASR 请求交给 B；麦克风设备与播放 FIFO 留在 A。远端 TTS 禁止在 B 播放，完成的 PCM WAV 进入 A 的原播放队列。常驻麦克风在有 Manager 地址时读取当前选择：选中远端才经 Manager 转写；没有远端选择时保留原本地识别。远端失败不转为本机识别。模型管理与服务启停作用于 B，通过同一应用连接使用 B 的 manager 服务。

## 自动选路

1. 局域网候选地址并行验证，总预算两秒。
2. 失败后尝试 WebRTC P2P，预算十秒。仅 STUN，无 TURN。
3. 失败后建立服务器中转，预算五秒。

健康连接复用，不按每个接口重新打洞。局域网通过 DNS-SD 的 rabitunnel 服务发现已信任设备，地址和身份仍在加密握手中核对；服务器不可用时已发现的 LAN 目标仍能使用。局域网发现新地址时可升级线路，新请求使用新连接，旧连接上的流正常结束后释放。

连接预算与业务超时分开。请求交给目标后不自动重放；中断可能意味着结果未知。HTTP 取消传给目标，已开始的音频不自动重新播放。没有端点幂等合同就不承诺写请求恰好执行一次。

## RabiLink 统一设备连接

0.3.22 起，两端启用同一 RabiLink 应用并通过已有应用鉴权后，自动交换并固定 Ed25519 公钥。新 PC 声明 `rabilink-application-access-v1`，信令为 `bootstrap-application`，签名域为 `rabi-application-bootstrap-v1`。服务选择、探测和首次请求使用同一连接流程；无需分别授权语音、角色、资源或完整 `manager` 管理服务。来源 PC 必须更新到支持该能力的版本。

鉴权设备默认可以调用本机实际提供的全部服务，包括 Manager 管理与知识读写。应用隔离、设备凭据、固定公钥、加密和当前连接作用域仍有效；匿名 LAN 广告不能建立信任。默认允许不代表服务已经启动、设备在线或接口存在。Host 生命周期、实例重置等本机 owner 操作仍只能由本机 Host 入口完成。

`tunnel.json` 保存选定设备、固定公钥和应用作用域，不再以每项 `services` 列表管理设备权限。已有公钥保留，成功的当前应用握手将旧条目迁移到统一连接记录；旧文件本身不能证明当前应用已鉴权。每个新请求复核当前启用状态、token 作用域和固定公钥；HTTP 上传、下载、SSE 和 WebSocket 在发送正文与结束流前继续复核。停用、换应用凭据或删除连接记录后停止后续字节；旧作用域的复用连接关闭，公钥变化不自动覆盖。

`persona` 是保留给角色引用的 Manager 兼容别名，与 `manager` 共享全部实际提供的公开接口和连接鉴权，不另设业务路径白名单。服务地址与身份头仍由目标 PC 的运行实例提供。

PC 和手机统一使用 `bootstrap-application`；旧 `bootstrap-speech`、`bootstrap-resources`、`bootstrap-persona` wire kind 已删除并拒绝。角色页面当前仍调用 `POST /api/rabilink/peer/persona/bootstrap`，该 HTTP 入口仅调用统一应用握手，不恢复旧 wire kind。

### 手机代理眼镜的独立身份

手机显式配对后，可代持眼镜凭据与独立 Ed25519 密钥。眼镜凭据通过既有 `/device/api` 通用转发调用目标 PC 的 `POST /api/rabilink/peer/device-bootstrap`；PC 只接受当前 Relay owner 签名证明中的真实 `glasses-<16位十六进制>` 来源，不接受普通应用、另一个 peer 或正文自称的设备身份。应用握手永久拒绝 `glasses-*` 来源，过期设备身份也不能退回应用握手。

登记正文为 `{source,publicKey,target,expiresAt,nonce,signature}`。Ed25519 签名原文为 `rabi-device-delegation-v1` 拼接按 `source,publicKey,target,expiresAt,nonce` 顺序生成的 JSON；nonce 为 32–128 位 URL-safe 字符，signature 为 64 字节签名的标准 Base64。`source` 必须匹配真实鉴权来源，`target` 必须匹配目标 PC。返回 `sourceDeviceId,deviceId,publicKey,generation,managerGeneration,expiresAt,epoch`；两项 generation 都对应 Host 的 `applicationGenerationId`。

租约仅保存在 PC 内存，绝对截止不得晚于服务器接纳原设备鉴权的 `authenticatedAt + 45秒`。排队和重试不刷新该时戳；手机须用真实眼镜凭据独立续租。活跃同公钥续租保持 epoch，换公钥或到期后重新登记更换 epoch 并关闭旧会话。PC 重启使租约失效；没有可用续租路径时到期失败关闭，凭据撤销的离线窗口最多为原租约剩余时间，不能宣称立即跨端撤销。

手机可沿用应用凭据运行现有 P2P/中转信令，但内层隧道必须使用眼镜独立 source/key，不能用手机身份或透传私有头冒充眼镜。HTTP 正文、SSE 与 WebSocket 每次收发继续验证当前 key、epoch、租约、scope 和 generation；Manager 已接纳的请求在异步等待后复验同一内存 guard。租约只证明消息 owner，不按角色、工作区或 Route 限制公共 API。服务端仍只有连接、鉴权和通用中转职责。

实际 HTTP 注册与 LAN 握手、首条即时请求、同 key 续租、换 key、过期、作用域变化、SSE/升级流停止字节的回归见 `src/peerTunnel/deviceDelegation.test.ts`；真实手机、眼镜和公网线路验收另行记录。

只读验收模式仍禁止修改选择和建立隧道。

## 通用接口

控制入口使用 Manager 主监听端口与已建立的连接身份。已鉴权 Agent 无需再提供 WebGUI 密钥或绑定角色、工作区、Route，即可使用设备目录、选择和通用 HTTP 接口；浏览器继续使用现有 WebGUI 鉴权。WebSocket Upgrade 在进入同一通用接口前完成相同来源接纳，并在异步连接及数据收发时复核原连接；撤销后不回退为本机身份。独立的对端发现端口不提供 WebGUI 控制访问。

调用方的 Manager 入口：

~~~text
GET  /api/rabilink/peer/servers
POST /api/rabilink/peer/probe           { "deviceIds": ["peer-b"] }
GET  /api/rabilink/peer/selection
PUT  /api/rabilink/peer/selection       { "deviceId": "peer-b" }
GET  /api/rabilink/peer/events?ids=[...]  SSE；ids 需 URL 编码
任意受支持方法 /api/rabilink/peer/http/<设备>/<服务>/<原路径>
~~~

同一 http 入口对允许升级的服务支持 WebSocket Upgrade，包括 `persona` 别名。服务登记 baseUrl 和可选 pathPrefix；不为角色别名设置隐藏请求白名单。通用接口不注册逐项远程业务操作。Manager 地址每代重新提供，speech 地址来自现有语音配置。额外服务只可由本机管理员在 services 中登记，不接受远端任意 URL。内置 `manager` 的地址和身份请求头始终由应用提供，`tunnel.json` 不能改写。公开 peer 目录、选择及第三台 PC 转发接口可通过 `manager` 访问；仅拒绝将私有握手入口 `receive`、`tunnel/socket` 当作业务接口。

第三台 PC 使用现有公开接口。例如 A 已连接 B，可请求 B 的 `/api/rabilink/peer/http/pc-c/manager/api/example`，由 B 经同一连接拥有者访问 C。显式嵌套最多四跳，拒绝返回当前目标、重复目标及超限路径；不按整个 `/api/rabilink/peer/` 前缀禁用业务。没有健康目标连接时返回失败，不偷偷改为本机执行。

公开请求头使用共享 `packages/rabi-api-contract` 合同透传，包括 `If-Match`、`Idempotency-Key`、预期 generation/instance 和日后新增的业务字段。仅剥离凭据、代理身份、HTTP framing、Connection 指定的逐跳字段及非法换行；新增业务头不需要修改 Relay 或隧道枚举。目标端每次转发到 Manager 或其资源下载接口时，使用进程内存密钥签发绑定真实来源、方法、原始路径、应用作用域、generation 和唯一 nonce 的 MAC；公开 generation、loopback 地址与裸身份头不能替代该证明。相同请求可以重复复验，不同请求重放 nonce 会被拒绝；作用域和 generation 失效后也会拒绝。调用方私有头先被剥离，证明不返回外部；独立语音服务保留自身鉴权。

HTTP、二进制、上传下载、SSE 和 WebSocket 共用分帧、多路复用和每流窗口控制。每连接最多十六个流，单帧约三十二 KiB，发送数据块十二 KiB。隧道不把整个文件装进 JSON。普通语音控制 API 保留现有有界缓冲合同，流式使用通用接口。

允许重定向的服务在同源重定向时保留设备与服务前缀，跨源重定向拒绝；`persona` 使用同一规则。正文中的 URL 是业务数据，不做猜测改写；扩展接口应返回服务相对路径。浏览器凭据不自动复制到对端。需要服务凭据的独立服务，由管理员在目标服务配置中提供 headers。

### 连接控制入口的自动发现

设备目录、选择读取/保存、公开身份、探测和事件流六个操作已注册为 `manager.rabilink.peer.*`，原控制 HTTP 包装器已删除。JSON 正文与 SSE 事件仍归原连接拥有者；选择保存前复验原连接，事件流在取消后解除监听并等待 RTT 回调结束。方法、字段和恢复方式见 [Peer 连接控制合同](rabi-agent-interfaces.md#peer-连接控制合同源码已接入安装版待验收)。

### HTTP 入口的自动发现

七种 HTTP 方法通过 `manager.rabilink.peer.http.<method>` 注册，路径、代理合同与实际分发来自同一活动快照，旧 HTTP 正则分发已删除。正文、二进制与 SSE 由原生隧道逐块处理，保留目标版本条件、重复公共响应头和原回执；目标端重建 framing，包含 DELETE 正文。取消和卸载等待已接受写入及流清理。方法、字段与示例见 [Peer HTTP 透明代理合同](rabi-agent-interfaces.md#peer-http-透明代理合同源码已接入安装版待验收)。

### 升级入口的自动发现

源码已将透明升级注册为 `manager.rabilink.peer.websocket.proxy`；普通 HTTP 仍使用同一路径的原处理器。合同目录、实际升级分发与 OpenAPI 来自同一活动快照；共用 URL 的 HTTP/升级分别投影，参数 `path` 使用原始 URI 后缀，允许服务根空值。客户端 `openOperation()` 可保留文本、二进制与子协议；透明消息的本机预算可显式设置，不会改成服务端的业务限制。

代理自身摘要与目标版本条件分别传递，目标头 JSON 对象沿现有公共头规则处理，不成为新权限或新管理密钥。实际发送前再次核对原连接；卸载等待已接收写入完成，撤销不会破坏其他请求的加密序号。完整字段见[Peer 透明升级合同](rabi-agent-interfaces.md#peer-透明升级合同源码已接入安装版待验收)。本批源码联测包含真实加密会话与 Socket，目标发现/池选择使用隔离夹具；独立完整构建及编译版验收通过，实际验证共用路径的 HTTP、文本和二进制升级调用；扩展配置仍有 13 条已登记旧声明。真实网络双机与安装运行版本仍待验收。

## 认证、中转与生命周期

设备使用固定 Ed25519 公钥验证会话身份，临时 X25519 协商方向独立的 AES-GCM 密钥。每个方向按序校验，拒绝重放。三种线路使用同一套身份和授权，Relay 仅持有应用隔离的密文通道。

中转每个房间最多两端，待配对缓存不超过十六 KiB，发送积压不超过两 MiB，每房间每秒最多八 MiB。握手和空闲有界；超过限制关闭连接并报告中断，不无限积压。连接不会跨 Manager generation 复用，插件停止会关闭通道、流和事件订阅。

视频专用直连仍保持禁止视频中转的独立合同。

## 兼容与验证

`peer-rpc-v1` 现在仅承担 `system.describe` 和 `transport.offer` / `transport.tunnel` 信令，不再承载只读业务。`POST /api/rabilink/peer/call`、`plans.list` / `persona.manifest` 注册、每业务请求新建 P2P 的调用端及旧清单辅助模块已删除。即使误注册旧业务操作，信令分派器也拒绝执行或列出它。所有读取和写入使用本页的通用 `manager` 连接。

现有受支持手机的 `transport.offer` 与旧 DataChannel 接收端继续用于控制面，且不拥有第二套业务规则；新 PC 只使用一次性、绑定目标 generation/instance 的信令交换，不跨线路重放连接分配。受支持客户端迁移到 `transport.tunnel`、旧控制 wire 使用清零并完成设备验收后，删除旧 offer/DataChannel 接收端。

本轮传输核心 66 项测试通过，覆盖三个本机真实 Runtime 的 A→B→C LAN 转发、未知 PUT 接口、未知请求/响应头、100 KiB 二进制，以及连接复用、真实本机 WebRTC、Relay、SSE/WS 撤权和写入失败不重放。验证入口：`src/peerTunnel/tunnel.test.ts`、`http.test.ts`、`personaBootstrap.test.ts`、`src/rabiPeerClient.test.ts` 与 `src/manager/rabiPeerRoutes.test.ts`。语音展示与播放另见 `speechAdapter.test.ts`、`ribiwebgui/tests/peer-server-presentation.test.ts` 和语音 Python API/peer_compute 测试。真实验收需记录每种线路、RTT、新接口零适配、目标切换、断线、权限拒绝和音频实际播放。真实公网与设备升级的证据独立于本机自动化结果。
