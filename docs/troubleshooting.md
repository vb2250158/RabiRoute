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
- 有 `agent-packets.jsonl`：说明路由规则已命中并构造了 AgentPacket。
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
4. RabiRoute 侧看 `data/route/<配置名>/gateway-status.json`、`group-messages.jsonl` 和 `agent-packets.jsonl`，区分“能收不能发”和“路由没有命中”。

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

## Codex 没有收到投递

当前正式链路是 RabiRoute 启动 `codex app-server` 子进程，并通过 stdio JSONL 投递。ChatGPT desktop 是否打开、是否显示目标线程都不影响这条链路。按下面顺序检查：

1. 在 RabiRoute 根目录运行 `node node_modules/@openai/codex/bin/codex.js --version`，确认项目锁定的 runtime 已安装；全局 PATH 上的另一个 `codex` 不参与运行。
2. 运行 `node node_modules/@openai/codex/bin/codex.js login status` 检查同一 runtime 的登录状态。不要把 `~/.codex/auth.json`、ChatGPT Cookie 或 token 复制进 RabiRoute 配置。
3. 检查 route 的 `codexCwd` 是否存在且可访问，`codexThreadName` 是否为预期固定线程名。同名线程还必须匹配工作目录，避免消息进入另一个项目的旧线程。
4. 查看当前 route 数据目录下的 `codex-app-server.stderr.log` 和 runtime stderr。正常启动会完成 `initialize` / `initialized`；stdout 只用于 JSONL 协议，不能混入普通日志。
5. 检查 `agent-packets.jsonl`、`codex-app-server.stderr.log` 和 `gateway-status.json`，区分“路由未命中”“app-server 未启动”“线程绑定失败”和“turn 投递失败”。

不要通过启动桌面窗口、寻找 IPC socket 或配置 WebSocket URL 来修复 stdio 连接；这些都不在正式 transport 中。

## `Missing monitorThreadId` / 找不到固定线程

这表示当前绑定不存在、已经失效，或同名线程的工作目录与 `codexCwd` 不匹配。Codex adapter 会通过 app-server 读取线程，无法安全复用时在配置的工作目录创建新线程。检查：

- `codexThreadName` 和 `codexCwd` 是否都正确；线程身份不能只看名字。
- `codexCwd` 是否使用了已移动、大小写或符号链接含义不同的路径。
- 旧 `gateway-status.json` 中的 thread id 只是一份运行状态，不是配置真源；重启对应 gateway 后应由 app-server 重新验证。

## Agent 回合里没有 `codex_app__*` 线程工具

后台 Agent 是否注入桌面连接器工具，与共享 Runtime 的投递健康是两件事。当前回合没有 `codex_app__*` 时，反复修改提示词或搜索 `ALL_TOOLS` 不会让工具出现。

后台 Agent 应调用本机线程桥：

```http
POST http://127.0.0.1:8790/api/agent/threads
```

支持 `list`、`read`、`create`、`send`。详细请求见 `docs/rabi-agent-interfaces.md`。该接口通过桌面端与 CLI 共用的共享 Runtime 工作，只允许使用当前 Route 已配置的 Codex 工作区；不要用 multi-agent 子 Agent 冒充正式线程。

不要为了消除报错在 ChatGPT desktop 里反复创建同名线程，这会增加歧义。

## 升级后 UI 仍显示旧投递错误

这通常说明后台仍在运行升级前的 Manager 或 gateway，而不是当前源码仍依赖旧链路：

1. 重新构建并重启 manager 与对应 gateway，确认没有旧 Node 进程仍在运行旧产物。
2. 区分历史 JSONL / stderr 记录和本次启动的新记录；旧日志可以保留用于审计，不要把它当成本次状态。
3. 以本次启动生成的 app-server stderr 和 Agent 状态为准；当前 transport 不读取桌面 socket 或独立 WebSocket 地址。

如果全新启动仍产生这些错误，说明实际运行的仍是旧构建，应先核对启动目录和 `dist/` 生成时间，而不是继续修桌面应用。

## Codex 模型不可用

- `agentModel` 留空时，RabiRoute 通过 `model/list` 读取当前 runtime 标记的默认模型，并把该值用于线程恢复和 turn 投递。这是推荐配置。
- 只有确实需要锁定模型时才填写 `agentModel`；模型列表会随 runtime 更新，不要照抄旧的 `*-codex` 模型名。
- 显式模型被拒绝时，先用当前 Codex runtime 的模型能力确认名称，再更新 route 配置；不要在代码里增加另一个兜底模型常量。

## Codex 审批请求被拒绝或 turn 停止

默认沙箱是 `workspaceWrite`。command、file、network、permission 或 MCP 等 app-server server request 必须获得明确允许；RabiRoute 无法识别请求、审批超时、连接中断或策略没有结论时都会 fail closed。

这不是 ChatGPT desktop 的弹窗故障，也不能靠打开桌面宿主绕过。先确认任务是否确实需要超出工作区写入或联网，再通过明确、可审计的策略授权。Codex runtime approval 只管 Agent 执行权限，不等于允许 RabiRoute 向 QQ、文档、设备或其它外部系统写入；这些动作仍需经过 Outbox / Action Gate。

## 普通群消息没有转发

普通群消息默认不会无条件转发。需要添加 `group_message` 规则，并填写合适的 `regex`，例如：

```text
需求|报错|构建失败|提醒|记一下
```
