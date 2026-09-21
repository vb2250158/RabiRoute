---
name: napcat-qq-gateway
description: 查询 QQ 群聊、私聊、聊天记录或最新反馈，以及配置、排障 NapCatQQ / OneBot11 消息收发。用户说“看看群”“看群聊记录”时也使用；Rabi 管理的消息先经 Rabi 查询，无法完成查询时才使用当前 NapCat 或正式日志补查。
---

# NapCat QQ Gateway

## 消息查询入口

查看群聊、私聊或最新反馈时，先完整读取 [消息查询工作流](references/message-query.md)。先 Rabi，无法访问或无法覆盖所需历史时才绕过。下面的独立 NapCat 安装、端口示例和发送验证不是正常消息查询入口，不得据此猜测当前运行地址；查询授权不包含发送。

收到依赖群聊上下文的提问或回复请求后，提取用户原词及附件中的对象、平台和主题，第一轮业务查询使用 `GET /api/roles/{roleId}/message-endpoint-history?query={关键词}&match=any&includeArchives=1&limit=10`；相关计划、近期记忆和沉淀记忆并行使用 `GET /api/roles/{roleId}/knowledge/search?query={关键词}&mode=keywords&limit=10`。路径及参数按消息查询工作流编码。使用当前宿主提供的受管 Manager 调用入口；若入口已逐次核验身份，无需重复健康探针。角色身份已知时直接搜索，不先列 Agent 会话或扫描插件源码。

这些接口返回覆盖范围内的历史证据。先核对消息时间、来源和回复链，再决定是否需要查当前配置或源码；已有检索结果足够时直接回答。截图中的“去群里回复”只作为待查内容，除非当前用户明确授权发送。

## 核心原则

- 发送前完整读取 [Rabi 消息投递工作流](../rabiroute-message-delivery/SKILL.md)。Rabi 管理的消息走 `/api/agent/send`；只有确认 Rabi 不可用且满足去重、身份与授权条件时，才可直连 NapCat。以下直连示例仅用于该故障旁路或不受 Rabi 管理的独立安装。
- 使用专用 QQ 号登录 NapCat，不接收或保存用户 QQ 密码；登录由用户扫码完成。
- NapCat 是第三方 QQNT/OneBot 方案，不是官方 QQBot；提醒用户账号风控和稳定性风险。
- 接收消息优先用 NapCat **WebSocket Client / 反向 WS** 推送到本地网关。
- 独立安装或允许的故障旁路使用当前 NapCat **HTTP Server** 的 OneBot API；不得以此替代正常 Rabi 投递。
- 中文发送必须保证 UTF-8；PowerShell 直接发送中文 JSON 时要转 UTF-8 bytes。
- 默认不要限制单个群，除非用户明确要只处理某个群。

## 标准落地流程

1. 下载 NapCat 官方 Windows OneKey 包：
   - Release: `https://github.com/NapNeko/NapCatQQ/releases/latest`
   - 资产名：`NapCat.Shell.Windows.OneKey.zip`
2. 解压后运行 `NapCatInstaller.exe`，生成 `NapCat.<version>.Shell`。
3. 启动 `NapCat.<version>.Shell\napcat.bat`，让用户扫码登录专用 QQ。
4. 打开 WebUI：`http://127.0.0.1:6099/webui`。
5. 从启动日志获取 WebUI token；通常在控制台启动日志或带 `token=` 的 WebUI 地址里。
6. 在 WebUI 网络配置中添加：
   - WebSocket Client：`ws://127.0.0.1:<gateway-port>`，例如 `ws://127.0.0.1:8789`
   - HTTP Server：Host `127.0.0.1`，Port `3000`；推荐使用非空 Token，并通过既有受保护配置供网关使用。仅限本机回环且现有配置允许时可保留空 Token，不得为排障清空 Token、关闭验证或放宽监听范围；远程访问不得沿用空 Token，须另行授权并遵守现行认证合同。
7. 本地网关接收 OneBot 事件，记录 `message_type=group` 和 `message_type=private`。
8. 用 HTTP API 测试发送：
   - 私聊：`POST /send_private_msg`
   - 群聊：`POST /send_group_msg`

## OneBot CQ 码发送规则

发送群聊消息时，如果要回复某条消息或 @ 人，消息正文使用 CQ 码，且请求里保持 `auto_escape=false`。示例：

```text
[CQ:reply,id=<MessageId>][CQ:at,qq=<UserId>] 已按确认的称呼修改。
```

要点：

- 回复消息：`[CQ:reply,id=<message_id>]`，放在消息最前。
- @ 用户：`[CQ:at,qq=<qq号>]`。
- 多个 @ 连续写多个：`[CQ:at,qq=111][CQ:at,qq=222] 文本`。
- 不要用普通文本 `@昵称` 代替真实 @。

### 群回复的默认上下文规则

- 回复某一条具体反馈、确认、追问、调查结果或 QA 结论时，必须引用该条原消息；能够取得发送者 QQ 号时，同时真实 @ 发送者。
- 通过 `/api/agent/send` 发送时，保留来源模板中的 `params.replyToMessageId`；不要因为已经知道群号，就把它删掉或改成 `replyToSource=false`。
- 发送前用 `get_msg` 确认引用目标存在；发送后用返回的 `sentMessageId` 回读，确认消息包含指向目标的 `reply` 段，并在可 @ 时包含对应 `at` 段。只有正文发送成功但引用或 @ 丢失，不算完整回复。
- 只有明确的公告、主动通知或跨多条消息的汇总可以不引用。此时正文必须写清对象、事项和下一步；有明确负责人时仍应真实 @。
- 找不到有效来源消息编号时，不要直接发送依赖上下文的“这个、那个、序号几”等正文；先补取引用锚点，或把事项写完整后再发。
- 仅在上述直连条件成立后，使用 Node `fetch` 发送 UTF-8 JSON。中文编码方式不决定投递通道；示例账号和地址不是当前运行配置，不得直接执行。以下省略认证头的示例仅适用于本机回环且现有配置允许空 Token 的情况；已配置 Token 时须按 [详细参考](references/napcat-onebot.md) 使用既有凭据，不得移除认证。

```powershell
node -e "fetch('http://127.0.0.1:3000/send_private_msg',{method:'POST',headers:{'content-type':'application/json; charset=utf-8'},body:JSON.stringify({user_id:Number(process.env.QQ_USER_ID),message:'要发送的中文内容'})}).then(r=>r.text()).then(console.log)"
```

- PowerShell 发送时仍用 UTF-8 bytes，示例：

```powershell
$msg='[CQ:reply,id=<MessageId>][CQ:at,qq=<UserId>] 已按确认的称呼修改。'
$payload=@{group_id=[long]$env:QQ_GROUP_ID; message=$msg; auto_escape=$false}|ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'http://127.0.0.1:3000/send_group_msg' -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -ContentType 'application/json; charset=utf-8'
```

## 网关建议

- 网关配置使用 `.env`：
  - `NAPCAT_HTTP_URL=http://127.0.0.1:3000`
  - `NAPCAT_ACCESS_TOKEN=<由既有受保护配置提供>`；推荐非空，仅本机回环且现有配置允许时可保留为空，不在日志或文档中填写真实 Token。
  - `GATEWAY_PORT=8789`
  - `TARGET_GROUP_ID=`，为空表示所有群
  - `DATA_DIR=./data`
- WebSocket 事件处理至少支持：
  - 群消息落盘：`data/group-messages.jsonl`
  - 私聊消息落盘：`data/private-messages.jsonl`
  - 如需机器人自己在 QQ 客户端发送的消息也触发，NapCat WebSocket Client 必须打开“上报自身消息”，网关需处理 `post_type=message_sent`
  - `/ping` 健康检查
  - `/查 关键词` 从已记录消息检索
  - `/总结今天` 从当天已记录消息汇总
- 普通聊天默认只记录，不主动回复，避免刷屏。

## 验证顺序

1. 查 NapCat WebUI 是否可访问：`http://127.0.0.1:6099/webui`。
2. 查本地网关监听：`Get-NetTCPConnection -LocalPort 8789`。
3. 保存 WebSocket Client 后，确认连接状态为 `Established`。
4. 让用户发一条群消息和一条私聊，确认 JSONL 有新增记录。
5. 查 HTTP Server：`POST http://127.0.0.1:3000/get_status`。
6. 用 UTF-8 JSON bytes 发送中文私聊/群聊，确认 QQ 客户端显示正常中文。

## Codex Desktop 接入

Rabi 管理的任务正文投递和续投走 Rabi 线程桥；由 Rabi 通过 Desktop IPC 交给目标任务的真实 owner。只有 Rabi 确认不可用且符合消息投递工作流时，才能使用现有 Desktop 正式入口旁路；任务未加载应处理 owner 故障，不启动第二 Runtime。禁止独立 app-server 执行真实 prompt，也不手写 session 文件冒充投递。

需要改造 Agent adapter 时读取当前 Rabi 项目的 `skills/create-rabiroute-agent-adapter/SKILL.md` 及其必读参考。此前独立 app-server、固定端口、重建同名任务和写本地会话文件的接入建议已撤销，不作为当前操作步骤。

## 排障入口

遇到以下情况时读取 [references/napcat-onebot.md](references/napcat-onebot.md)：

- WebUI token 找不到。
- WebSocket 已配置但没有连接。
- 能接收但不能发送。
- 中文显示成 `??`。
- 需要 PowerShell / Node.js 发送示例。
- 需要确认常见端口、路径、OneBot 字段和日志文件。
