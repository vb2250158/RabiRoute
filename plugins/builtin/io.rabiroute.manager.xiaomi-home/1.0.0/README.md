<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Xiaomi Home Manager 插件

RabiRoute 的唯一 `xiaomiHome` 消息端。它通过 Home Assistant REST API 提供设备目录和状态查询，通过 WebSocket 订阅状态变化，并提供 typed capability 动作门、有人移动事件和本机摄像头 artifact 账本。

## 配置与授权

在 WebGUI 的“消息适配器”中为当前 Route 添加“米家 / Xiaomi Home”，展开后先在连接卡片提交 Home Assistant 地址和长期访问令牌，再在策略卡片配置事件、设备控制和录像。首次保存前，完整设置来自插件 Profile；首次保存后，本机 Xiaomi Home 运行目录中的 `settings.json` 是策略设置真源。Manager 使用 revision 围栏与原子写入热加载客户端、事件监听和录像抓取，无需编辑 `dist/plugins/profiles/desktop.json`。

登录凭据只由本机受保护凭据库保存：Windows 使用当前用户 DPAPI，其它系统使用权限受限本机密钥和 AES-256-GCM。Route 配置、设置文件、日志和 API 响应不会保存或回显明文 token。认证请求必须携带当前 Manager lifecycle fence 与稳定 `Idempotency-Key`；地址和候选令牌会先一起验证，随后才提交。录像 artifact 仍使用独立读取凭据：

- `RABIROUTE_XIAOMI_HOME_ARTIFACT_TOKEN`：Agent 读取本机录像 artifact 时使用的独立 Bearer token。

所有 PUT/POST mutation 都要求从当前 Manager `/meta` 取得并携带：

- `x-rabiroute-expected-application-generation-id`
- `x-rabiroute-expected-manager-instance-id`

WebGUI 使用相对 Manager API，并在每次保存前重新读取 `/meta`，不固定或扫描 Manager 端口。

从已授权的局域网 WebGUI 可以读取健康状态并保存该消息端配置。设备目录、控制动作和录像内容接口仍只接受本机回环请求。

插件默认 `writeEnabled=false`。先保持只读，完成地址、token、资源枚举和事件订阅验收后，再在 WebGUI 显式开启设备控制。动作还要求 `Idempotency-Key` 与最新 `expectedStateVersion`。

默认地址策略允许 `localhost`（会固定为回环 IP）及字面量的回环、私网、链路本地 IPv4/IPv6 地址，避免 DNS 重绑定把 Home Assistant Bearer token 带到另一个目标。除回环外默认必须使用 HTTPS；兼容私网 HTTP 时必须显式开启 `allowInsecurePrivateHttp`，并接受令牌可能在局域网被截获的风险。普通域名（包括 `.local`）必须显式开启 `allowPublicBaseUrl` 才能使用，但公网地址始终要求 HTTPS；这表示操作者信任该域名的解析。地址不得包含用户名、密码、路径、查询或 fragment，REST 请求也不会跟随重定向。

同一设备动作的完整 intent 会绑定到持久 `Idempotency-Key` receipt。并发请求和 Manager 重启只会读取或恢复同一 receipt；不同 intent 返回冲突。外部调用结果不确定时仅做 Home Assistant 状态读回，无法确认就停止，绝不自动重发设备动作。

## 事件与摄像头录像

`eventDeliveryMode=significant` 只投递离线、事件和移动告警。摄像头移动实体必须在真实 Home Assistant 资源枚举后加入 `cameraMotionEntityIds`；不要仅凭名称猜测摄像头归属。

小米官方 Home Assistant 集成不提供摄像头图片或视频流。社区链路可使用 Xiaomi Miot Auto 暴露的 `motion_video_*` 属性：抓取 Worker 按 `cameraClipAllowedHosts` 白名单读取 HTTPS HLS，处理 AES-128 分片并合并 MP4，再登记为本机 artifact。`cameraClipCaptureEnabled` 默认关闭；只有从真实事件 URL 确认媒体主机后才能登记白名单。

录像列表和元数据通过 `/api/agent/xiaomi-home/artifacts` 读取；内容通过 `/api/agent/xiaomi-home/artifacts/:artifactId/content` 读取，要求 artifact token，支持 HTTP Range，并记录读取审计。临时云 URL 和本机文件路径都不会直接交给 Agent。
