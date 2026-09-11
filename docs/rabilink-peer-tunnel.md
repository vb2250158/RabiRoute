# 跨电脑通用连接与语音服务器

[English](rabilink-peer-tunnel_en.md) | 简体中文

状态：实验实现。自动化覆盖本机双端局域网、真实 WebRTC、隔离中转、HTTP 流、WebSocket、取消及 RTT；真实双 PC、公网跨运营商和目标语音模型仍需验收。源码与测试通过不等于远端设备已经升级。

## 使用方式

WebGUI 的“语音服务”顶部提供“语音服务器”。每项展示设备名称、在线状态、实际线路和实测往返延迟，例如“工作站 · 在线 · P2P直连 · 42 ms”。本机显示“本机调用”，不伪造 0 ms。

打开下拉框会检测最多十个可用目标，最多同时建立两条连接；选中目标优先。未升级的设备显示“需要升级”，没有配置信任的设备显示“未授权”。离线项不能新选择；已选设备离线后保留选择，不偷偷切回本机。

设备在线、通道连通、语音服务可用是不同状态。没有健康连接时不显示历史线路；RTT 超过三十秒没有刷新时显示“延迟待检测”。RTT 是同一加密通道的 ping/pong 往返，不包含模型加载、TTS 合成或 ASR 识别。页面通过事件更新，打开菜单时维护可见目标的连接心跳，关闭后只保留所选目标；未使用的连接六十秒后释放。

选择 B 后，模型、音色、TTS 和手动 ASR 请求交给 B；麦克风设备与播放 FIFO 留在 A。远端 TTS 禁止在 B 播放，完成的 PCM WAV 进入 A 的原播放队列。常驻麦克风在有 Manager 地址时读取当前选择：选中远端才经 Manager 转写；没有远端选择时保留原本地识别。远端失败不转为本机识别。模型管理与服务启停作用于 B，需要 B 的 manager 服务授权。

## 自动选路

1. 局域网候选地址并行验证，总预算两秒。
2. 失败后尝试 WebRTC P2P，预算十秒。仅 STUN，无 TURN。
3. 失败后建立服务器中转，预算五秒。

健康连接复用，不按每个接口重新打洞。局域网通过 DNS-SD 的 rabitunnel 服务发现已信任设备，地址和身份仍在加密握手中核对；服务器不可用时已发现的 LAN 目标仍能使用。局域网发现新地址时可升级线路，新请求使用新连接，旧连接上的流正常结束后释放。

连接预算与业务超时分开。请求交给目标后不自动重放；中断可能意味着结果未知。HTTP 取消传给目标，已开始的音频不自动重新播放。没有端点幂等合同就不承诺写请求恰好执行一次。

## 一次性设备信任

两端均需包含 peer-tunnel-v1，Relay 需包含 /api/rabilink/tunnel/socket。通过各自 Host status --json 取得当前 managerBaseUrl，并用 /meta 核对健康、generation 与实例。不要保存 Manager 端口。

本机 GET /api/rabilink/peer/identity 返回设备 ID、当前 generation 和公开 Ed25519 密钥。私钥由应用生成，保存在运行数据目录的 data/rabilink/tunnel-identity.json，不通过 API 返回，不能提交仓库。

管理员核对对端公钥后，在各自运行数据目录的 data/rabilink/tunnel.json 中登记信任。例：

~~~json
{
  "selectedDeviceId": "",
  "trustedDevices": [
    {
      "deviceId": "peer-b",
      "publicKey": "对端 identity 返回的完整 PEM 公钥",
      "services": ["speech"]
    }
  ],
  "services": {}
}
~~~

services 表示允许该对端调用本机的哪些服务。只将对端作为服务器时仍需登记其公钥，入站 services 可以为空；B 要允许 A 合成时，B 的 A 条目需含 speech。manager 是完整管理服务授权，只有明确允许对方管理本机时添加。

信任不是自动配对：共享应用 token 不能替代独立设备授权。密钥改变会拒绝连接，必须重新核对。配置错误关闭远程访问，不重置为本机。授权在每个新请求时复核。

只读验收模式禁止切换服务器、建立入站隧道及经通用代理转发请求。

## 通用接口

控制入口使用 Manager 主监听端口及现有 WebGUI 鉴权，支持本机局域网地址和已授权的远程浏览器；独立的对端发现端口不提供 WebGUI 控制访问。

调用方的 Manager 入口：

~~~text
GET  /api/rabilink/peer/servers
POST /api/rabilink/peer/probe           { "deviceIds": ["peer-b"] }
GET  /api/rabilink/peer/selection
PUT  /api/rabilink/peer/selection       { "deviceId": "peer-b" }
GET  /api/rabilink/peer/events?ids=[...]  SSE；ids 需 URL 编码
任意受支持方法 /api/rabilink/peer/http/<设备>/<服务>/<原路径>
~~~

同一 http 入口支持 WebSocket Upgrade。服务只登记 baseUrl 和可选 pathPrefix；新接口不注册远程业务操作。Manager 地址每代重新提供，speech 地址来自现有语音配置。额外服务只可由本机管理员在 services 中登记，不接受远端任意 URL；禁止递归访问隧道管理入口。

HTTP、二进制、上传下载、SSE 和 WebSocket 共用分帧、多路复用和每流窗口控制。每连接最多十六个流，单帧约三十二 KiB，发送数据块十二 KiB。隧道不把整个文件装进 JSON。普通语音控制 API 保留现有有界缓冲合同，流式使用通用接口。

同源重定向保留设备与服务前缀，跨源重定向拒绝。正文中的 URL 是业务数据，不做猜测改写；扩展接口应返回服务相对路径。浏览器凭据不自动复制到对端。需要服务凭据的独立服务，由管理员在目标服务配置中提供受管 headers。

## 认证、中转与生命周期

设备使用固定 Ed25519 公钥验证会话身份，临时 X25519 协商方向独立的 AES-GCM 密钥。每个方向按序校验，拒绝重放。三种线路使用同一套身份和授权，Relay 仅持有应用隔离的密文通道。

中转每个房间最多两端，待配对缓存不超过十六 KiB，发送积压不超过两 MiB，每房间每秒最多八 MiB。握手和空闲有界；超过限制关闭连接并报告中断，不无限积压。连接不会跨 Manager generation 复用，插件停止会关闭通道、流和事件订阅。

视频专用直连仍保持禁止视频中转的独立合同。

## 兼容与验证

peer-rpc-v1 保留为旧客户端只读兼容和小型信令入口。新通用请求不使用旧逐项业务分发；信令使用单次 Relay 交换，不跨线路重放分配请求。移除条件：受支持设备完成隧道升级、信令入口迁移、旧客户端调用证据清零，并完成双 PC 验收；在该迁移里程碑删除旧 DataChannel 与业务分发。

测试：src/peerTunnel/tunnel.test.ts、src/peerTunnel/speechAdapter.test.ts、ribiwebgui/tests/peer-server-presentation.test.ts，以及语音 Python API/peer_compute 测试。真实验收需记录每种线路、RTT、新接口零适配、目标切换、断线、权限拒绝和音频实际播放。真实公网与设备升级的证据独立于本机自动化结果。
