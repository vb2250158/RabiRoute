<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Xiaomi Home Manager 插件

RabiRoute 的唯一 `xiaomiHome` 消息端。它通过 Home Assistant REST API 提供设备目录和状态查询，通过 WebSocket 订阅状态变化，并提供 typed capability 动作门、有人移动事件和本机摄像头 artifact 账本。

## 配置与授权

连接故障与授权提示在连接卡片处理；事件监听状态和重新检查入口位于监听开关旁，设备控制与录像关闭时显示“已关闭”。米家卡片顶部仅保留整体状态，不再重复展示“环境和依赖”告警列表。尚未保存的开关变化单独标记，不冒充已生效状态。

### Home Assistant 安装与启动

连接卡片先显示“Home Assistant 安装与启动”。已有 Docker 安装选择“本机 Docker 容器”并填写容器名称；检测结果显示官方镜像、容器位置和 `/config` 的实际挂载目录。引擎不可达显示“安装状态未知”，不会误报未安装；找不到指定容器才显示“未找到安装”。Setup 中的“安装 Home Assistant OS”自动按页面显示的本机预设路径安装 Hyper-V 虚拟机：检查并启用 Hyper-V、下载官方稳定版 VHDX、校验 SHA256、创建 2 核 / 2 GiB 虚拟机，并仅映射到本机 `127.0.0.1:8123`。首次启用需要 Windows 管理员确认，要求重启时暂停；重启后再次点击安装继续。路径固定在米家本机运行目录的 `home-assistant-os/`，不由浏览器传入。已有 Docker 容器只保留检测和启动；不会自动安装 Docker Desktop。Windows 虚拟机或远端安装选择“外部服务”，由其宿主管理启动。

启用“启动 Rabi 时自动启动 Home Assistant”并保存后立即执行一次启动检查，此后米家插件启动时自动复用或启动该容器。Windows Docker Desktop 引擎离线时，启动动作尝试官方 `docker desktop start`；失败显示错误，不改用任意脚本。仅管理官方 Home Assistant 镜像且本机 `8123/tcp` 端口映射与已保存服务地址一致的容器，启动使用检测得到的不可变容器 ID。请求串行化，已就绪不重复启动；就绪等待最多 60 秒，失败后可以重试。关闭 Rabi 取消等待，但不会停止共享的 Home Assistant 容器或 Docker 引擎。

部署绑定与自动启动开关由本机 `home-assistant-deployment.json` 唯一保存，独立于登录凭据和 Route 策略。`GET/PUT /api/agent/xiaomi-home/deployment` 与 `POST /api/agent/xiaomi-home/deployment/start`、`POST /api/agent/xiaomi-home/deployment/install` 只允许本机回环；修改要求当前 Manager lifecycle fence 与部署 revision。启动是按目标状态执行的幂等操作。页面只有在已保存地址的服务就绪后才允许打开登录和令牌页。小米账号仍在[小米官方集成](https://github.com/XiaoMi/ha_xiaomi_home/blob/main/doc/README_zh.md)中授权。

在 WebGUI 的“消息适配器”中为当前 Route 添加“米家 / Xiaomi Home”，展开后先在 Setup 标签提交 Home Assistant 地址和长期访问令牌，再在设置标签配置事件、设备控制和录像。首次保存前，完整设置来自插件 Profile；首次保存后，本机 Xiaomi Home 运行目录中的 `settings.json` 是策略设置真源。Manager 使用 revision 围栏与原子写入热加载客户端、事件监听和录像抓取，无需编辑 `dist/plugins/profiles/desktop.json`。

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

### HA OS 安装边界

预设路径必须在本机固定磁盘且不经过 reparse point。下载需要至少 40 GiB 空间；只接受官方 GitHub 稳定 release 的 VHDX ZIP 与 SHA256。已有磁盘和同名非受管虚拟机不覆盖；端口被其他服务占用时停止。安装器使用独立互斥锁防止重复创建，不自动重启 Windows，不创建 LAN 防火墙放行规则。安装状态不等于服务就绪；Manager 另行检查 Home Assistant HTTP 响应。首次初始化、Home Assistant 账号和小米授权仍由用户完成。

“随 Windows 启动虚拟机”由 Hyper-V 在安装或启动操作时应用；如果重启后虚拟机地址改变，点击“启动并检查”更新本机转发。安装器记录接续状态，管理员取消、下载失败或环境不支持时显示错误。跨重启自动恢复和真实 VM 启动仍须在目标 Windows 环境验收。
