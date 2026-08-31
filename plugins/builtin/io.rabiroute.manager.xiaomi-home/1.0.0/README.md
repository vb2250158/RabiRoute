# Xiaomi Home Manager 插件

RabiRoute 的唯一 `xiaomiHome` 业务入口。当前版本通过 Home Assistant REST API 提供设备目录和状态查询，通过 WebSocket 自动订阅状态变化，并提供 typed capability 动作门与本机摄像头 artifact 账本。

小米 OAuth 与 Home Assistant token 不写入插件配置。请只在本机运行环境设置 `RABIROUTE_XIAOMI_HOME_HA_TOKEN`。插件默认 `writeEnabled=false`；完成只读验收后才能显式开启控制。

`eventDeliveryMode=significant` 只投递离线、事件和移动告警。摄像头移动实体必须在真实设备枚举后加入 `cameraMotionEntityIds`；不要仅凭实体名称猜测摄像头归属。

小米官方 Home Assistant 集成不提供摄像头图片或视频流。录像读取必须由内部社区 provider/抓取 Worker 先落成本机受控 artifact，不能把临时云 URL 或本机路径直接交给 Agent。

社区 Worker 可识别 Xiaomi Miot Auto 的 `motion_video_*` 属性，按 `cameraClipAllowedHosts` 白名单抓取 HLS、处理 AES-128 分片并合并 MP4。`cameraClipCaptureEnabled` 默认关闭；真实设备枚举后才能登记实际小米媒体域名。录像内容通过 `/api/agent/xiaomi-home/artifacts/:artifactId/content` 读取，要求 `RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN`，支持 HTTP Range，并记录读取审计。
