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

部署配置 `home-assistant-deployment.json` 可设置 `healthCheckIntervalMs`（默认 30000）、`recoveryCooldownMs`（默认 300000）、`recoveryMaxAttempts`（默认 3，范围 1–10）。检查的是基础设施健康，不轮询设备状态或推导业务意图。HTTP 正向就绪证据重置连续恢复预算；失败到达预算后只继续观测，不再修改虚拟机。人工点击启动可重新尝试。断线、恢复、耗尽分别进入既有事件投递和审计入口；所属人格未绑定时不猜测接收人。

恢复只操作安装回执、VM Notes 与磁盘链共同确认的虚拟机。读取实际网卡 IP，同步仅回环的 `8123 → IP:8123`；已有本安装的 `80` 错误映射可迁移，外来占用立即停止。Core 等待 90 秒仍不健康且 VM 原已运行时，一次恢复最多优雅关闭／启动一次 VM，再等 180 秒；关闭等待最多 90 秒，不强制断电。新启动的 VM 未就绪时保留现场，下轮有界恢复再判断。Core 恢复后重新读取 IP。`installed` 文件或 VM 在运行都不能代替 HTTP 就绪。

HAOS 的 Core 启动依赖其 Supervisor 的正常启动链；若一次优雅重启仍不能恢复，Rabi 报错并遵守重试预算，不宣称恢复成功。未启用 SSH，也不向 Linux HAOS 使用 Windows PowerShell Direct。

事件 WebSocket 在授权／订阅阶段设置超时；订阅后每 30 秒发送 HA 协议 ping，超时未收到匹配 pong 则断开重连。状态提供最近事件时间、传输错误类别与投递状态；投递失败和没有匹配 Route 会进入统一审计，不把录像投递失败误报为抓取失败。已有正确绑定的小米消息 Route 才能收到 Agent 投递；只有账本追加不算投递成功。

## 摄像头与人格目录

仍在现有 Xiaomi Home 插件内：`cameraEvents.ts` 提供统一事件、适配器和路径合同，`xiaomiMiotCameraAdapter` 是首个实现。RTSP、ONVIF 和其他品牌尚未实现。设备事件沿原有 Rabi 事件入口继续交给状态、情景、意图、决策和行动层；基础摄像头层不替 Agent 决定行动。

`settings.json.agentRoleId` 必须显式绑定；缺失时停用事件传输，不回退到任何私有人格。宿主注入现有 `roleDirForApi`，它从 Manager 配置仓库的 `rolesRoot` 解析人格目录，不从插件字符串猜路径。录像保存为：

```text
<人格目录>/camera/<cameraId>/<YYYY-MM-DD>/<eventId>.mp4
```

日期采用事件时间的 UTC 日期；不安全路径字符采用可逆百分号编码。事件 ID 基于适配器、摄像头、发生时间和事件类型，不包含会轮换的签名 URL。路径拒绝缺失人格根、目录联接及越界；跨盘落盘采用排他复制，不覆盖已有文件。artifact 按人格与 sourceEventId 共同去重，`camera_clip_ready` 记录带原 `sourceEventId`、`cameraId` 和 `artifactId`。

米家录像仍需 HA 提供真实 `motion_video_*` 属性，且 `cameraClipCaptureEnabled=true`、`cameraClipAllowedHosts` 非空。只从已验证的真实 URL 配置媒体主机；不自动放宽白名单、不向 Agent 暴露临时签名 URL。

## 安装后验收与旧任务清理

1. 安排窗口切换到通过构建的候选；当前运行中的 Host 不由本次源码修改重启。
2. 本人启动候选 Host 并确认首次 UAC；拒绝时核对普通功能继续工作及受限提示。
3. 核对最高权限 Host 任务的 SID、固定路径、登录触发器、按需启动和进程实际权限；复测再次启动不重复 UAC。
4. 核对 HA Core、实时 IP、转发、事件订阅及一次有界故障恢复，确认异常／耗尽／恢复事件可见。
5. 真实触发摄像头事件，核对同一 eventId 的人格事件记录、录像文件、artifact 摘要及播放结果。
6. 上述验收通过后，由本人决定停用并删除旧 `RabiRoute.HomeAssistantOs.Recovery.<哈希>` 及其专属 ProgramData helper。先导出任务 XML、校验 Description、用户、动作与安装归属；不得删除 VM、VHDX、HA 配置、凭据或录像。未验收前保留旧文件，但不同时运行旧恢复任务与新恢复入口。

管理员 Host 的本机控制管道按当前账号 SID 设置独占 ACL，允许同账号普通权限 CLI 查询及调用既有受鉴权生命周期命令；不向 Administrators、Everyone 或其他账号放权。
