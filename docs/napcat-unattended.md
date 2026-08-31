<!-- docs-language-switch -->
<div align="center">
<a href="./napcat-unattended_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# NapCat 无值守与登录稳定性

> 状态：现行指南。RabiRoute 可管理、扫描和启动 NapCat 实例，但 QQ 登录验证仍由 NapCat/QQNT 负责。

RabiRoute 负责接收 NapCat / OneBot 事件、记录消息、路由和投递处理端，也可以在 Manager 启动后或用户点击“启动并管理登录”时编排本机 NapCat 的启动、三种 QQ 登录方式和 OneBot 连接修复。QQ 登录凭据和安全校验仍由 NapCat / QQNT 解释；Rabi 只代理当前这次本机操作。不要把 QQ 密码、Cookie、token 写进 `data/route`、`data/roles`、示例文件或仓库。

## 推荐职责划分

- NapCat：启动 QQNT、维护 QQ 登录态，并在本机提供登录、WebSocket Client 和 HTTP Server 接口。
- RabiRoute：监听 WebSocket、调用 OneBot HTTP、展示连接状态、记录消息和路由事件；实例启用“启动 Rabi 时自动登录”后，Manager 监听成功即在后台执行启动、quick login 和 OneBot 修复。用户也可以在当前 Route 的 NapCat 卡片点击“启动并管理登录”立即进入同一流程。
- Windows：负责进程守护，例如开机自启 NapCat 和 RabiRoute manager。

密码登录时，明文只存在于当前浏览器表单和一次 Manager 请求中；Manager 立即计算 MD5 后调用 NapCat，不把明文或 MD5 写入 Route 配置、日志或响应。RabiRoute 不绕过验证码、新设备验证或风控确认：腾讯验证码和手机 QQ 扫码仍由用户亲自完成，确认后卡片继续复查连接。

## Route 卡片内的 NapCat 登录与管理

一个 Route 只绑定一个 NapCat；另一个 QQ 应使用另一个 Route。路由页当前绑定的“启动并管理登录”按下面顺序工作，不再打开或嵌入 NapCat WebUI：

1. 目标实例已经在线且账号匹配：复用现有会话，不重启 QQNT/NapCat。
2. 目标实例未就绪：先扫描本机已配置和可发现的 OneBot HTTP 端点，用 `get_status` 与 `get_login_info` 确认这个 QQ 是否已经由另一 NapCat 实例持有。
3. 账号已在另一实例在线：保留现有会话，拒绝启动或快捷登录第二份实例；页面显示真实在线实例，可由用户明确选择“采用在线实例”。
4. 没有其他在线持有者且 NapCat 未启动：按该实例的 `launchCommand` 和 `workingDir` 隐藏启动，并等待本机管理接口。
5. 卡片通过 Manager 获取登录状态和二维码，只展示三种正式入口：快速登录、密码登录、扫码登录。
6. 快速登录只列出 NapCat 已保存的身份；密码登录遇到腾讯验证码或新设备验证时，卡片显示相应安全步骤；扫码登录由 Manager 把 NapCat 的二维码内容转换为本地图片后显示。
7. QQ 已登录但 OneBot 未连通：Rabi 自动写入并应用该实例的 HTTP / WebSocket 配置，再复查 OneBot 和 RabiRoute WS。

前端只调用 `/api/message/napcat-login-panel` 和 `/api/message/napcat-login-action`。WebUI token 与鉴权 Credential 留在 Manager 内部，登录响应使用 `Cache-Control: no-store`；Route 卡片不持有 NapCat 管理会话，也不把 WebUI 当第二个控制面。

健康检查接口保持只读；登录、启动和配置修复由 manager 的 `napcat-ensure-ready` 动作编排。启动时自动登录在 Manager 开始监听后异步执行，Manager 不等待 NapCat 检查或登录完成。

同一绑定 QQ 的启动、重启和停止动作会按账号串行执行。即使用户双击按钮、两个入口同时触发，或映射盘路径与 UNC 路径同时指向同一套 NapCat，也只允许一条生命周期操作进入；真正启动前还会再次读取 OneBot 登录状态，已就绪时直接复用，不创建第二棵 QQNT/NapCat 进程。该防重只保护进程生命周期，不会绕过扫码、验证码、设备确认或其他 QQ 安全验证。

页面把四层状态分开显示：NapCat 管理接口是否可达、QQ 登录身份、OneBot HTTP 是否在线，以及 RabiRoute WebSocket 是否已连接。管理接口可达不等于 QQ 已登录，QQ 已登录也不等于消息已经进入 RabiRoute。

“采用在线实例”只把当前 QQ 卡片的 HTTP、WebUI 和工作目录改为已确认在线的实例，不会退出 QQ、停止旧进程或自动迁移登录。若在线实例尚未指向当前网关，页面会继续要求修复 OneBot WebSocket 路由。

## 无值守登录思路

多数情况下，先在 Rabi 的 NapCat 卡片完成一次扫码登录，然后依赖 NapCat / QQNT 的 quick login。若机器重启后 quick login 经常失败，可以在 Windows 用户环境变量里给 NapCat Shell 提供账号和密码回退信息。

NapCat 侧常见变量：

```text
ACCOUNT=<QQ号>
NAPCAT_QUICK_PASSWORD=<QQ密码>
NAPCAT_QUICK_PASSWORD_MD5=<QQ密码的 MD5>
```

建议优先使用 `NAPCAT_QUICK_PASSWORD_MD5`，只在确认 NapCat 版本和部署方式需要明文密码时才设置 `NAPCAT_QUICK_PASSWORD`。如果 QQ 触发验证码或新设备扫码，Rabi 卡片会显示对应流程；人脸、短信或当前 NapCat API 未覆盖的验证仍会明确停下，不会绕过安全门。

## Windows 永久环境变量

PowerShell 示例：

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD_MD5 "<password-md5>"
```

如果必须使用明文密码：

```powershell
setx ACCOUNT "<qq-account>"
setx NAPCAT_QUICK_PASSWORD "<qq-password>"
```

`setx` 写入后，只对新启动的进程生效。设置完后重启 NapCat Shell；如果 NapCat 是开机自启服务，也需要重启对应服务或重新登录 Windows 会话。

不要在命令行截图、日志、Issue、PR、文档示例或 RibiWebGUI 配置里保留真实值。需要排障时只说变量是否存在和值长度，不打印密码。

## 启动时自动登录

每个 Route 所绑定的 NapCat 都有“启动 Rabi 时自动登录”开关，默认开启。开启后，Manager 监听成功即提交后台任务：先复用已在线的正确账号，否则启动绑定的 NapCat Shell、选择已有 quick login，并修复 OneBot HTTP / WebSocket 配置。不同 Route 并发处理；绑定同一 QQ 的任务按账号串行。Manager 启动和 WebGUI 访问不等待这些步骤。

关闭开关只跳过该实例的启动时自动登录；“启动并管理登录”、健康检查、手动启动和重启仍可使用。需要扫码、验证码或新设备确认时，后台任务记录实际状态，用户之后直接在对应 Route 卡片完成验证。

## 进程守护

RabiRoute manager 会守护自己启动的路由子进程，并在 `data/route/*/adapterConfig.json` 或 `data/roles/*/personaConfig.json` 改动后自动重载受影响路由。NapCat 的启动时自动登录只运行一次；运行期间退出、掉线或登录失效后，仍由健康状态提示和用户操作处理。

NapCat 本体建议用以下方式之一守护：

- Windows 任务计划程序：登录时启动 NapCat Shell。
- NSSM / WinSW：把 NapCat Shell 包装成 Windows 服务。
- 手工启动 NapCat Shell，并保持 QQNT / NapCat 窗口运行。

如果 NapCat 自动退出、QQ 被挤下线或 quick login 失败，先在对应 Route 点击“启动并管理登录”。自动恢复失败时，再展开详情查看 NapCat 日志、WebSocket 状态、HTTP `get_login_info` 和最近错误。

## RabiRoute 侧健康检查

RabiRoute NapCat adapter 会定期调用 OneBot `get_login_info`，默认每 60 秒一次。结果写入：

```text
data/route/<配置名>/gateway-status.json
```

可用环境变量调整频率：

```powershell
setx NAPCAT_LOGIN_REFRESH_SECONDS "30"
```

填 `0` 或负数可以关闭定期检查。这个检查只负责发现和展示登录态问题，不会替 NapCat 重新登录。

## 排查顺序

1. 在当前 Route 的 NapCat 卡片刷新登录状态，确认 QQ、OneBot HTTP 和 RabiRoute WS 各自的状态。
2. 查看 NapCat 日志里是否有 quick login、二维码登录、设备验证或 ServerTime 偏差提示。
3. 在 RibiWebGUI 看 NapCat 状态：WS 是否连接、HTTP 登录资料是否读取成功。
4. 若显示“账号在其他实例在线”，优先采用该在线实例；不要重复启动同一 QQ。只有确实需要迁移时，才先明确停止旧实例，再启动目标实例。
5. 若显示“快速登录已过期”，在卡片切到“扫码登录”并刷新二维码；不要持续点击快速登录。
6. 如果 QQ 经常掉线，先同步 Windows 时间，再重启 NapCat / QQNT。
7. 如果需要无值守，配置 Windows 开机启动 NapCat，再配置 NapCat 侧 `ACCOUNT` 和密码/MD5 环境变量。
