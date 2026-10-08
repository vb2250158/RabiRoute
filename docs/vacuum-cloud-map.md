[English](vacuum-cloud-map_en.md) | 简体中文

# 扫地机云地图连接（实验）

Manager 的米家组件提供扫码连接、原始地图、轨迹查询和显式视频会话，供 DSH、Codex 等已鉴权 Agent 共用。原有 Home Assistant 设备控制继续使用原接口。地图与轨迹查询只读；视频会话不清扫、遥控、导航或录音。

在当前 Rabi WebGUI 的米家 Setup 点击“连接扫地机地图（实验）”，生成二维码，用米家 App 扫描小米的原始图片并在手机完成登录。二维码有效期五分钟，过期后明确开始新登录。选择账号地区，查询扫地机并取图。也可在 Host 动态发布的 Manager 完整地址后打开 `/api/agent/xiaomi-home/vacuum-cloud/connect`；先按[接口指南](rabi-agent-interfaces.md)核对 `/meta`，不固定端口。密码、Cookie、令牌不发到聊天里。

## 接口

以下路径以 `/api/agent/xiaomi-home/vacuum-cloud` 为前缀，复用已有连接鉴权。

| 请求 | 参数 / 返回 |
| --- | --- |
| GET `/status` | connected 表示本机保存了会话；云端有效性由实际设备查询确认。等待登录时含 sessionId、state、expiresAt、imageDataUrl |
| GET `/connect` | 浏览器页面；加载不自动开始登录。可选 view=embedded、数字 deviceId；只允许同源嵌入，匹配设备后进入地图快照刷新 |
| POST `/login` | 空 JSON `{}`、稳定 Idempotency-Key（16–160位字母数字及 `._:-`）、当前 generation/instance 请求头；返回当前扫码状态和原图 |
| POST `/login/poll` | `{ "sessionId": "当前扫码会话ID" }`、当前 generation/instance 请求头；一次最多约25秒等待，成功后追加有界登录跳转和凭据保存；重复同一 sessionId 恢复状态，不重复提交登录 |
| GET `/position?region=cn&deviceId=<设备ID>` | 只读查询已核对型号的 vacuum-position 属性，使用 datasource=2 直接向设备发送 RPC，不退回云缓存；空值返回 unavailable，有值仅返回有界 x/y/yaw 样本。单位与定位更新时间未验证，不作为导航或到达确认 |
| GET `/telemetry?region=cn&deviceId=<设备ID>` | 已核对型号的固定只读状态查询，通过现有云凭据以 datasource=2 读取工作状态、故障、定位开关和雷达状态；返回 statusCode/status、faultCode、locating、lidarCode/lidar。状态8为遥控中，未知状态保留数值并标为 unknown。observedAt 是读取时间，设备更新时间未验证；不发送动作、不提供坐标或到达证明，不允许调用者指定属性或任意 RPC |
| GET `/devices?region=cn` | 数组：deviceId、model、name、online；不返回设备 token |
| GET `/plugin-package?region=cn&deviceId=<设备ID>` | 开发诊断：核对设备归属后下载该型号的米家官方插件，返回版本、包ID、sha256、byteLength 和 packageBase64，供静态协议检查；不执行包，不返回下载签名或云凭据。包及跳转受小米 HTTPS 域名校验，最大64 MiB |
| GET `/plugin-information?region=cn&deviceId=<设备ID>` | 只读官方插件元数据，返回 SDK 版本、云返回码、包ID、版本和是否有下载入口，不返回入口地址。此接口和 plugin-package 可提供 sdkVersion（10000–10199，默认10112），用于匹配插件实际 SDK；空列表不代表设备支持导航 |
| GET `/map?region=cn&deviceId=<设备ID>&slot=0` | 核对云账号中的设备归属后取文件，返回 device、slot、observedAt、byteLength、sha256、blobBase64；支持的 version-2 文件追加 decoded=true、map、grid、rooms、dockPosition、可选 robotPosition；coordinateNavigation 始终为 false |
| GET `/path?region=cn&deviceId=<设备ID>&slot=0&mapHash=<显示文件的SHA256>&targetX=<毫米>&targetY=<毫米>` | 从重新读取且哈希相同的账号地图预览路径；可选 clearanceMm 为200–500整数，默认250。地图变化返回409，不替换起点、不发送设备动作，返回 waypoints、lengthMm、mapSha256、poseFreshness=unverified 和 movementCommandsSent=0 |
| GET `/trajectory?region=cn&deviceId=<设备ID>&poseId=<轨迹游标>` | 调用已确认的只读 get-vacuum-route 合同，返回 points、nextPoseId、newPointCount、可选 latestReturnedPoint；不进入遥控、不移动设备。poseId 必须显式提供0–2147483647，未确认合同的型号返回422 |
| GET `/feedback?region=cn&deviceId=<设备ID>&slot=0` | 共用的地图／轨迹反馈，返回 `map`（原地图结果）和 `feedback`。首轮不传续读参数；后续原样提供上一轮 `feedback.scope` 和 `feedback.nextPoseId` 为 `scope`、`poseId`，两者须同时提供。地图／任务／坐标系或账号身份变化时重置游标，不把旧任务点拼进当前地图 |

地区支持 cn/de/us/ru/tw/sg/in/i2；对象 slot 为0–99，不保证每个对象存在。设备和文件读取不需要动作键或 stateVersion。对象名由连接组件构造，不接受任意 URL、云凭据或调用者提供的对象名。文件及加密响应最多16 MiB，登录响应最多1 MiB。只访问小米 HTTPS 域名，逐次验证跳转；文件下载不携带登录 Cookie。

位置读取的数据源语义按[小米官方 SDK 文档](https://github.com/MiEcosystem/miot-plugin-sdk/wiki/04-miot_spec#ispecgetpropertiesvalueparams-datasource--promisejson)核对：datasource=1 优先读缓存，datasource=2 直接向设备发送 RPC。RPC 返回仍不证明定位引擎已更新样本，因此不据读取时间宣称实时位置。

`feedback` 在轨迹查询前后读取地图，并核对账号、设备、地图、任务及坐标系。它在已消费游标前重叠查询一个点，返回 `newPointCount` 和 `nextPoseId`；重复点不算再次移动，较旧的轨迹尾点不覆盖较新的地图位置。`scope` 是续读身份提示，不增加鉴权或动作权限。调用者切换设备时丢弃续读参数，串行读取，页面隐藏时停止。接口不创建后台轮询或导航任务。

支持的型号反馈含 `source=get-vacuum-route`、`coordinateUnit=millimeters`、`yawUnit=milliradians`；坐标转换已按官方插件核对。`observedAt` 仍是读取时间，`poseFreshness=unverified`、`coordinateNavigation=false`。状态 `sample` 仅说明返回了不早于地图游标的轨迹尾点，不证明机器人正在移动或已到达。地图身份缺失、跨请求任务变化、未支持型号或轨迹查询失败会显式标为不可用并返回地图；轨迹失败不隐藏可读的云快照。调用者必须检查 `feedback.state`，不能把 HTTP 200 当成定位成功。


GET `/video/password?deviceId=...&region=cn` 仅返回 saved；POST `/video/password/forget` 接受 `{deviceId,region}`、当前身份与稳定动作键，GET `/video/password?idempotencyKey=...` 查原删除回执。密码按云账号、地区和设备隔离，由同一云组件使用 Windows 当前用户 DPAPI（其他系统使用已有 AES-GCM）保存于 `vacuum-video-passwords/`；不返回密码，不写浏览器存储、回执、日志或命令行。保存无固定到期时间，设备端更换密码后需重新输入。

## 地图与坐标

pv11cn 栅格含义按官方 version-61 插件核对：0未知、1墙、2临时地面、3–255房间；附加栅格逐格记录隐藏区(1)、不可达区(2)、地毯(4)、障碍物(8)。其他型号不套用此合同，cellSemanticsVerified=false。附加栅格长度必须与地图相同，未知标记按不可通行处理。

路径规划由连接组件中的 `vacuumPath.ts` 提供，复用设备归属校验和同一解码器。起点只取云文件中的机器人快照，八邻域 A* 不斜穿角；墙、隐藏多边形、虚拟墙及附加禁行标记按净空膨胀。250 mm 是保守的预览参数，尚非实机尺寸校准。非零旋转、未知禁区合同、无定位、起点或目标净空不足会明确拒绝，不自动吸附位置。计算上限为100万格、限制区域2000万次检查、25万次展开及50万次入队；仅预览，不保证实际可达或已到达。

`vacuumMapDecoder.ts` 在连接组件内解密 version-2 JSON 文件，解压上限16 MiB、栅格上限4 MiB。失败仍返回原始文件和 decoded=false，不猜文件格式。grid 包含 uint8-row-major 数据、width/height、mapId、originX/originY、resolution、rotation；此格式坐标和分辨率以毫米计，rowZero 为 originY。房间标签来自文件，不把 grid ID 当作设备导航参数。

页面显示栅格、房间名称、基站和可选机器人位置及文件读取／变化时间，点击地图显示坐标并请求路径预览，不发送设备动作。蓝色虚线表示本次快照下的规划路径；地图变化会丢弃旧预览，重新选点。robotPosition 是云文件快照，poseFreshness=unverified；observedAt 是下载时间，不是机器人定位时间。保存地图可能没有机器人位置。非零 rotation 和不同型号坐标约定须另行校准后用于导航。

地图默认适应可用宽度和高度，支持放大、缩小及恢复全图；弹窗高度跟随屏幕。地图详情默认折叠，缩放和窗口尺寸变化不改变原始坐标选点。

宽屏地图右下角提供紧凑的视频预览小窗，播放时默认只显示画面；点击或键盘操作在画面内显示／隐藏控件，隐藏控件不中断连接，窄屏或较窄弹窗中排在地图下方，点击“开启视频”显式建立 MISS 会话；不收音、不录制、不移动机器人。组件复用现有米家云会话申请临时 X25519 材料，视频子程序不持有云登录凭据。只适配已核对的 pv11cn 型号及 TUTK/CS2 传输；其他 vendor 明确拒绝。流传输是否兼容该台设备必须通过真实首帧和浏览器播放验收，不能据摄像头开关 on 或会话 connecting 判断已接通。

Windows 运维者可执行 `scripts/Install-VacuumVideoTransport.ps1 -RuntimeDir <米家组件运行目录>` 安装固定版本 go2rtc 1.9.14（MIT）。脚本校验官方发布 ZIP 和 exe 的 SHA256；不启动进程。会话使用隐藏窗口、随机 loopback 地址及子程序鉴权；临时密钥只传入专属子进程环境，不写入配置或命令行。视频连接不设播放时长上限，由 IPC supervisor 持有；退出视频、正常关闭详情、切换页签、隐藏页面或 Manager 断开时停止。连接握手和单帧请求仍有超时，故障明确返回失败，不无限等待或自动重启摄像头。新会话不发布 expiresAt；历史回执保留原字段供只读查询，不再用于调度，重启后仍为 stopped。会话 JSON 记录 PID、父 PID、Manager PID、开始/结束状态和首帧证据，位于组件运行目录的 `vacuum-video/sessions/`；原生日志关闭以免泄露连接密钥。摄像头开关状态仍每5秒查询，开启流不自动修改该开关。

视频接口以 `/vacuum-cloud/video` 为前缀：POST `/start` 接受 `{deviceId,region,password?,rememberPassword?}`，password 为现有四位视频密码；POST `/stop` 接受 `{sessionId}`。两者要求当前 generation/instance 请求头和稳定 Idempotency-Key。GET `/status` 可选择 sessionId 或 idempotencyKey 查询原会话/回执，不能同时提供；GET `/stream?sessionId=...` 和 `/frame?sessionId=...` 返回已启动会话的 MP4 视频，读取不创建另一会话。启动回执在密码校验之前保存，不含密码或密码散列；重启后原启动键返回 stopped，不能重复拉起摄像头；超时只查原键。首帧通过有界 MP4 数据检查后才设置 firstFrameAt；浏览器实际播放仍单独确认。音频固定关闭。

视频预览窗提供掩码密码输入框，提交时清空；rememberPassword=true 时，设备确认后加密保存到本机，后续省略 password 自动读取。已核对的 pv11cn 官方插件合同为 service 21：verify-video-password（action 7、原字符串参数）、enter-exit-video-page（action 4、进入字符串3、退出字符串4）。密码校验不通过时不进入页面或申请 MISS 密钥；不设置、重置密码或改动共享设置。停止、连接失败和正常 Manager 退出时尝试一次配对退出，pageExit 标记 completed 或 uncertain；进程意外终止时只能保证本机视频进程随 IPC 断开退出，不能声称设备页面退出回执已确认。

视频面板采用响应式布局：预览固定 16:9，窄屏移至地图下方。密码保存后默认折叠输入；提交、连接和播放期间隐藏密码管理，退出回执确认后才允许展开更换或删除；退出不确定时不提前开放。详见[设备界面指南](user-guide/home-devices.md)。

点击“开启视频”时先核对当前 Manager 身份并查询视频拥有者：同一设备、地区已有连接时，接回原会话和画面，不再次校验密码或启动摄像头。已停止的会话不会恢复，另一设备的活动连接不会被退出或接管；Manager 身份变化时拒绝使用旧查询结果。正常退出、关闭详情和页面隐藏仍执行原退出流程。

WebGUI 使用 MediaSource 消费同一会话的 video-only MP4 流，按提供端 Content-Type 核对实际编码，不猜编码、不新增摄像头连接。启动先积累0.3秒解码余量；正常播放保持1倍速度，短暂波动不跳帧。落后超过0.65秒持续1秒才以1.03倍温和追赶，回到0.4秒以内恢复正常速度；落后超过1.5秒持续1秒才跳至最新帧前0.3秒，两次追帧至少间隔5秒。播放位置已落在丢弃的历史之外时立即恢复；缓冲超过6秒才批量清理到最近5秒。退出释放读取、对象 URL 与播放器；不支持的浏览器或编码明确报错，不退回积累旧画面的播放器。操作层显示“播放缓冲”秒数，只表示已收到媒体的播放落后，不包含摄像头、设备传输与网络延迟，不是端到端零延迟保证。参考固定版本 [go2rtc MP4 输出合同](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/internal/mp4/mp4.go)。

## 凭据与恢复

轨迹查询复用同一云会话和设备归属校验，仅允许组件内已验证的查询动作，不接受 siid、aiid、方法名或任意 RPC。当前合同来自 pv11cn 官方第61版插件，返回中的 pose_id 转为 poseId，坐标和可选 yaw 保留原值；每次最多1024点、轨迹 JSON 最多128 KiB。空点集不产生位置，设备拒绝、身份不匹配或不合法数据明确报错。nextPoseId 是已读游标，不是设备定位时间；latestReturnedPoint 可能是历史轨迹，poseFreshness 仍为 unverified，不作为遥控导航或到达验收依据。此接口不启动常驻轮询。

轨迹解析失败会附固定原因（例如 invalid_json、points_type、pose_id、coordinate），不返回原始出错正文或 JSON 解析器片段。原因用于核对真实协议，不能据接口已受理或解析失败推断设备已移动。

云会话由同一连接组件唯一持有，与 HA OAuth 和 HA 访问令牌不同。`vacuum-cloud-session.json` 在插件运行目录，Windows 使用当前用户 DPAPI，其它系统复用本机权限受限密钥和 AES-GCM。API 不返回云凭据、设备 token、签名下载 URL 或登录回调。不保存米家登录密码或续期 passToken；云会话失效后重新扫码。没有新增常驻子程序或后台地图轮询。页面可显式开启5/10/30秒自动刷新，每次请求完成后才安排下一次；页面隐藏时暂停、返回时继续、连续三次失败时停止。相同文件只更新读取时间，不重绘。并发读取同一对象由组件合并，后续新读取重新取文件。

扫码开始保留持久键记录、本代内合并请求。超时读取 status，原键不生成另一二维码；Manager 重启后旧扫码不恢复、不自动重发，先核对连接状态再明确开始新意图。身份变化重新发现地址，写后核对身份，无法核对时标记 uncertain。住宅地图数据只能保存在授权环境，不能提交公开仓库。

## 成熟度

开发诊断可下载账号中扫地机型号的官方插件，供静态协议核对。已取得 pv11cn 第61版官方插件；其共享动作名称表包含到指定位置，但本型号规格没有对应动作绑定，插件中也没有查到该名称的调用参数。start-patrol 只有规格声明，字符串合同仍未确认；这不构成到点导航已接通的证据。插件文件只留在本机诊断目录，不执行或复制进公开仓库。

自动测试覆盖独立 RFC 6229 加密向量、扫码请求合并、受保护会话恢复、设备凭据脱敏、归属检查、下载上限、恶意跳转和有界地图解码。本机验收已完成米家扫码、真实 pv11cn version-2 文件下载、解密和地图绘制；两次文件中的位置有变化，但即时性未验证。其它型号格式、可靠实时定位和物理导航须分别验收；当前没有导航动作或机器人音频桥接。

只读协议参考：[Xiaomi Vacuum 云连接](https://github.com/letitbe-dull/xiaomi-vac/blob/3b358103a0a04fd8cca9c15c35a0c453812311bc/custom_components/xiaomi_vac/cloud/connector.py)。此入口不移植其密码登录或设备动作。更多边界见[家庭设备接口](home-device-agent-api.md)。

视频页面进入/退出动作按官方“无输出”合同接受缺省或空输出，仍严格核对设备、服务、动作与成功码；密码校验输出保持独立严格校验。

GET `/video/network?deviceId=...&region=cn` 返回已归属设备的 localAddress、onLinkInterfacePresent、connectionScope=local-or-relay 和读取时间。地址来自同一云组件，不读取或返回凭据；同网段判断不是设备可达或已连接证明。查询不校验密码、不申请媒体密钥、不进入视频页面。

CS2 视频增加实验性小米中继：认证后的云响应提供有效中继参数时，由同一视频 supervisor 建立有界 UDP 中继，再把加密 MISS 数据交给固定版本 go2rtc。同网段也保留该连接路径，因为同网段不证明原生 MISS 可直连；不会据此丢弃可用的中继参数。中继握手最多30秒，已建立会话持续至显式退出或 IPC 生命周期结束；关闭时释放套接字和子程序。调用者不能指定中继地址，凭据、设备 UID 和中继令牌不进入日志或回执；公开状态仅增加 connectionMode=local 或 relay 及固定失败原因。中继参数缺失时保留原局域网路径；本功能不修改路由器、端口映射或系统网络。真实设备首帧与浏览器播放仍须单独验收。

设备查询和控制由 Home Assistant 提供。地图、轨迹和视频扩展仍由米家云组件提供：官方 HA 小米集成明确不实现地图与 P2P 视频，社区视频入口需要型号公布 camera-stream-for-google-home 等流合同；视频管理开关不等于摄像头流。当前扩展没有被声明为 HA 摄像头实体。线协议参考：[micam CS2 中继说明](https://github.com/eugeneRover/micam)，仅复用协议事实，不移植其登录实现。

端口分配响应按已核对的线协议读取前6字节（4字节令牌和2字节大端端口），允许响应携带尾部扩展；独立8字节向量已纳入回归测试。UDP 报文长度、来源端点及端口仍严格校验，不把仅收到握手响应当作画面成功。

首帧检查与浏览器订阅共用持续的视频源：组件先验证首个完整 MP4 片段，再继续读取并丢弃后续数据，直到退出或 Manager 生命周期结束；不保存录像。这样避免一次性首帧读取结束时关闭 MISS 连接，导致浏览器随后取流失败。2026-10-06 的实机中继会话已取得 MP4 首帧；这仍不能代替浏览器画面和实际导航验收。


中继登记失败时，在同一30秒握手窗口内最多重新发现三轮，重新收集各服务器令牌；登记期间的迟到发现回复仍参与下一轮登记，不重新进入摄像头或重发云启动。失败面板可点击“重新连接”：先确认退出原会话，再开始新的显式连接意图。手动遥控通过[公共 HA 接口](home-device-agent-api.md#手动遥控webgui-与-agent-共用)实现，与云视频会话独立。


CS2 连接先在云组件取得的设备局域网地址进行3秒 UDP 握手，逐包核对来源地址与云 UID；成功后由同一 supervisor 以 loopback 桥接 MISS 数据给固定版本传输组件。不能据同网段或探测回复声称视频已连接，仍需 MISS 首帧与浏览器播放。局域网握手失败时关闭该套接字，再使用保留的认证中继参数，在同一启动意图内回退中继；不重新校验密码、进入设备页面或申请云媒体密钥，不改网络配置。局域网退出使用已核对的 CS2 关闭报文。

局域网握手与关闭报文参考固定版本 [go2rtc 1.9.14 CS2 实现](https://github.com/AlexxIT/go2rtc/blob/v1.9.14/pkg/xiaomi/miss/cs2/conn.go)；Rabi 在转发前额外核对云组件取得的设备 UID。
