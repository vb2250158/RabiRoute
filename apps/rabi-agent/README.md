<!-- docs-language-switch -->
<div align="center">
简体中文 | <a href="./README_en.md">English</a>
</div>
<!-- /docs-language-switch -->

# Rabi Agent

Rabi Agent 是一个没有界面的局域网工作进程，不是完整 RabiRoute 客户端。它主动连接 Rabi Manager，领取任务，并投给接入时指定的远端任务：Codex Desktop 使用 IPC，DSH 使用本机 `session.prompt`。

> 状态：experimental（实验集成）。接入、授权及上传后群文件发送已通过本机测试、完整构建和 `0.3.4-4b5d30118b40` 部署健康核验。上传集成使用真实 HTTP 与模拟 NapCat，真实双机群文件尚未验收。本轮发现指引与内容摘要更新修复须另核最终运行版本；Windows ZIP 整包尚未验收。

## 首次接入

1. 在总控 WebGUI 的 **远端 Agent** 页面复制接入提示词，粘贴到目标电脑的私密 Codex/DSH 任务中。需要 Node.js 22.13+ 和已启动的目标宿主。
2. 提示词使用默认 30 分钟有效的一次性票据下载已签名程序，并由 `--bootstrap` 兑换独立 `nodeCredential`。凭据存入当前用户私有配置；Manager 只保存密钥 hash 与授权，登录启动项不含凭据。票据不是共享 WebGUI Token，成功兑换后不可重用。
3. 确认自身 `/api/lan-agent/self` 的 `nodeId` 与 `connected`。需要消息投递时，在路由的消息适配器选择 **远端Agent(<IP地址>)** 中的准确 Agent 并保存。需要 API 与 skills 时，在总控为该 Agent 打开 **允许使用 Manager API 与 skills**。

授权默认 `false`，由 Manager 持有；勾选后立即 PUT 生效，离线也可关闭。不需要等待远端执行配置保存。它与执行开关、任务、工作目录和模型不同；节点在线不等于获准访问 API。

完整安装步骤、私有目录、凭据迁移与排障见 [远端 Agent 接入与更新](../../docs/lan-rabi-agent-bootstrap.md)。安装使用统一提示词，不手工复制第二套模板：

```bash
node rabi-agent.mjs --bootstrap
```

仅为安装子进程提供 `RABI_MANAGER_URL`、`RABI_AGENT_BOOTSTRAP_TICKET`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS` 和 `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。Codex 使用 `RABI_AGENT_TYPE=codex-desktop`、`RABI_AGENT_CODEX_THREAD_ID`；DSH 使用 `RABI_AGENT_TYPE=dsh`、`RABI_AGENT_DSH_URL`、`RABI_AGENT_DSH_SESSION_ID`。不要把凭据放入命令参数、日志或仓库；票据只用于私密安装。

更新按已签名 `manifestPayload` JSON 的 SHA-256 内容摘要判断，同 semver 内容变化也可更新；使用摘要命名的不可变目录，复用前验证发布身份及逐文件 hash。候选 READY 前不改共享入口，READY 后安装指针型启动器/Hook shim，再原子切换 `current-release`；失败保留旧版。shim 每次按当前指针加载 helper，不再引用旧共享 helper 副本。旧版仅比 semver，首次须复制新接入提示、执行新 bootstrap，保留已有 `nodeCredential`；旧 DSH 已缓存 helper 时还须重新加载插件或宿主，不能把覆盖磁盘当作热更新。

## 从现有任务使用 Manager

远端优先使用 Hook 提供的已安装连接器 `--api` 命令。本机 Host 发现规则只适用于 Manager 电脑，远端缺少 Host 不代表 Manager 离线。能力与资源入口是 `/api/lan-agent/capabilities`、`/api/lan-agent/resources`。目录只广告实际可读文件和 references；四份公共合同及其英文版均可按返回 ID 读取，不能把任意 Markdown 链接当作资源授权。

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

通用语法：`--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`。选择私有配置中的准确 Agent；CLI 自动读取 `nodeCredential`，不接受旧共享凭据。写入先读现行合同，JSON 通过标准输入传入，按要求提供强 ETag 与稳定幂等键。CLI 前后核对 Manager `/meta`；超时、503、`uncertain` 或写后切代先权威读回，不自动重放，412 重新读取并确认原意。

当前操作目录包含受控业务入口及别名，不是全部 Manager API，也不代表全部远端可用。管理员设置、任意 `file` 和宿主控制被拒绝；业务权限、Action Gate、来源身份和原有 loopback-only 限制仍生效。资源只允许公开文档、技能及其同包直接引用的受控文本，不开放任意文件系统。按需读取 Manager 当前发布的最新技能与合同，不复制计划、记忆或消息处理状态为第二份业务真源。

总控授权的启用 PUT 正文为 `{ "enabled": true, "binding": { "provider": "<provider>", "sessionId": "<sessionId>", "managedSessionIds": [] } }`，`managedSessionIds` 可省略；授权明确冻结 UI 当前显示的绑定。关闭只传 `{ "enabled": false }`。PUT 必须携带稳定 `Idempotency-Key` 和从 GET instances 取得的强 `If-Match`。授权回执持久保留 24 小时；同键同正文返回原回执，不重写授权，异正文返回 409。超时先 GET instances 核对当前授权，不自动重试；回执过期后重新读取并确认意图，再用新键与新 ETag。节点不能给自己授权。

跨 Agent 投递时，远端主会话来源按实例命名空间记录。目前只支持 `responsePolicy: "none"` 的单向投递；因缺少可信回传路由，`responsePolicy: "required"`、`inReplyToRequestId` 正式回复及远端到远端投递均明确拒绝，不能视为完整支持正式回复。远端上下文只走自身专用 `context` 入口，不开放通用 `codex-hook` 接口。

远端渠道外发仍遵守 Route 发送权限：`onlyPrimary` 要求可信 `provider`、Route 的 `instanceId`/`nodeId` 与 `agentId`、已批准的会话及 `primary_persona` 身份全部匹配；仅裸会话 ID 同名不会继承本机权限。

## 上传远端文件，再发送到 QQ 群

> 实验合同：上传已通过本机真实 HTTP 与模拟 NapCat 集成、完整构建及部署健康核验；未向真实群发送测试文件，真实双机群文件仍待验收。

前提是独立节点凭据、总控批准的 primary Agent，以及允许发送 `file` 的准确 NapCat Route。上传和发送是两步，上传成功不会自动发群文件。在已校验的发布目录运行：

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` 必须是预先保存的稳定 UUID，不自动生成。第三条命令从标准输入接收如下 JSON；将身份与目标换成当前模板的准确值，`fileId` 换成上传回执 `data.id`，并为发送保存独立、稳定的 `deliveryId`：

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<approved-complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "<upload-data.id>", "fileSha256": "<upload-data.sha256>" }
}
```

上传使用 `PUT /api/agent/uploads/<UUID>` 和原始二进制正文；`Idempotency-Key` 同 UUID，文件名为 URI 编码的 basename，内容附 SHA-256。`GET` 同路径返回 `{code:0,data:{id,fileName,size,sha256,expiresAt}}`，`expiresAt` 为 ISO 时间，不暴露 Manager `path`。默认单文件 2 GiB（2048 MiB，硬上限）、总量 4 GiB、最多 100 个、TTL 24 小时；HTTP 上传跨 owner 总并发上限为 4。超时、503、切代或结果不确定时先核对当前 Manager，再 GET 原 ID；保留原键和文件，不自动重试或换 ID。

大文件上传使用有背压的流式传输和增量 SHA-256，期限 30 分钟。Manager 的「RabiLink → 配置」可保存 `agentUploads.maxFileMiB`（整数 `1..2048`，默认 `2048`），写入 `data/Config.json`，重启 Manager 后生效；该设置也受原本机管理员 `PATCH /api/rabi/identity` 权限保护，远端 Agent 不能提高限额。客户端硬上限为 2 GiB，服务器配置更小时会拒绝超限文件。

734 MiB（769654784 字节）文件已通过真实客户端 → loopback Manager → 受管存储 → 模拟 NapCat 的 size/SHA-256 集成测试，使用小块生成与读取并禁止大于 8 MiB 的 Buffer 分配/拼接。用 `RABI_TEST_LARGE_UPLOAD=1` 显式运行大文件用例；默认跳过且测试结束清理临时文件。真实 QQ 平台的大小/群权限限制尚未验收。已有旧连接器必须先按上文新版 bootstrap 迁移，缓存旧 Hook 的宿主重载后再试；服务端改限额不等于远端代码已升级。

使用 `fileId` 必须同时填写 `fileSha256=上传 data.sha256`（64 位小写十六进制），避免 24 小时到期后 UUID 复用使旧引用换成其它内容；发送 callback 在 lease 内核对实际 hash，不匹配拒发。

文件归属 `nodeId + agentId`，同 Agent 多 session 可共享，但仍须可信、已批准的 source。`fileId` 仅限 NapCat 群文件，与 `path`/`url`/`fileName` 互斥；不能用于图片、语音或其它渠道。显示名取上传元数据；`payload.text` 可选，`replyToMessageId` 须为空字符串或具体来源消息 ID。Manager 每请求通过内部可信 resolver 校验授权、归属、完整性和 TTL，并以 inflight lease 保护在途文件；不扩大 `allowedFileRoots`，原本地 path 流程照旧。`onlyPrimary` 仍核精确 Route 的远端绑定与获批会话。

必须取得 Manager 和渠道发送回执；caption 失败但群文件已上传时保留 `status=sent`，只补文本，不重发文件。异机 NapCat 仍需要能够读取 Manager 文件路径的共享目录，不代表支持任意跨机 NapCat。完整请求头、安全与回读合同见 [Agent 接口](../../docs/rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)。上文正式回复 `none` 限制不变。

## 旧安装与运行边界

- 旧配置缺少 `nodeCredential` 时必须以新票据重新接入，不能迁移 `lanLinkToken` 为节点凭据；保留原实例、Agent、任务与允许的工作目录。已有独立凭据的重连不重复兑换。
- 新源码在 HTTP/WS 监听前检测旧 `lan-agent-tasks.json`：没有完成标记时，即使注册表为空也轮换 WebGUI Token，成功后写标记，失败中止启动。旧远程浏览器链接失效后须在本机取得新链接。检测范围外曾暴露的密钥也须确认撤销或轮换；未轮换的共享密钥仍可能绕过节点授权。整体部署与 Host 健康不等于旧节点迁移验收，仍须逐节点核对重新接入和旧密钥失效，不能宣称所有现有安装已自动安全迁移。
- 接入时固定发布公钥 SHA-256 指纹，更新时先核对指纹，再验证 Ed25519 签名和每个文件的 SHA-256 与大小。收到更新请求后自行下载、校验和切换；新版本 30 秒内未连接成功时保留旧版本。
- 不包含 Manager、Gateway、WebGUI、配对码、UDP 扫描或设备密码。不启动备用 Runtime；Codex owner 或 DSH 绑定不可用时失败，不互相回退。
- 0.2.0 将电脑作为实例，原单任务配置映射为稳定的 `default` Agent。每个实例可增加多个 Agent；执行配置保存在该电脑，Manager 统一管理。安装发布目录的固定 npm 依赖后，扫描、任务操作与 Hook 安装使用共用管理模块。
- 节点在线、任务已入队或本机夹具通过都不等于真实回复完成。跨机连续投递、登录启动、断网与升级恢复，以及高级计划/记忆工作流仍需实机验收。
