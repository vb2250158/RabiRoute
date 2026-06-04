# 排障

## NapCat 已连接，但处理端没有收到消息

先看 `data/<gateway-id>/`：

- 有 `group-messages.jsonl` 或 `private-messages.jsonl`：说明 QQ 到 RabiRoute 已通。
- 有 `codex-notifications.jsonl`：说明路由规则已命中并尝试投递。
- 没有投递记录：检查 `notificationRules`、`routeKinds`、`regex` 和目标群过滤。

## `send_group_msg` 报 `EventChecker Failed` / `1006514`

不要只看 `get_status` 返回 `online` 或 `good`。这类情况下 OneBot HTTP 可能仍能响应，但 QQ 内核在 `sendMsg` 阶段已经外发失败，常见表现是 NapCat 日志里出现：

```text
EventChecker Failed
retcode=1006514
网络连接异常
```

排查顺序：

1. 查 NapCat/QQ 日志里的 quick login 和二维码登录状态；如果 quick login 失败，通常需要重新扫码登录。
2. 如果 NapCat 启动日志提示本地时间和 ServerTime 有偏差，先同步 Windows 系统时间，再重启 NapCat/QQ。
3. 重启 NapCat/QQ 后重新扫码登录，再测 OneBot HTTP、RabiRoute WebSocket 和 `send_group_msg`。
4. RabiRoute 侧看 `data/<gateway-id>/gateway-status.json`、`group-messages.jsonl` 和 `codex-notifications.jsonl`，区分“能收不能发”和“路由没有命中”。

推荐把这条作为外发恢复链路的演示：心跳或健康检查发现外发失败后，不直接丢消息，而是把待发内容先作为草稿/待审 action 缓存；修复登录态后再补发，并把 NapCat 返回的 `message_id` 写入执行记录。当前版本已把 OneBot `retcode` 非 0 视为失败；完整 Action Queue / 补发队列仍属于后续演进。

## 中文消息乱码或多行发送异常

在 Windows 上，如果用 PowerShell `Invoke-WebRequest` 直接发送中文 JSON 到 OneBot HTTP，实际请求编码可能没有稳定按 UTF-8 发送，表现为 QQ 收到乱码，或多行消息内容异常。

推荐做法：

1. 用项目内 Node 脚本发送 OneBot HTTP 请求。
2. 脚本会显式设置 `Content-Type: application/json; charset=utf-8`。
3. 脚本会用 `JSON.stringify` 生成正文，不手工拼接中文 JSON 字符串。

示例：

```powershell
npm run send:onebot -- --group 123456 --message "中文测试\n第二行"
```

如果 `data/gateways.json` reload 失败，或 WebUI 保存后配置异常，也检查是否误写入了字面量 `\n`：

```powershell
npm run check:config
```

- JSON 文件末尾不应该多出可见的 `\n` 字符。
- 如果文件带 UTF-8 BOM，部分工具可能解析失败；`npm run check:config` 会提示并按去 BOM 后的内容检查。
- WebUI 文本框里的模板应使用真实换行，不要输入字面量 `\n`。
- 保存成 JSON 时，只允许由编辑器或序列化器按 JSON 格式转义一次。

## `Missing monitorThreadId`

说明 RabiRoute 没找到对应 Codex Desktop 线程。先打开或创建用于处理 QQ 消息的 Codex 线程，再通过 WebUI 绑定；也可以检查 `data/<gateway-id>/codex-state.json`。

## macOS 上 `connect ENOENT /tmp/codex-ipc/...`

Codex Desktop 的 socket 可能不在 `/tmp`。当前版本会依次尝试 `CODEX_DESKTOP_IPC_PATH`、`os.tmpdir()/codex-ipc/ipc-<uid>.sock` 和 `/tmp/codex-ipc/ipc-<uid>.sock`。仍失败时可临时指定：

```bash
export CODEX_DESKTOP_IPC_PATH="/var/folders/.../T/codex-ipc/ipc-501.sock"
npm run start:manager
```

## 普通群消息没有转发

普通群消息默认不会无条件转发。需要添加 `group_message` 规则，并填写合适的 `regex`，例如：

```text
需求|报错|构建失败|提醒|记一下
```
