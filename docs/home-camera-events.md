[English](home-camera-events_en.md) | 简体中文

# 摄像头事件与 Home Assistant 恢复

状态：源码实现与夹具验证；真实 UAC、计划任务登录启动、HAOS 恢复及摄像头事件录像仍需安装后验收。

## 启动与权限

Bootstrap 在调用 Host 核心前消费自身的 `--elevated-task` 标记；状态命令及其他参数保持原样，非法参数组合继续由核心拒绝。
状态查询成功但返回 `stopped` 时仍执行首次启动授权；只有实际运行或启动中的 Host 才直接复用。

Windows 稳定入口 `RabiRouteHost.exe` 按 `current.json` 定位本地 Host Core，再检查本安装、本用户的最高权限任务。首次缺少任务时请求一次 UAC；确认后创建 `RabiRoute.Host.Elevated.<安装与用户哈希>`，固定执行同一 Host 的 `--elevated-task`，支持用户登录触发和按需启动。已有可信任务直接按需启动，不重复 UAC。任务内已提权的 Host 不递归启动自己。状态查询、自检和控制命令不触发提权。

任务绑定用户 SID、安装路径、固定动作、最高权限和交互登录；外来或被修改的同名任务不执行、不覆盖。拒绝 UAC 或任务服务不可用时，Host 降级继续运行，通过 `/meta.hostPrivilege`、HA 部署页面及本机 `data/runtime/privilege-status.json` 显示受限功能。自启设置同步任务的登录触发器，关闭自启不禁用按需启动。

这是整个 Host 提权：Manager、插件和子进程继承管理员权限，既有已鉴权 Agent 接口的操作也处于该权限上下文。启用前应确认当前插件与远端连接可信；本变更不新增第二套接口权限。

## HA 托管与恢复

`HomeAssistantDeployment` 复用 QQ 的 `NapcatSupervisorService` 生命周期：单实例启动、失败隔离、取消和释放。仅 `autoStart=true` 的本机部署参与自动恢复；不接管外部服务、不自动安装系统组件，也不在后台弹 UAC。安装包内 PowerShell 是插件管理的隐藏子进程，继承 Host 权限，支持取消，不另设 HA 常驻程序或独立恢复任务。Hyper-V 自身独立自启被关闭，启动归 Rabi 管理。

部署配置 `home-assistant-deployment.json` 可设置 `healthCheckIntervalMs`（默认 30000）、`recoveryCooldownMs`（默认 300000）、`recoveryMaxAttempts`（默认 3，范围 1–10）。失败冷却从恢复尝试结束时计算。检查的是基础设施健康，不轮询设备状态或推导业务意图。HTTP 正向就绪证据重置连续恢复预算；失败到达预算后只继续观测，不再修改虚拟机。人工点击启动可重新尝试。断线、恢复、耗尽分别进入既有事件投递和审计入口；所属人格未绑定时不猜测接收人。

恢复只操作安装回执、VM Notes 与磁盘链共同确认的虚拟机。自动路径只 Start/Observe：Running VM 的 Core 未就绪时只观察，不关闭或重启 VM。Off VM 启动前核对实际启动内存与宿主可用内存；内存不足或本次 Start-VM 的 0x800705AA 进入资源等待，按原冷却时间自动重检，不消耗预算。资源恢复后自动续起，无需页面点击。实际网卡与 Core 80/8123 就绪、旧映射及 VM 归属证明继续约束动态回环连接和凭据迁移。安装回执或 VM Running 均不代替 HTTP 就绪。

HAOS Core 仍依赖正常的 Supervisor 启动链。自动启动不重启运行中的 VM，以免中断拉取或更新；显式原生 Recover 兼容入口仍可执行原有一次优雅重启，禁止强制断电。每次操作只接受本次子进程唯一结构化结果，取消、非零退出或缺失／重复结果不冒充资源等待。预算属于当前 runtime 内存，不持久化。未启用 SSH，也不向 Linux HAOS 使用 Windows PowerShell Direct。

事件 WebSocket 在授权／订阅阶段设置超时；订阅后每 30 秒发送 HA 协议 ping，超时未收到匹配 pong 则断开重连。状态提供最近事件时间、传输错误类别与投递状态；投递失败和没有匹配 Route 会进入统一审计，不把录像投递失败误报为抓取失败。已有正确绑定的小米消息 Route 才能收到 Agent 投递；只有账本追加不算投递成功。

`scripts/Test-XiaomiHomePrerequisites.ps1` 默认通过当前 Manager 的身份围栏读取米家健康和部署端点，由 Manager 检查已有受保护授权；脚本不读取或转发 HA／录像环境令牌。显式 `-HomeAssistantBaseUrl` 仅做无凭据网络检查；地址与当前 owner 一致时复用 owner 的授权结果，否则授权状态为未检查。旧令牌环境参数只为调用兼容保留。`ffmpeg` 是录像依赖，`ffprobe` 仅提供可选元数据；连接健康不代表真实摄像头事件或录像已经验收。

## 摄像头与人格目录

仍在现有 Xiaomi Home 插件内：`cameraEvents.ts` 提供统一事件、适配器和路径合同，`xiaomiMiotCameraAdapter` 是首个实现。RTSP、ONVIF 和其他品牌尚未实现。设备事件沿原有 Rabi 事件入口继续交给状态、情景、意图、决策和行动层；基础摄像头层不替 Agent 决定行动。

`settings.json.agentRoleId` 必须显式绑定；缺失时停用事件传输，不回退到任何私有人格。宿主注入现有 `roleDirForApi`，它从 Manager 配置仓库的 `rolesRoot` 解析人格目录，不从插件字符串猜路径。录像保存为：

```text
<人格目录>/camera/<cameraId>/<YYYY-MM-DD>/<eventId>.mp4
```

日期采用事件时间的 UTC 日期；不安全路径字符采用可逆百分号编码。事件 ID 基于适配器、摄像头、发生时间和事件类型，不包含会轮换的签名 URL。路径拒绝缺失人格根、目录联接及越界；跨盘落盘采用排他复制，不覆盖已有文件。artifact 按人格与 sourceEventId 共同去重，`camera_clip_ready` 记录带原 `sourceEventId`、`cameraId` 和 `artifactId`。

米家录像仍需 HA 提供真实 `motion_video_*` 属性并启用 `cameraClipCaptureEnabled`。`cameraClipAllowedHosts` 为空时不限制媒体主机；配置非空列表后，播放列表、重定向和片段的主机都必须匹配。可根据实际授权的媒体来源配置该列表，不向 Agent 暴露临时签名 URL。

角色自动化的米家消息触发设置中可点击“打开录像文件夹”，打开该角色的 `camera` 目录。旧 `xiaomi-media` 目录仍保留，不会自动迁移或删除。

## 安装后验收与旧任务清理

1. 安排窗口切换到通过构建的候选；当前运行中的 Host 不由本次源码修改重启。
2. 本人启动候选 Host 并确认首次 UAC；拒绝时核对普通功能继续工作及受限提示。
3. 核对最高权限 Host 任务的 SID、固定路径、登录触发器、按需启动和进程实际权限；复测再次启动不重复 UAC。
4. 核对 HA Core、实时 IP、转发、事件订阅及一次有界故障恢复，确认异常／耗尽／恢复事件可见。
5. 真实触发摄像头事件，核对同一 eventId 的人格事件记录、录像文件、artifact 摘要及播放结果。
6. 上述验收通过后，由本人决定停用并删除旧 `RabiRoute.HomeAssistantOs.Recovery.<哈希>` 及其专属 ProgramData helper。先导出任务 XML、校验 Description、用户、动作与安装归属；不得删除 VM、VHDX、HA 配置、凭据或录像。未验收前保留旧文件，但不同时运行旧恢复任务与新恢复入口。

管理员 Host 的本机控制管道按当前账号 SID 设置独占 ACL，允许同账号普通权限 CLI 查询及调用既有受鉴权生命周期命令；不向 Administrators、Everyone 或其他账号放权。
