<!-- docs-language-switch -->
<div align="center"><a href="./remote-computer-client_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 主机与远端电脑客户端

远端实例只保留一个默认开启的“是否启用Agent”开关。启用后，主机全部公开接口复用电脑接入凭据，不再要求浏览器登录、Agent／会话登记或逐功能授权。每次 Agent 调用显式传入实际类型与完整会话 Id。

主机电脑上的 Rabi 服务统一保存角色、计划、记忆、Skill、消息记录和调度流程，承担常驻管理职责，不需要另设主控 Agent。每台远端电脑运行 Rabi Agent 客户端，提供该平台支持的电脑操作能力。普通已鉴权 Agent 均可查询计划、记忆和 Skill，也可按接口合同调用电脑能力；是否为主角色不构成额外许可。

```mermaid
flowchart LR
  A[主机 Rabi 服务：数据、记忆、Skill、流程] --> C[公开接口]
  B[普通已鉴权 Agent] --> C
  C <--> D[远端客户端：唯一主程序]
  D --> E[平台终端：CMD / PowerShell / Zsh / Bash]
  D --> F[文件、窗口与截图]
  D --> G[可选关联 Codex / DSH]
```

客户端不运行另一套 Manager，也不建立角色、记忆或 Skill 数据副本。客户端自身保留连接配置、执行程序设置、任务回执和有界传输状态；远端文件仍属于远端电脑的文件系统。关联 Agent 的任务执行沿用原任务 owner，不启动备用 Agent Runtime。客户端、主控和网络连接必须在线。

## 接入与使用

按[远端客户端接入步骤](lan-rabi-agent-bootstrap.md)安装，每台电脑保持一个主程序。连接器、托盘、终端宿主和截图辅助程序均为其子程序。关联 Agent 可以稍后启动；私有配置 `agents: []` 也能建立电脑连接。

接入页面先选择 Windows、Mac（macOS）或 Linux，仅安装电脑客户端；安装关联智能体的勾选已移除。首次不提供 `RABI_AGENT_TYPE` 或会话变量时，`--bootstrap` 保存空 Agent 列表。以后调用无需登记 Agent；每次投递明确指定类型和完整会话 ID。

Mac 使用当前用户 LaunchAgent，支持文件互传与连接器 0.2.4 的 Zsh/Bash/sh 终端。终端依赖 node-pty；Mac 原生编译可能需要 Xcode Command Line Tools。窗口查询和截图仍仅支持 Windows。Mac 原生终端与 Desktop IPC 仍待在线真机验收。

主机 WebGUI 的 **RabiLink → 远端智能体 → 在线电脑 → 远端终端** 提供该电脑实际支持的 Shell 的新增、查询、切换、输入和退出。文件与画面通过下列公开接口供 Agent 使用。沿用已鉴权连接，不增加功能白名单或管理密码；执行使用远端客户端的系统用户权限。

调用前从当前 Host 状态取得完整 `managerBaseUrl`，核对 `/meta` 身份和就绪状态，再读取 `/api/lan-agent/instances`，用名称及 `instanceId` 确认目标。调用合同见 `/api/lan-agent/capabilities` 的 `remote-terminal`、`remote-computer` 分组。

| 接口 | 用途 |
| --- | --- |
| `GET /api/lan-agent/instances/:instanceId/terminals` | 查询真实终端列表 |
| `POST /api/lan-agent/instances/:instanceId/terminals` | `open / list / get / input / resize / close` |
| `GET /api/lan-agent/instances/:instanceId/terminals/:terminalId?after=0&waitMs=25000` | 返回终端状态和输出；没有新输出时等待事件，最长 25 秒 |
| `GET /api/lan-agent/instances/:instanceId/terminals/:terminalId/events?after=0` | 实时 SSE 输出 |
| `POST /api/lan-agent/instances/:instanceId/computer` | 文件互传、窗口查询和截图 |

终端使用稳定 UUID `terminalId`；Windows 的 `shell` 为 `cmd` 或 `powershell`，Mac/Linux 为电脑实际提供的 `zsh`、`bash` 或 `sh`。输入使用递增 `sequence`，命令以 `\r` 结尾。JSON 输出字段为 `terminal`、`outputEvents`、`nextOutputSequence`、`truncated`；下一次以 `nextOutputSequence` 作为 `after`。关闭网页保留终端，退出终端结束所属子程序；连接断开或主程序退出结束终端。超时查询原会话，不自动重建或重发输入。

新终端收到真实 Shell 提示符后才接受输入，启动最多等待 30 秒；桌面辅助操作也有 30 秒期限，主控转发等待最多 45 秒。机器繁忙或刚登录时允许启动过程完成，不以创建了进程代替 Shell 就绪。

Windows 构建通过 `scripts/build-agent-native-assets.mjs` 将托盘、终端和截图的同一份 C# 源码预编译为 `dist/native/<模块>-<源码SHA256>.dll`，签名发布清单包含这些文件。辅助程序按当前源码 hash 加载对应程序集；未匹配时只编译当前签名源码，不使用旧程序集。运行语义、进程归属和退出路径相同；原生缓存不保存业务数据。

## 文件互传

所有操作提交到 `computer`，`path` 使用远端绝对路径。数据按最多 64 KiB 分块传输，每块携带 SHA-256，二进制使用 base64，不经过终端文本。

下载依次调用 `file.stat(path)` 和 `file.read(path,version,offset)`。`file.stat` 返回 `size`、`version`、`chunkBytes`；`file.read` 返回 `data`、`sha256`、`nextOffset`、`eof`。主机解码并校验每块后写文件，使用 `nextOffset` 读取下一块。远端文件变化时拒绝继续旧版本下载。

上传预先保存 UUID `uploadId` 和整文件 SHA-256：

1. `upload.begin(uploadId,path,size,sha256)` 创建同目录临时文件。
2. `upload.write(uploadId,offset,data,sha256)` 顺序传块；相同块回执不重复写入，冲突拒绝。
3. `upload.status(uploadId)` 查询远端已接收的 `offset` 和 `state`。
4. `upload.commit(uploadId)` 校验完整内容并原子提交；不覆盖已存在的目标文件。
5. 放弃时调用 `upload.abort(uploadId)`，释放临时文件。

单次上传默认不另设大小上限，字节数必须为 JavaScript 可精确表示的非负整数。这与主控 `agentUploads.maxFileMiB` 是不同的文件服务。以下设置由用户在**远端 Rabi Agent 启动环境**配置，重启该 Agent 后生效；超限错误给出当前值和调整入口。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `RABI_AGENT_COMPUTER_MAX_UPLOAD_BYTES` | 不另设额度 | 单文件字节数；`0` 仅允许空文件 |
| `RABI_AGENT_COMPUTER_MAX_CONCURRENT_IO` | `4` | 同时处理的电脑 I/O 操作数；`0` 取消额度 |
| `RABI_AGENT_COMPUTER_MAX_ACTIVE_UPLOADS` | `4` | 活动上传数；`0` 取消额度 |
| `RABI_AGENT_COMPUTER_MAX_UPLOAD_RECORDS` | `64` | 当前进程保留的上传记录数；`0` 取消额度 |

所有值须为可精确表示的非负整数。最近 256 块支持回执核验。正常停止清理未提交文件；进程意外终止可能留下 `.rabi-upload-<UUID>.tmp`，新客户端不会自动续传旧记录。结果不确定时先查原 ID，不自动换 ID 或覆盖目标。

## 查询窗口与获取画面

`windows.list` 可传 `query`（标题筛选）及 `limit`（1..200，默认 100），返回 `windows` 和 `truncated`。每个窗口包含 `windowId`、`pid`、`title`、`minimized`、`bounds`。

`screen.capture` 不传窗口时获取当前虚拟桌面；指定窗口时同时传查询得到的 `windowId` 和 `pid`，防止句柄复用。`maxWidth` 为 320..3840，默认 1920。结果包含 `mimeType: "image/png"`、base64 `data`、`width`、`height`、`bounds`、`capturedAt`，主机可直接显示或保存 PNG。

截图需要交互式 Windows 桌面，最多 32 百万原始像素及 8 MiB PNG；最小化、受保护或不支持 `PrintWindow` 的窗口可能失败或返回无效画面。电脑操控也可以通过终端运行系统命令与脚本；文件和图片优先使用上述接口。

## 验证状态

客户端 0.2.2 源码已验证原生 CMD/PowerShell、中文、Ctrl+C、子程序清理、文件分块及整文件校验、窗口查询、桌面和窗口截图。隔离 HTTP/WebSocket 测试使用真实客户端、空 Agent 列表和阻塞的 Agent 队列，主机已鉴权接口仍可调用电脑能力。

另已通过真实首次兑换票据 → 无 Agent 配置加载 → 独立命令行子程序 → 已鉴权 WebSocket 的电脑操作验证，覆盖 CMD 输出、跨 64 KiB 文件块及 PNG 截图。

本机安装验收已通过：从隔离测试主控下载并核验签名发布清单中的 44 个文件，安装客户端 0.2.2 及依赖，以普通 `--run` 启动。空 Agent 列表下，CMD 和 PowerShell 的新增、即时输入、查询、调整尺寸和退出可用；131,077 字节二进制文件经三个数据块上传、下载并完整比对；桌面与指定测试窗口返回有效 PNG。状态回读确认一个主程序及其连接器、托盘子程序；主程序正常退出和异常终止测试均确认所属子程序清理。高负载首次回归出现启动超时，失败项已逐项复测；嵌套 Shell 测试只延长准备期限，退出清理仍限 15 秒。

上述安装与主控在同一台 Windows 电脑的隔离目录运行，测试完成后均已停止。正式主控部署、真实双机与长期运行验收仍待完成。
