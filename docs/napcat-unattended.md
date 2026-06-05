# NapCat 无值守与登录稳定性

RabiRoute 只负责接收 NapCat / OneBot 事件、记录消息、路由和投递处理端；QQ 登录态属于 NapCat / QQNT。不要把 QQ 账号、密码、Cookie、token 写进 `data/route`、`data/roles`、示例文件或仓库。

## 推荐职责划分

- NapCat：启动 QQNT、维护 QQ 登录态、提供 WebUI、WebSocket Client 和 HTTP Server。
- RabiRoute：监听 WebSocket、调用 OneBot HTTP、展示连接状态、记录消息和路由事件。
- Windows：负责进程守护，例如开机自启 NapCat 和 RabiRoute manager。

RabiRoute 可以监控 NapCat WebSocket 与 HTTP 登录资料读取状态，但不自动输入 QQ 密码，也不绕过验证码、新设备验证或风控确认。

## 无值守登录思路

多数情况下，先用 NapCat WebUI 完成一次扫码登录，然后依赖 NapCat / QQNT 的 quick login。若机器重启后 quick login 经常失败，可以在 Windows 用户环境变量里给 NapCat Shell 提供账号和密码回退信息。

NapCat 侧常见变量：

```text
ACCOUNT=<QQ号>
NAPCAT_QUICK_PASSWORD=<QQ密码>
NAPCAT_QUICK_PASSWORD_MD5=<QQ密码的 MD5>
```

建议优先使用 `NAPCAT_QUICK_PASSWORD_MD5`，只在确认 NapCat 版本和部署方式需要明文密码时才设置 `NAPCAT_QUICK_PASSWORD`。如果 QQ 触发验证码、设备锁、人脸、短信或其他安全校验，仍需要打开 NapCat WebUI 人工完成。

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

## 进程守护

RabiRoute manager 会守护自己启动的路由子进程，并在 `data/route/*/routeConfig.json` 或 `data/roles/*/roleMessageConfig.json` 改动后自动重载受影响路由。它不会启动或重启 NapCat 本体。

NapCat 本体建议用以下方式之一守护：

- Windows 任务计划程序：登录时启动 NapCat Shell。
- NSSM / WinSW：把 NapCat Shell 包装成 Windows 服务。
- 手工启动 NapCat Shell，并保持 QQNT / NapCat 窗口运行。

如果 NapCat 自动退出、QQ 被挤下线或 quick login 失败，先看 NapCat 日志和 WebUI；RabiRoute WebGUI 只能显示 WebSocket 是否连接、HTTP `get_login_info` 是否可用、最近断开时间和错误信息。

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

1. 打开 NapCat WebUI，确认 QQ 已登录，WebSocket Client 和 HTTP Server 已启用。
2. 查看 NapCat 日志里是否有 quick login、二维码登录、设备验证或 ServerTime 偏差提示。
3. 在 RibiWebGUI 看 NapCat 状态：WS 是否连接、HTTP 登录资料是否读取成功。
4. 如果 QQ 经常掉线，先同步 Windows 时间，再重启 NapCat / QQNT。
5. 如果需要无值守，配置 Windows 开机启动 NapCat，再配置 NapCat 侧 `ACCOUNT` 和密码/MD5 环境变量。
