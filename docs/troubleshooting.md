# 排障

## QQ 合并转发只显示转发 ID 或 `[object Object]`

新版 RabiRoute 收到 NapCat 的 `forward` 消息段或 `[CQ:forward,...]` 后，会使用当前 NapCat 实例的 OneBot HTTP Server 调用 `get_forward_msg`。查询成功后：

- 外层原始消息保存在 `originalRawMessage`。
- 展开的聊天内容写入 `rawMessage`，因此历史搜索、最近消息和 AgentPacket 都能直接看到。
- 结构化节点写入 `forwardedMessages`，包含转发 ID、发送者、时间、消息 ID和规范化文本/媒体标记。
- 图片、视频、语音和文件会保留类型、文件名、摘要或 URL；能否进一步下载仍取决于 NapCat 返回字段和 URL 有效期。

查询失败时，外层消息仍会正常落盘，并在 `napcat-adapter.log.jsonl` 写入 `forward_message_resolve_error`。排查顺序：

1. 确认当前路由的 NapCat HTTP Server 在线且端口正确。
2. 确认 OneBot `get_forward_msg` 对该转发 ID 返回成功。
3. 检查转发记录是否已过期，或是否来自当前 QQ 无权读取的会话。
4. 查看 `forward_message_resolved` 日志中的转发 ID和节点数量。

## NapCat 已连接，但处理端没有收到消息

先看 `data/route/<配置名>/`：

- 有 `group-messages.jsonl` 或 `private-messages.jsonl`：说明 QQ 到 RabiRoute 已通。
- 有 `codex-notifications.jsonl`：说明路由规则已命中并尝试投递。
- 没有投递记录：检查角色 `personaConfig.json` 是否存在对应 `configName` 的有效 `notificationRules`，再检查 `routeKinds`、`regex` 和目标群过滤。

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
4. RabiRoute 侧看 `data/route/<配置名>/gateway-status.json`、`group-messages.jsonl` 和 `codex-notifications.jsonl`，区分“能收不能发”和“路由没有命中”。

如果目标是无值守登录，不要把 QQ 密码写进 RabiRoute 配置。用 NapCat WebUI 和 NapCat Shell 支持的 Windows 环境变量配置，详见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

推荐把这条作为外发恢复链路的演示：心跳或健康检查发现外发失败后，不直接丢消息，而是把待发内容先作为草稿/待审 action 缓存；修复登录态后再补发，并把 NapCat 返回的 `message_id` 写入执行记录。当前版本已把 OneBot `retcode` 非 0 视为失败；完整 Action Queue / 补发队列仍属于后续演进。

## 中文消息乱码或多行发送异常

在 Windows 上，如果用 PowerShell `Invoke-WebRequest` 直接发送中文 JSON 到 OneBot HTTP，实际请求编码可能没有稳定按 UTF-8 发送，表现为 QQ 收到乱码，或多行消息内容异常。

推荐做法：

1. 用项目内 Node 脚本发送 OneBot HTTP 请求。
2. 脚本会显式设置 `Content-Type: application/json; charset=utf-8`。
3. 脚本会用 `JSON.stringify` 生成正文，不手工拼接中文 JSON 字符串。

示例：

```powershell
npm run send:onebot -- --group YOUR_GROUP_ID --message "中文测试\n第二行"
```

如果 `data/route` 或 `data/roles` 下的 JSON reload 失败，或 WebUI 保存后配置异常，也检查是否误写入了字面量 `\n`：

```powershell
npm run check:config
```

- JSON 文件末尾不应该多出可见的 `\n` 字符。
- 如果文件带 UTF-8 BOM，部分工具可能解析失败；`npm run check:config` 会提示并按去 BOM 后的内容检查。
- WebUI 文本框里的模板应使用真实换行，不要输入字面量 `\n`。
- 保存成 JSON 时，只允许由编辑器或序列化器按 JSON 格式转义一次。

## `Missing monitorThreadId`

说明 RabiRoute 没找到对应 Codex Desktop 线程。先打开或创建用于处理 QQ 消息的 Codex 线程，再检查 WebUI 里的 Agent 状态；Manager 会按配置的线程名从 Codex session index 自动发现线程。

## `no-client-found`

说明 RabiRoute 已经从 Codex session index 找到目标线程，但 Codex Desktop 当前没有加载这个线程，Desktop IPC 无法对它 `start/steer`。当前投递会先尝试启动/聚焦 Windows Codex App，再通过 app-server `thread/resume` 唤醒目标线程，然后立即重试 Desktop IPC 投递；如果仍失败，默认改走 app-server `turn/start` 兜底投递，同时暂存在 RabiRoute 进程内，并按 `CODEX_DESKTOP_IPC_RETRY_DELAY_MS` 定时重试。默认保留最近 20 条，可用 `CODEX_DESKTOP_IPC_MAX_RETRY_MESSAGES` 调整。线程重新加载后，下一次重试会自动补投。

健康巡检会把这类状态标成错误，并显示待补投数量、下一次重试时间和 `lastCodexAppVisibility*` 可见性诊断。自动唤醒可用 `CODEX_DESKTOP_IPC_WAKE_ON_NO_CLIENT=0` 关闭；no-client app-server 兜底可用 `CODEX_DESKTOP_IPC_FALLBACK_ON_NO_CLIENT=0` 关闭。Codex App 可见性保障默认启用，可用 `CODEX_APP_VISIBILITY_NOTIFY=0` 关闭；如 WindowsApps 路径不可读，可用 `CODEX_APP_EXE_PATH` 指向 `C:\Program Files\WindowsApps\OpenAI.Codex_*\app\Codex.exe`。Windows 可能拒绝后台进程抢前台，这种情况下仍可以在 Codex Desktop 手动打开目标线程，让 Desktop IPC 客户端重新注册。

RabiRoute 进程本身不能直接调用 `codex_app.send_message_to_thread` 这类 Codex 连接器工具；这些工具属于当前 Codex 会话环境，不是 RabiRoute Node 运行时的稳定 API。这里使用的是 Codex app-server 的 `turn/start` 方法，不依赖目标线程已经有已加载的 Desktop 前端客户端。

## Agent 回合里没有 `codex_app__*` 线程工具

先确认当前投递状态。如果 `agentStates.codex.lastDeliveryChannel=app-server-fallback` 且 `lastDeliveryVisibility=desktop-client-not-loaded`，说明该回合由 app-server 启动，没有经过 Desktop 宿主的连接器能力注入。此时反复修改提示词或搜索 `ALL_TOOLS` 不会让工具出现。

后台 Agent 应调用本机线程桥：

```http
POST http://127.0.0.1:8790/api/agent/threads
```

支持 `list`、`read`、`create`、`send`。详细请求见 `docs/rabi-agent-interfaces.md`。该接口只允许使用当前 Route 已配置的 Codex 工作区；不要用 multi-agent 子 Agent 冒充正式线程，也不要继续把已就绪事项永久标成 `pending_thread_tool`。

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
