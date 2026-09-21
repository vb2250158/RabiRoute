[English](napcat-onebot_en.md) | 简体中文

# NapCat / OneBot 详细参考

发送前先读取 [Rabi 消息投递工作流](../../rabiroute-message-delivery/SKILL.md)。直连仅用于不受 Rabi 管理的独立安装，或已确认 Rabi 不可用、原消息未生效且身份和授权均已核对的故障旁路。Rabi 可用时统一走受管接口。不能以认证失败为理由绕过权限；结果未知须先核对原回执，不能重发试探。

## 位置与当前连接

安装目录和入口由本机安装版本决定。`<DownloadsRoot>/NapCat.Shell.Windows.OneKey.zip`、`<NapCatRoot>`、`NapCatInstaller.exe`、`NapCat.<version>.Shell/napcat.bat` 仅是布局线索，使用前核对存在及版本。账号配置位于该版本实际配置根，不从残留目录选择账号。

从当前配置或受管状态取得 WebUI、反向 WebSocket 和 OneBot HTTP 的完整地址及认证方式；不套用旧端口、不扫描端口猜测服务。示例使用显式注入的 `ONEBOT_BASE_URL`，它不是自动发现或新的配置合同。Rabi Manager 地址遵循 [消息查询说明](message-query.md) 的 Host/READY 与 `/meta` 身份核验。

## 网络与认证

- 反向 WebSocket 将事件送往当前网关配置的完整 URL；按双方当前合同核对消息格式、认证及监听范围。
- 不建议留空 token 或关闭网关验证。使用既有受保护凭据，不把 token 打进命令行日志或文档；缺少必要凭据时停止并完成授权配置。
- `ws://` 是明文传输，并不等于安全。仅在已有受信本机配置允许时使用；远端按现行部署合同使用受信 TLS 端点，不关闭证书验证。
- HTTP Server 限制在既有授权的监听地址和范围。新增远程访问需单独授权，不因示例而开放公网。
- 建立 TCP/WebSocket 连接只证明传输建立；还要从 `get_status` 和 `get_login_info` 核对在线状态、账号与目标。

## OneBot 事件要点

群聊和私聊事件含 `post_type=message`、`message_type=group|private`、`user_id`、`message_id`、消息内容；群聊另含 `group_id`。按现行 schema 解析，不把不同账号空间的 ID 混用。网关只按正式保留政策记录必要字段，不为诊断全量保存私人聊天。

## 请求编码示例

以下仅展示已授权独立连接的 UTF-8 编码，不授权执行发送。运行前必须确认 `ONEBOT_BASE_URL` 是当前受信端点，`ONEBOT_ACCESS_TOKEN` 由现有安全入口提供，`QQ_USER_ID` 是已授权真实目标。不要打印凭据，不跟随重定向。

```powershell
$base = $env:ONEBOT_BASE_URL.TrimEnd('/')
$json = @{ user_id = [long]$env:QQ_USER_ID; message = "你好" } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri "$base/send_private_msg" -Method Post `
  -Headers @{ Authorization = "Bearer $env:ONEBOT_ACCESS_TOKEN" } `
  -ContentType "application/json; charset=utf-8" -Body $bytes `
  -TimeoutSec 10 -MaximumRedirection 0
```

群聊使用 `send_group_msg` 和 `group_id`，目标来自当前授权，不使用占位编号。Node `fetch` 默认按 UTF-8 编码 JSON 字符串：

```js
const response = await fetch(new URL('/send_private_msg', process.env.ONEBOT_BASE_URL), {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(10_000),
  headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ONEBOT_ACCESS_TOKEN}` },
  body: JSON.stringify({ user_id: Number(process.env.QQ_USER_ID), message: '你好' })
});
// 按当前 OneBot 合同核对 HTTP、status/retcode 及 message_id；HTTP 200 不是完整成功证明。
```

发送超时、5xx、断连或无法解析回执时保留原请求身份并先权威核查。不因字符乱码、没有立即看到消息或示例异常而自动重发。平台接受、Rabi 正式记录和业务完成是不同结果。

## 排障顺序

1. 从当前受管状态核对运行版本、监听地址及账号。WebUI 不可达不直接重启 Rabi 或 NapCat。
2. 认证失败时检查受保护凭据的配置状态；不把 token 搜索结果回显到聊天，不关闭认证。
3. 有事件但网关无记录时，核对当前反向 WebSocket 地址、格式、订阅范围和受管诊断。
4. 能收不能发时，只读检查 HTTP 服务与认证合同；只读 `get_status` 不是测试发送。
5. 中文乱码时检查 UTF-8 请求体、响应和平台记录，先确定原消息结果再决定是否需要经授权更正。
6. 群过滤使用当前网关实际支持的配置，不猜环境变量，不默认所有群都在任务范围。

## 安全与历史覆盖

不读取或保存 QQ 密码，优先专用账号。不逆向内存密钥或绕过 QQNT 数据库加密。历史来源限当前授权账号实际同步的内容或用户明确导出的记录；报告时间与覆盖范围，不能把空结果说成群里没有消息。
