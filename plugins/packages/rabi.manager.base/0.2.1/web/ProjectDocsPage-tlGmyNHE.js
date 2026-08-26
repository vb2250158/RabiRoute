import{m as Z}from"./marked.esm-D2OCE8en.js";import{a as ee,u as ne}from"./vue-router-CdIg99BM.js";import{u as te}from"./index-CsRbdOjO.js";import{l as re,y as D,M as W,N as u,Q as p,v as s,U as i,n as k,P as U,S as N,F as R,R as A,o as E,T as ae,h as O,k as g,L as oe}from"./runtime-core.esm-bundler-DYja7TDp.js";import{_ as se}from"./_plugin-vue_export-helper-DlAUqK2U.js";const ie=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./README_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# RabiRoute 使用手册\r
\r
这套手册面向在 RibiWebGUI 中配置和运行 RabiRoute 的软件使用者。它从第一次打开界面讲起，不要求你先理解代码、Schema 或 Agent 内部实现。\r
\r
> 适用版本：RabiRoute 0.1.x。项目仍在积极开发；界面中的“实验支持”表示已有入口，但外部平台或真机链路仍需按你的环境验收。\r
\r
## 先理解一件事\r
\r
RabiRoute 是消息分诊和调度层。它接收消息、记录事件、判断路由、补齐上下文，再把任务交给 Codex 或其他处理端。真正回答、写代码和调用工具的是处理端。\r
\r
在界面里，一条 **Route（航线）** 就是一套可独立启停的消息流配置：\r
\r
\`\`\`text\r
消息端 -> 匹配规则 -> 人格与上下文 -> Agent 处理端 -> 回复或草稿\r
\`\`\`\r
\r
- **消息端**决定消息从哪里来，例如 NapCat / QQ、Heartbeat、Webhook 或 RabiLink。\r
- **人格与规则**决定哪些消息命中，以及交给 Agent 时附带什么说明。\r
- **Agent 端**决定消息交给哪个处理端、项目目录和任务。\r
- **日志诊断**帮助你判断消息停在了哪一段。\r
\r
## 第一次使用走哪条路\r
\r
如果你只想确认软件能跑通，先用 Heartbeat 加 Codex。它不依赖 QQ 登录，最适合验证第一条投递。\r
\r
1. 打开左下角“快速配置”。\r
2. 消息入口选择“定时触发”。\r
3. Agent 选择 Codex，并绑定项目目录与 Desktop 任务。\r
4. 人格可以先留空，保存配置。\r
5. 到“日志诊断”手动触发一次并确认任务收到消息。\r
\r
完整步骤见[跑通第一条 Route](first-route.md)。需要接 QQ 时，再阅读[Route 与消息端](routes-and-adapters.md)。

实际使用时，先确认顶栏显示“Manager 已连接”，再保存并启动自己的 Route。
\r
## 按目标找文档\r
\r
| 你想完成的事 | 从这里开始 |\r
| --- | --- |\r
| 第一次配置并验证投递 | [跑通第一条 Route](first-route.md) |\r
| 看懂导航、状态和保存提示 | [界面与状态](interface-and-status.md) |\r
| 接 QQ、定时器、Webhook 或 RabiLink | [Route 与消息端](routes-and-adapters.md) |\r
| 从其他设备调用目标 PC 的 TTS / ASR | [从远端调用 TTS 与 ASR](speech-api.md) |\r
| 绑定 Codex 或其他处理端 | [Agent、项目与任务](agents-and-sessions.md) |\r
| 配置人格、命中规则和定时计划 | [人格与消息规则](personas-and-rules.md) |\r
| 消息没到、状态异常或需要复盘 | [运行、日志与排障](operations-and-troubleshooting.md) |\r
| 理解回复权限、草稿和本地数据 | [安全、回传与数据](safety-and-data.md) |\r
| 查常见问题或准备反馈材料 | [常见问题与获得帮助](faq-and-support.md) |\r
\r
## 使用手册与开发文档的区别\r
\r
这套手册只解释“怎么使用”和“怎么判断结果”。页面中只在排障确实需要时提到文件名或技术边界。\r
\r
如果你要扩展适配器、修改路由算法或阅读 API，请从[项目文档索引](../README.md)进入。当前能力边界以[当前能力与成熟度](../current-capabilities.md)为准。\r
\r
## 阅读约定\r
\r
- 路径、任务名、规则名、token 和日志内容保持原文，不会随界面语言自动翻译。\r
- “保存配置”会写入本地配置；某些改动还会同步或重启当前 Route。\r
- “手动触发”会进入真实投递链，不是无副作用预览。\r
- 外发结果可能是 \`sent\`、\`draft\`、\`blocked\` 或 \`failed\`；当前没有通用的外部动作 WebGUI 审批中心。计划页可记录审批建议，但只通知 Agent，不批准外发或自动推进计划。\r
\r
## 下一步\r
\r
继续阅读[跑通第一条 Route](first-route.md)。如果你已经有运行中的 Route，可以直接查看[界面与状态](interface-and-status.md)或[运行、日志与排障](operations-and-troubleshooting.md)。\r
`,de=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./README.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# RabiRoute User Guide\r
\r
This guide is for people who configure and operate RabiRoute through RibiWebGUI. It starts with the first screen and does not expect you to understand the code, schemas, or Agent internals.\r
\r
> Applies to RabiRoute 0.1.x. The project is under active development. “Experimental” means an integration exists, but its external platform or real-device path still needs validation in your environment.\r
\r
## Understand one thing first\r
\r
RabiRoute is a message triage and dispatch layer. It receives messages, records events, chooses a route, adds context, and hands work to Codex or another handler. The handler does the actual answering, coding, and tool use.\r
\r
In the interface, a **Route** is an independently controlled message-flow configuration:\r
\r
\`\`\`text\r
Message adapter -> matching rules -> persona and context -> Agent handler -> reply or draft\r
\`\`\`\r
\r
- A **message adapter** decides where messages enter, such as NapCat / QQ, Heartbeat, Webhook, or RabiLink.\r
- A **persona and its rules** decide which messages match and what instructions accompany them.\r
- An **Agent adapter** decides which handler, project directory, and task receive the message.\r
- **Log diagnostics** show where a message stopped.\r
\r
## The best first-run path\r
\r
To prove that the software works, start with Heartbeat and Codex. This path does not require a QQ login and is the shortest way to validate delivery.\r
\r
1. Open Quick setup from the bottom of the sidebar.\r
2. Select Scheduled trigger as the message source.\r
3. Select Codex and bind a project directory and Desktop task.\r
4. Leave the persona empty for now, then save.\r
5. Open Log diagnostics, trigger one message, and confirm that the task receives it.\r
\r
See [Run your first Route](first-route_en.md) for the full procedure. When you are ready for QQ, continue with [Routes and message adapters](routes-and-adapters_en.md).

In normal use, confirm **Manager connected**, then save and start your own Route.
\r
## Find a guide by goal\r
\r
| What you want to do | Start here |\r
| --- | --- |\r
| Configure and verify the first delivery | [Run your first Route](first-route_en.md) |\r
| Understand navigation, states, and save notices | [Interface and status](interface-and-status_en.md) |\r
| Connect QQ, schedules, webhooks, or RabiLink | [Routes and message adapters](routes-and-adapters_en.md) |\r
| Call TTS / ASR on the target PC from another device | [Call TTS and ASR remotely](speech-api_en.md) |\r
| Bind Codex or another handler | [Agents, projects, and tasks](agents-and-sessions_en.md) |\r
| Configure personas, matching rules, and schedules | [Personas and message rules](personas-and-rules_en.md) |\r
| Diagnose or review missing messages and errors | [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md) |\r
| Understand reply permissions, drafts, and local data | [Safety, replies, and data](safety-and-data_en.md) |\r
| Check common questions or prepare a report | [FAQ and support](faq-and-support_en.md) |\r
\r
## User guide versus developer documentation\r
\r
This guide explains how to use the product and verify outcomes. It mentions files or technical boundaries only when they materially help with troubleshooting.\r
\r
For adapter development, routing internals, or APIs, use the [project documentation index](../README_en.md). The [current capabilities and maturity](../current-capabilities_en.md) page is the source of truth for feature status.\r
\r
## Reading conventions\r
\r
- Paths, task names, rule names, tokens, and logs remain unchanged when the UI language changes.\r
- Save configuration writes local configuration; some changes also synchronize or restart the current Route.\r
- Manual trigger enters the real delivery path. It is not a side-effect-free preview.\r
- Outbound results can be \`sent\`, \`draft\`, \`blocked\`, or \`failed\`. There is no general WebGUI approval center for external actions. The Plans page records approval feedback only; it notifies the Agent without approving outbound delivery or advancing the plan automatically.\r
\r
## Next step\r
\r
Continue with [Run your first Route](first-route_en.md). If you already have a running Route, jump to [Interface and status](interface-and-status_en.md) or [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\r
`,le=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./agents-and-sessions_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Agent、项目与任务\r
\r
消息端决定事件从哪里来，Agent 端决定任务交给谁处理。处理端负责回答、写代码、调用工具和维护自己的任务状态。\r
\r
## 当前处理端\r
\r
| 处理端 | 状态 | 真实边界 |\r
| --- | --- | --- |\r
| Codex | 已验证 | 通过 Desktop IPC 投给所选 Codex/ChatGPT Desktop 任务 |\r
| Copilot CLI | 实验 | 调用本机 CLI，并使用独立会话名和工作目录 |\r
| AstrBot | 实验 | 绑定 Dashboard / ChatUI 项目与会话，需真实环境验收 |\r
| Marvis | 人工接力 | 写 prompt、复制剪贴板并打开应用，不会可靠自动发送 |\r
\r
选择器中的成熟度来自当前扫描结果。安装成功不等于登录成功；登录成功也不等于已绑定正确项目和任务。\r
\r
## 选择主控 Agent\r
\r
一条 Route 可以保留多个不同的 Agent 配置，但命中规则的消息只交给一个主控 Agent。在“Agent 端”列表上方选择主控；其他 Agent 的项目、任务和服务参数会保留，但不会收到默认投递。\r
\r
旧 Route 没有保存主控时，系统使用 Agent 列表中的第一项。删除当前主控后，界面会自动选择仍存在的第一项；如果没有 Agent，消息只保留匹配和消息包记录，不会投递。\r
\r
主控投递失败时会记录失败，不会自动改投其他 Agent。这样可以避免两个处理端同时回复或重复执行外部动作。\r
\r
## Codex 的三个必要条件\r
\r
Codex 主链需要同时满足：\r
\r
1. Codex/ChatGPT Desktop 正在运行。\r
2. Route 保存了正确的项目工作目录。\r
3. Route 绑定了该目录中的准确任务 ID。\r
\r
RabiRoute 不通过隐藏 CLI、共享端口或备用 Runtime 执行真实消息。Desktop 是实际任务 owner，消息会出现在用户可见任务中。\r
\r
## 扫描项目和任务\r
\r
在“消息适配器”的“Agent 端”区域选择 Codex，然后点击扫描或重新扫描。\r
\r
扫描会列出可用项目目录和未归档任务。任务选择器显示名称与最后活动时间，不用内部 ID 让用户辨认。\r
\r
\r
## 选择工作目录\r
\r
工作目录用于：\r
\r
- 校验已保存任务是否属于预期项目。\r
- 区分同名任务。\r
- 决定新任务创建在哪个项目。\r
- 防止消息投到另一个仓库的同名任务。\r
\r
没有候选时输入绝对路径并保存。不要把本机私有用户名或目录写进公开示例、Issue 或截图。\r
\r
## 选择已有任务\r
\r
优先从下拉选择已有任务。选择后，RabiRoute 保存完整任务 ID，并采用任务自己的工作目录。\r
\r
只要 ID 与目录仍有效，下面变化不会自动创建新任务：\r
\r
- Desktop 中修改任务标题。\r
- 本地索引标题暂时滞后。\r
- 任务 goal 已完成。\r
- 后续重新扫描看到更新后的名称。\r
\r
如果固定目标任务已归档，RabiRoute 会在下一次真实投递时创建新任务并自动更新绑定，不会把消息送进归档记录，也不会复用其它同名任务。任务已删除、换账号或移动项目时，重新选择并保存。\r
\r
## 创建新任务\r
\r
在选择器中输入一个不存在的新名称，然后保存配置。RabiRoute 只用项目锁定的 app-server 创建和命名空任务；真实 prompt 仍由 Desktop owner 接收。\r
\r
多个同名同工作目录任务时，RabiRoute 会自动绑定最后活动时间唯一最新者；如果最大时间并列，使用下拉中的最后时间和工作目录确认，或者先在 Desktop 中整理名称。\r
\r
## 自动初始化人格\r
\r
如果界面提供“自动初始化会话”，它会先保存稳定绑定，再通过正式 AgentPacket 链把人格资料交给同一个 Desktop 任务。\r
\r
初始化失败不会创建第二个任务。先检查绑定和 Desktop 状态，再重试。\r
\r
## 模型、工具和审批归谁管\r
\r
目标 Desktop 任务拥有模型、工具、沙箱、文件和网络权限。兼容字段 \`agentModel\` 不覆盖这些设置。\r
\r
Desktop 的命令审批只授权 Agent 执行；它不自动授权向 QQ、文档、设备或外部 API 写入。外部动作仍由 RabiRoute 的 Outbox policy 控制。\r
\r
## 处理端没有收到消息\r
\r
按顺序检查：\r
\r
1. \`agent-packets.jsonl\` 是否有对应投递；没有则先查规则。\r
2. 日志诊断是否显示 Codex Desktop IPC。\r
3. Desktop 是否打开并能进入目标任务。\r
4. 工作目录与任务是否匹配。\r
5. 最后错误是否为 \`no-client-found\`、任务不存在或目录冲突。\r
\r
完整流程见[运行、日志与排障](operations-and-troubleshooting.md)。\r
\r
## 接下来阅读\r
\r
- 配置角色行为：[人格与消息规则](personas-and-rules.md)。\r
- 理解权限和回传：[安全、回传与数据](safety-and-data.md)。\r
`,ce=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./agents-and-sessions.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Agents, projects, and tasks\r
\r
The message adapter decides where an event enters. The Agent adapter decides which handler receives it. The handler owns answers, code, tools, and private task state.\r
\r
## Current handlers\r
\r
| Handler | Status | Actual boundary |\r
| --- | --- | --- |\r
| Codex | Verified | Delivers through Desktop IPC to the selected Codex/ChatGPT Desktop task |\r
| Copilot CLI | Experimental | Invokes the local CLI with its own session name and workspace |\r
| AstrBot | Experimental | Binds a Dashboard/ChatUI project and session; needs environment acceptance |\r
| Marvis | Manual handoff | Writes a prompt, copies it, and opens the app; no reliable automatic send |\r
\r
Maturity in the selector comes from the current scan. Installed does not mean authenticated, and authenticated does not mean bound to the correct task.\r
\r
## Select the Primary Agent\r
\r
A Route may keep configurations for several different Agents, but a matched message is delivered to only one Primary Agent. Choose it above the Agent handler list. Other project, task, and service settings remain saved, but those Agents do not receive default deliveries.\r
\r
For an older Route without a saved primary selection, RabiRoute uses the first Agent in the list. Removing the current Primary Agent selects the first remaining Agent. With no Agent configured, matching and packet records are retained without handler delivery.\r
\r
If Primary Agent delivery fails, RabiRoute records the failure and does not switch to another Agent. This prevents two handlers from replying or performing the same external action.\r
\r
## Three requirements for Codex\r
\r
The Codex path needs all three:\r
\r
1. Codex/ChatGPT Desktop is running.\r
2. The Route stores the correct project workspace.\r
3. The Route binds the exact task ID from that workspace.\r
\r
RabiRoute does not execute real messages through a hidden CLI, shared port, or fallback Runtime. Desktop owns the visible task where the message appears.\r
\r
## Scan projects and tasks\r
\r
Open **Message Adapters**, expand **Agent handler**, select Codex, and run Scan or Rescan.\r
\r
The scan lists available workspaces and unarchived tasks. The selector shows task name and last activity time instead of exposing internal IDs for recognition.\r
\r
\r
## Select the workspace\r
\r
The workspace is used to:\r
\r
- validate that a saved task belongs to the expected project;\r
- distinguish same-named tasks;\r
- choose where a new task is created;\r
- prevent delivery to another repository's task.\r
\r
Enter an absolute path when no candidate appears, then save. Do not publish private usernames or machine paths in examples, issues, or screenshots.\r
\r
## Select an existing task\r
\r
Prefer an existing item from the selector. RabiRoute stores its complete task ID and adopts the task's actual workspace.\r
\r
While the ID and workspace remain valid, these changes do not create a task:\r
\r
- a Desktop title change;\r
- a temporarily stale local index title;\r
- a completed task goal;\r
- a rescan that observes the new title.\r
\r
If the fixed target is archived, the next real delivery creates a new task and automatically persists the replacement binding. The message does not enter archived history and RabiRoute does not reuse another same-name task. If the target was deleted, moved, or belongs to another account, select a valid task and save again.\r
\r
## Create a task\r
\r
Enter a new name in the selector, then save. The project-pinned app-server only creates and names the empty task. Real prompts still go to the Desktop owner.\r
\r
When several tasks share the exact name and workspace, RabiRoute automatically binds the one with the unique latest activity time. If the maximum time is tied or unavailable, use the selector's activity time and workspace to choose, or organize names in Desktop first. This ambiguous case never creates another task.\r
\r
## Automatic persona initialization\r
\r
If **Initialize task automatically** is available, it first saves the stable binding and then sends persona material through the formal AgentPacket path to the same Desktop task.\r
\r
Initialization failure does not create a second task. Repair the binding or Desktop state before retrying.\r
\r
## Models, tools, and approvals\r
\r
The target Desktop task owns its model, tools, sandbox, file access, and network approval. The compatibility \`agentModel\` field does not override them.\r
\r
Desktop command approval authorizes Agent execution only. It does not authorize writes to QQ, documents, devices, or external APIs; RabiRoute Outbox policy still gates those actions.\r
\r
## No handler delivery\r
\r
Check in order:\r
\r
1. Does \`agent-packets.jsonl\` contain the delivery? If not, inspect rules first.\r
2. Does Log Diagnostics report Codex Desktop IPC?\r
3. Is Desktop open and able to enter the task?\r
4. Do the workspace and task match?\r
5. Does the last error mention \`no-client-found\`, missing task, or workspace conflict?\r
\r
See [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md) for the full path.\r
\r
## Continue\r
\r
- Define role behavior: [Personas and message rules](personas-and-rules_en.md).\r
- Understand output and permission gates: [Safety, replies, and data](safety-and-data_en.md).\r
`,he=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./faq-and-support_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 常见问题与获得帮助\r
\r
这一页回答首次使用中最常见的问题，并给出能让维护者快速复现的反馈格式。\r
\r
## 我必须先配置 QQ 吗？\r
\r
不需要。先用“定时触发 + Codex”跑通第一条 Route，再接 NapCat。这样可以把处理端问题和 QQ 登录问题分开。\r
\r
## 为什么 Manager 已连接，消息还是没到？\r
\r
Manager 已连接只表示 WebGUI 能访问控制面。继续检查 Route 是否运行、消息端是否连接、规则是否命中，以及处理端任务是否绑定。\r
\r
## 为什么普通群消息没有转发？\r
\r
普通群消息不会默认全量转发。添加 \`group_message\` 规则，并使用聚焦的 regex。直接 @、回复链和私聊使用各自的 route kind。\r
\r
## 为什么保存后没有立即看到效果？\r
\r
先确认顶栏未保存提示已经消失。某些配置会同步或重载 Route；外部平台配置还需要在 NapCat、WeCom 或 Relay 一侧生效。\r
\r
## 为什么 Codex 任务改名后仍能收到？\r
\r
RabiRoute 使用完整任务 ID 和工作目录作为稳定绑定。标题只是显示信息；改名或 goal 完成不会让有效任务失效。\r
\r
## 为什么模型或工具不是配置里写的那个？\r
\r
Codex Desktop 任务拥有模型、工具、沙箱和审批。RabiRoute 的兼容字段不会覆盖目标任务设置。\r
\r
## \`draft\` 会在哪里等待审批？\r
\r
当前没有通用 WebGUI 审批队列。\`draft\` 是 Outbox 结果和审计数据。需要查看返回内容和日志，再按业务流程明确处理。\r
\r
## 手动触发安全吗？\r
\r
它适合受控验证，但不是无副作用预览。它会写日志、构造 AgentPacket 并开始真实处理端投递。\r
\r
## 可以把整个 \`data/\` 发到 Issue 吗？\r
\r
不可以。里面可能有真实消息、账号、token、任务上下文和私有路径。只提供本次启动后的最小日志，并完成脱敏。\r
\r
## 如何确认当前版本？\r
\r
侧栏品牌区会显示运行版本。也可以查看根目录 \`package.json\`。反馈时同时说明当前源码或安装包的来源。\r
\r
## 提交问题前的最小检查\r
\r
1. 重新构建并重启 Manager 与目标 Route。\r
2. 用最小 Route 复现，避免同时启用多个实验入口。\r
3. 记录本次启动时间和第一条错误。\r
4. 确认消息记录、AgentPacket 和 Outbox 分别是否存在。\r
5. 删除真实身份、token、Cookie、私聊和绝对私有路径。\r
\r
![不含账号、令牌和私聊内容的日志诊断截图示例](../../assets/screenshots/webgui-diagnostics-zh.png)\r
\r
分享前仍要逐项检查自己的截图：如果出现真实 Route 名、账号、任务名、绝对路径或消息正文，请裁掉或遮挡后再提交。\r
\r
## Issue 模板\r
\r
复制下面内容，并替换占位值：\r
\r
\`\`\`markdown\r
### 环境\r
- RabiRoute 版本：\r
- 启动方式：源码 / 安装包 / 托盘\r
- 操作系统：\r
- Node.js 版本：\r
\r
### Route\r
- 消息端：\r
- Agent 端：\r
- 人格：有 / 无\r
- 外部平台版本：\r
\r
### 复现步骤\r
1.\r
2.\r
3.\r
\r
### 预期结果\r
\r
### 实际结果\r
\r
### 证据\r
- 是否有消息记录：\r
- 是否有 AgentPacket：\r
- Outbox 结果：\r
- 本次启动后的最小日志：\r
\r
### 脱敏确认\r
- [ ] 没有账号、群号、token、Cookie、私聊和私有路径\r
\`\`\`\r
\r
## 去哪里获得帮助\r
\r
- 使用问题先搜索本手册和[排障指南](../troubleshooting.md)。\r
- 功能是否已经实现，查看[当前能力与成熟度](../current-capabilities.md)。\r
- 可复现的 Bug 或文档问题，提交到 [GitHub Issues](https://github.com/vb2250158/RabiRoute/issues)。\r
- 需要扩展代码时，从[项目文档索引](../README.md)进入开发者资料。\r
\r
提交安全漏洞时不要公开密钥、账号或可利用细节。先通过仓库提供的私密安全渠道联系维护者；如果没有明确渠道，再发不含敏感细节的询问。\r
`,ue=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./faq-and-support.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# FAQ and support\r
\r
This page answers common first-use questions and provides a report format that maintainers can reproduce quickly.\r
\r
## Must I configure QQ first?\r
\r
No. Run Scheduled trigger plus Codex first, then add NapCat. This separates handler-delivery problems from QQ login problems.\r
\r
## Manager is connected. Why is there no delivery?\r
\r
Manager connectivity only means WebGUI can reach the control plane. Check Route runtime, message connection, rule match, and handler binding separately.\r
\r
## Why are ordinary group messages ignored?\r
\r
Ambient group messages are not forwarded unconditionally. Add a \`group_message\` rule with a focused regex. Mentions, reply chains, and private messages use their own Route kinds.\r
\r
## Why did Save not change the external system?\r
\r
Confirm the unsaved notice disappeared. Some changes synchronize or reload the Route, while NapCat, WeCom, or Relay settings also need to become active on that platform.\r
\r
## Why does a renamed Codex task still receive messages?\r
\r
RabiRoute uses the complete task ID and workspace as a stable binding. The title is display information; a rename or completed goal does not invalidate the task.\r
\r
## Why does the task use a different model or tool set?\r
\r
The Codex Desktop task owns its model, tools, sandbox, and approval. RabiRoute compatibility fields do not override those settings.\r
\r
## Where does a \`draft\` wait for approval?\r
\r
There is no generic WebGUI approval queue today. \`draft\` is an Outbox result and audit payload. Inspect its data and logs, then follow the explicit business process.\r
\r
## Is Manual trigger safe?\r
\r
It is useful for controlled validation, but it is not a side-effect-free preview. It writes logs, builds an AgentPacket, and starts a real handler delivery.\r
\r
## Can I attach the entire \`data/\` directory?\r
\r
No. It can contain real messages, accounts, tokens, task context, and private paths. Provide minimal current-run logs after sanitization.\r
\r
## Where is the current version?\r
\r
The sidebar brand area displays the running version. You can also inspect the root \`package.json\`. Report whether you used source, a package, or the tray launcher.\r
\r
## Minimal checks before reporting\r
\r
1. Rebuild and restart the Manager and target Route.\r
2. Reproduce with one minimal Route instead of several experimental inputs.\r
3. Record the current startup time and first error.\r
4. Check separately for a message record, AgentPacket, and Outbox result.\r
5. Remove identities, tokens, cookies, private chat, and private absolute paths.\r
\r
![An example Log diagnostics screenshot without accounts, tokens, or private messages](../../assets/screenshots/webgui-diagnostics-en.png)\r
\r
Check your own screenshot before sharing it. Crop or cover real Route names, accounts, task names, absolute paths, and message text if they appear.\r
\r
## Issue template\r
\r
Copy and fill in:\r
\r
\`\`\`markdown\r
### Environment\r
- RabiRoute version:\r
- Startup: source / package / tray\r
- Operating system:\r
- Node.js version:\r
\r
### Route\r
- Message adapter:\r
- Agent handler:\r
- Persona: yes / no\r
- External platform version:\r
\r
### Steps to reproduce\r
1.\r
2.\r
3.\r
\r
### Expected result\r
\r
### Actual result\r
\r
### Evidence\r
- Message record present:\r
- AgentPacket present:\r
- Outbox result:\r
- Minimal logs after current startup:\r
\r
### Sanitization\r
- [ ] No accounts, group IDs, tokens, cookies, private chat, or private paths\r
\`\`\`\r
\r
## Get help\r
\r
- Search this guide and the deeper [Troubleshooting guide](../troubleshooting_en.md) first.\r
- Check [Current Capabilities and Maturity](../current-capabilities_en.md) before treating a planned feature as a bug.\r
- Report reproducible bugs or documentation issues in [GitHub Issues](https://github.com/vb2250158/RabiRoute/issues).\r
- For code extension, begin at the [developer documentation index](../README_en.md).\r
\r
Do not publish credentials, account data, or exploitable detail in a security report. Use a private security channel offered by the repository; if none is listed, first ask without disclosing the sensitive details.\r
`,pe=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./first-route_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 跑通第一条 Route\r
\r
这篇教程用“定时触发 + Codex”完成最短闭环。它不依赖 QQ 登录，适合第一次确认 RabiRoute、RibiWebGUI 和处理端能否正常协作。\r
\r
> 完成标准：日志诊断页显示链路没有明显断点，手动触发成功，并且所选 Codex/ChatGPT Desktop 任务收到一条 RabiRoute 消息。\r
\r
## 开始前准备\r
\r
- RabiRoute 已安装并构建，Manager 可以启动。\r
- Codex/ChatGPT Desktop 已打开。\r
- 你知道目标任务所在的项目目录。\r
- 目标任务可以正常进入，不处于已删除或不可访问状态。\r
\r
如果还没有启动 Manager，在项目目录运行：\r
\r
\`\`\`powershell\r
npm run start:manager\r
\`\`\`\r
\r
然后打开 \`http://127.0.0.1:8790/\`。\r
\r
## 第 1 步：打开快速配置\r
\r
点击左下角“快速配置”。如果当前还没有任何 Route，首次打开 RibiWebGUI 时也会自动显示这个向导。\r
\r
在“选择消息入口”中选择“定时触发”。先不要同时接入 QQ、Webhook 或实验适配器；第一轮只验证一条最短链路。\r
\r
![消息适配器页显示当前 Route 的消息入口和 Codex 处理端](../../assets/screenshots/webgui-adapters-zh.png)\r
\r
快速配置完成后，可以在“消息适配器”页复核：定时触发应出现在消息入口列表，主 Agent 应指向 Codex。\r
\r
## 第 2 步：绑定 Codex 任务\r
\r
在“绑定 Agent 处理端”中选择“Codex Agent”。扫描结果应显示“已验证”；这表示项目内主链已实现，不代表 Desktop 可以关闭运行。\r
\r
依次完成：\r
\r
1. 在“项目目录”选择目标任务的工作目录。没有候选时输入绝对路径。\r
2. 在“会话名 + 最后会话时间”选择已有任务。\r
3. 如果需要新任务，输入一个新名称；保存时才会创建空任务并完成绑定。\r
\r
RabiRoute 内部保存完整任务 ID。任务在 Desktop 中改名或完成 goal 后，只要 ID 和工作目录仍有效，就会继续复用，不会因为名称变化重复创建。\r
\r
\r
## 第 3 步：确认人格\r
\r
人格可以先使用已有示例，也可以留空。无人格 Route 会生成基础规则；有明确角色行为需求时，再进入“人格配置”编辑正文和规则。
\r
点击“保存配置”。保存会写入本地 Route 配置，并可能启动或重载当前 Route。\r
\r
## 第 4 步：检查运行状态\r
\r
返回“控制台”，确认：\r
\r
- 顶栏显示 \`Manager 已连接\`。\r
- 当前 Route 处于启用或运行状态。\r
- 当前链路包含“定时触发”和“Codex”。\r
- 顶栏没有“有未保存的修改”。\r
\r
如果 Route 已启用但显示“已停止”，先到“日志诊断”点击“启动”或“重启”。\r
\r
## 第 5 步：手动触发\r
\r
打开“日志诊断”。在“手动触发”中找到 \`heartbeat\` 或 \`manual_trigger\` 规则，然后点击“触发”。\r
\r
手动触发会进入真实投递链，不是预览。它会写运行记录，并向已绑定处理端开始一次真实投递。\r
\r
![日志诊断页从诊断摘要开始显示运行状态和消息端状态](../../assets/screenshots/webgui-diagnostics-zh.png)\r
\r
截图使用了未启动、未绑定真实任务的文档示例，所以图中显示“禁用中”和“未绑定”。你的首次投递完成后，这些位置应显示实际运行状态、已绑定任务和最近成功时间。\r
\r
## 如何判断成功\r
\r
同时满足下面四项，才算第一条 Route 已跑通：\r
\r
1. 诊断摘要没有明显断点。\r
2. 手动触发返回成功。\r
3. Codex 区域显示目标任务和最近成功时间。\r
4. Desktop 中同一个任务出现了 RabiRoute 投递的消息。\r
\r
只看到“配置已保存”不代表投递成功；只看到 Desktop 打开也不代表消息已经进入目标任务。\r
\r
## 第一次失败时看哪里\r
\r
| 现象 | 先检查 |\r
| --- | --- |\r
| 顶栏显示 Manager 未连接 | Manager 进程和 \`127.0.0.1:8790\` |\r
| Route 已启用但未运行 | 日志诊断中的启动按钮和最近日志 |\r
| 没有可触发规则 | 人格页是否有 \`heartbeat\` 或 \`manual_trigger\` 规则 |\r
| Codex 显示未绑定 | 工作目录、任务选择和重新扫描结果 |\r
| 出现 \`no-client-found\` | Desktop 是否已启动并能加载目标任务 |\r
| 触发成功但任务没消息 | 最后投递协议、任务 ID、工作目录和最近日志 |\r
\r
详细判断顺序见[运行、日志与排障](operations-and-troubleshooting.md)。\r
\r
## 下一步\r
\r
- 接入 QQ：阅读 [Route 与消息端](routes-and-adapters.md)。\r
- 让消息进入固定项目任务：阅读 [Agent、项目与任务](agents-and-sessions.md)。\r
- 设置群消息、私聊或定时规则：阅读 [人格与消息规则](personas-and-rules.md)。\r
`,ge=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./first-route.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Run your first Route\r
\r
This tutorial uses Scheduled trigger plus Codex for the shortest complete loop. It does not require QQ and is the safest first check of RabiRoute, RibiWebGUI, and the handler.\r
\r
> Done means Log Diagnostics shows no obvious break, a manual trigger succeeds, and the selected Codex/ChatGPT Desktop task receives a RabiRoute message.\r
\r
## Before you begin\r
\r
- RabiRoute is installed and built, and the Manager can start.\r
- Codex/ChatGPT Desktop is open.\r
- You know the project directory used by the target task.\r
- The target task is accessible and has not been deleted.\r
\r
If the Manager is not running, start it from the repository:\r
\r
\`\`\`powershell\r
npm run start:manager\r
\`\`\`\r
\r
Then open \`http://127.0.0.1:8790/\`.\r
\r
## Step 1: open Quick setup\r
\r
Select **Quick setup** at the bottom of the sidebar. RibiWebGUI also opens this wizard automatically when no Route exists.\r
\r
Under **Select a message source**, choose **Scheduled trigger**. Do not add QQ, Webhook, or experimental adapters yet; the first run should test one short path.\r
\r
![Message Adapters showing the current Route's message inputs and Codex handler](../../assets/screenshots/webgui-adapters-en.png)\r
\r
After Quick setup, use **Message Adapters** to confirm that Scheduled trigger appears in the input list and the primary Agent is Codex.\r
\r
## Step 2: bind a Codex task\r
\r
Under **Bind an Agent handler**, choose **Codex Agent**. Its scan should report **Verified**. This describes the implemented project path; Desktop is still required at runtime.\r
\r
Complete these fields:\r
\r
1. Select the target task's workspace under **Project directory**. Enter an absolute path if no candidate appears.\r
2. Select an existing item under **Task name and last activity**.\r
3. To create a task, enter a new name. Saving creates only the empty task and binding.\r
\r
RabiRoute stores the complete task ID. A Desktop rename or completed goal does not create a duplicate while the ID and workspace remain valid.\r
\r
\r
## Step 3: confirm the persona\r
\r
Use an existing example persona or leave the field empty. A persona-free Route receives basic rules; when you need role-specific behavior, open **Persona Configuration** to edit its document and rules.
\r
Select **Save configuration**. Saving writes local Route configuration and may start or reload the current Route.\r
\r
## Step 4: check runtime status\r
\r
Return to **Console** and confirm:\r
\r
- The top bar says \`Manager connected\`.\r
- The current Route is enabled or running.\r
- The current path includes Scheduled trigger and Codex.\r
- The unsaved-changes notice is gone.\r
\r
If an enabled Route is stopped, open **Log Diagnostics** and select **Start** or **Restart**.\r
\r
## Step 5: trigger one delivery\r
\r
Open **Log Diagnostics**. Under **Manual trigger**, find a \`heartbeat\` or \`manual_trigger\` rule and select **Trigger**.\r
\r
A manual trigger enters the real delivery path. It is not a preview: it writes runtime records and performs a real handler delivery.\r
\r
![Log diagnostics starting with the diagnosis summary, runtime state, and message-input state](../../assets/screenshots/webgui-diagnostics-en.png)\r
\r
The screenshot uses a documentation sample that is stopped and not bound to a real task, so it shows **Disabled** and **Not bound**. After your first delivery, these areas should show the real runtime state, bound task, and most recent success time.\r
\r
## Verify success\r
\r
All four checks should pass:\r
\r
1. Diagnosis Summary shows no obvious break.\r
2. The manual trigger reports success.\r
3. The Codex area shows the target task and a recent success time.\r
4. The same Desktop task contains the routed message.\r
\r
\`Configuration saved\` alone does not prove delivery. Opening Desktop alone does not prove that the message reached the selected task.\r
\r
## First-failure checklist\r
\r
| Symptom | Check first |\r
| --- | --- |\r
| Manager disconnected | The Manager process and \`127.0.0.1:8790\` |\r
| Enabled Route is stopped | Start/Restart and recent logs in Log Diagnostics |\r
| No triggerable rule | A \`heartbeat\` or \`manual_trigger\` rule in Persona |\r
| Codex is unbound | Workspace, task selection, and rescan results |\r
| \`no-client-found\` | Desktop is open and can load the target task |\r
| Trigger succeeds but no task message | Delivery channel, task ID, workspace, and recent logs |\r
\r
For the full sequence, see [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\r
\r
## Next steps\r
\r
- Add QQ: [Routes and message adapters](routes-and-adapters_en.md).\r
- Bind messages to the correct project task: [Agents, projects, and tasks](agents-and-sessions_en.md).\r
- Configure group, private, or scheduled rules: [Personas and message rules](personas-and-rules_en.md).\r
`,me=`<!-- docs-language-switch -->
<div align="center">
<a href="./interface-and-status_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 界面与状态

RibiWebGUI 是 RabiRoute 的本地控制台。它负责展示和编辑配置、调用 Manager 动作并呈现诊断结果，但配置事实最终保存在本地文件和运行状态中。

## 从局域网访问 WebGUI

Rabi PC 上的 Manager 就是 RibiWebGUI 的完整 HTTP 后端。默认地址 \`http://127.0.0.1:8790/\` 只允许本机使用；另一台设备上的 \`127.0.0.1\` 指向那台设备自己，不会指向 Rabi PC。

在 Rabi PC 本机打开“控制台 → 目录配置 → 局域网访问 WebGUI”，开启访问并生成密钥。重启 Manager 后，若仍从本机 \`localhost/127.0.0.1\` 打开 WebGUI，页面会自动重定向到优先局域网 IP，并保留当前 Route、页面和认证；也可以复制页面给出的链接，例如：

局域网 HTTP 页面可能没有浏览器的安全剪贴板权限。控制台的复制链接、复制密钥和其它 WebGUI 复制按钮会先使用 Clipboard API，权限不可用时自动回退到页面内复制；只有两种机制都被浏览器拒绝时，才提示手动选择文本复制。

\`\`\`text
http://192.168.0.57:8790/#/routes/<Route配置名>/overview?webgui_token=<访问密钥>
\`\`\`

左侧“当前路由”是唯一选择源。控制台、消息适配器、人格配置、计划与记忆、语音服务和日志诊断都使用 \`#/routes/<Route配置名>/<页面>\`；对应页面依次为 \`overview\`、\`adapters\`、\`persona\`、\`knowledge\`、\`speech\`、\`runtime\`。切换当前 Route 会保留页面类型并立即重定向 URL。“性能监控”和“设置”是本机全局页面，不随当前 Route 改变。若要直接打开该 Route 的“计划与记忆”，使用同一个 Route 配置名和 \`knowledge\` 页面，或点击“复制 Route 知识库链接”：

点击左侧任一页面标签时，WebGUI 会先更新选中状态、顶部标题和 URL，并立即显示“页面已切换，正在加载内容”。控制台、消息适配器、人格配置、计划与记忆、语音服务、性能监控、日志诊断和设置的页面代码与数据随后异步加载，不会等待完整页面准备好才切换标签。页面代码加载失败时会自动刷新一次并恢复当前目标页面。

\`\`\`text
http://192.168.0.57:8790/#/routes/<Route配置名>/knowledge?webgui_token=<访问密钥>
\`\`\`

Route 配置名会进行 URL 编码。打开任一 Route 作用域链接后，页面会先选中该 Route；切换左侧 Route 时，当前浏览器会话的地址会同步为新 Route 的同类页面路径。需要收藏、重新打开或发送给同一局域网中的已授权设备时，应使用包含访问密钥的完整链接，不要直接复制已经自动移除密钥的地址栏。

WebGUI 会把 URL 中的密钥保存到当前浏览器会话，自动用于 HTTP、SSE 和人格头像请求，并从地址栏移除，避免后续截图继续暴露。轮换密钥会立即使旧链接失效；开关和密钥只能由运行 Manager 的 Rabi PC 本机管理，自动重定向后的本机局域网地址仍可管理，其他设备不可以。若链接超时，先确认 Manager 已重启，再检查 Windows 防火墙的专用/域网络是否允许 RabiRoute 或 Node.js 监听 TCP \`8790\`。不要把链接发送到公开群聊、日志或仓库。

Rabi PC 本机通过自己的局域网 IP 访问时仍按本机请求处理，因此开启局域网访问不会让同一台电脑上的消息发送、托盘或本地工具额外要求 WebGUI 密钥。其他设备仍必须使用带有效密钥的完整链接。

## 通过 RabiLink 远程访问 WebGUI

若 Rabi PC 已开启全局 RabiLink Relay 连接，并在 Relay 管理后台属于当前账号，可先登录 \`https://rabiroute.cottongame.com/manage\`，再打开：

\`\`\`text
https://rabiroute.cottongame.com/manage/<账号>/<RabiGUID>/#/routes/<Route配置名>/knowledge
\`\`\`

远程入口使用同一组 Route 页面名；可把末尾 \`knowledge\` 替换为 \`overview\`、\`adapters\`、\`persona\`、\`speech\` 或 \`runtime\`。设置使用本机全局路径 \`#/settings\`，性能监控使用本机全局路径 \`/performance\`。

也可以把最后页面换成 \`overview\` 或其他 WebGUI 路由。远程入口不使用局域网 \`webgui_token\`，而使用浏览器的 Relay 管理登录 Cookie；PC worker 另用应用 token 与 Relay 通讯。普通 API、图片、附件、音频、文件下载和视频按字节播放都会回到目标 PC 的本机 Manager，Manager 事件也会经远程 SSE 实时刷新。若页面壳能打开但数据、附件或状态不更新，先确认 Relay 中目标 PC 在线、RabiGUID 正确，并确认服务器脚本和 \`ribiwebgui/dist\` 已同时发布；只重启本机 Manager 不会更新公网 Relay 代码。

## 先认清主要页面

| 区域 | 主要用途 | 常见动作 |
| --- | --- | --- |
| 控制台 | 查看和操作各个 Route | 新增、启用、重启、删除 Route |
| 消息适配器 | 配置消息入口和 Agent 处理端 | 扫描、添加、连接、绑定任务 |
| 人格配置 | 管理人格、路由变量和消息规则 | 新增规则、编辑正则和定时计划 |
| 计划与记忆 | 查看当前人格的计划、近期记忆、沉淀记忆和审批记录 | 搜索、展开步骤、核对执行合同、为需要审批的步骤提交意见、刷新 Manager 数据 |
| 语音服务 | 管理本机 TTS、ASR、麦克风和播放 | 查看状态、调整参数、测试语音 |
| 性能监控 | 查看 Manager、Route 和语音服务的运行指标 | 查看实时状态和历史记录 |
| 日志诊断 | 定位链路断点并执行真实测试 | 启停、重启、手动触发、看日志 |
| 设置 | 管理本机身份、RabiLink、目录、局域网访问和桌面入口 | 配置截图、滑词菜单、登录启动、访问密钥和访问链接 |
| 使用手册 | 按任务阅读软件使用说明 | 搜索、切换章节、打开深入资料 |

进入“计划与记忆”后，页面先请求首批 8 条轻量计划摘要，并行补齐首两张可见卡片的完整详情后再显示卡片，因此首屏不会先停在“正在加载计划详情…”；随后无需滚动，页面会按每批最多 50 条自动补齐当前分类的全部计划摘要，并按每批最多 100 条自动补齐当前可见的记忆分类。页面持续显示已加载数量与总数；标签页不可见时暂停这些后台请求，重新显示后重新读取并继续补齐。左侧目录保留全部已返回标题，右侧正文只先挂载 8 张计划卡和 24 张记忆卡，再随滚动分批追加；点击尚未挂载的目录项时会从目标计划开始创建一个有界的向后窗口，并把该计划的详情放到最高优先级，当前 Manager 与局域网环境以 1 秒内显示详情为交互预算。页面不会一次创建目标前面的几十张正文卡；向下滚动会继续加载后面的计划，向上滚动会分批补回目标前面的计划，并保持当前卡片的页面位置。其余正文、步骤、审批与附件元数据只在卡片真正接近视口时按需加载，每轮只提升最近的 2 张且最多 2 个并发请求；下一批摘要只让出一个渲染帧，不等待正文详情加载完成，因此目录补齐不会被重卡片或附件拖慢。只有已经发出详情请求的卡片显示加载动画，尚未进入视口的卡片使用紧凑提示，不再为全部计划同时创建大型骨架；离屏计划卡由浏览器跳过布局和绘制。图片和视频在媒体就绪前显示浅色“附件加载中”占位，不会以纯黑块占住页面。

页面只在用户展开计划详情时读取该计划所绑定任务 Agent 的 Codex Desktop 状态；页面刷新后也只补查仍保持展开的计划，不再为全部计划发起状态扫描。单次等待最多 3 秒，同一轮不会重复请求同一个计划。展开详情可查看任务 Agent、已启用时的协助秘书、各自的工作状态和 Codex 会话任务状态；会话不存在时单独显示“会话任务 Agent 已丢失”。非工作中且绑定有效的任务可从卡片或 Agent 行在 Codex 中定位并唤醒；该动作只打开精确的任务 ID，不新建任务，也不发送消息。

计划卡片的分类、状态、状态色板、排序和审批说明都由 Manager 返回。RibiWebGUI 顶部从左到右显示“当前计划 / 近期记忆 / 沉淀记忆 / 已归档”四个标签：“当前计划”展示未归档计划；“近期记忆”只展示尚未沉淀的记忆；“沉淀记忆”展示整理后仍可召回的稳定记忆；“已归档”同时展示归档计划和已经作为沉淀输入的来源记忆。RibiWebGUI 与 Qt 托盘继续使用 Manager 返回的同一套卡片强调色和状态徽标颜色。RibiWebGUI 会在计划标题下显示与标题不同的 \`focus\` 计划描述；旧计划用标题回填 \`focus\` 时不会重复显示。多条计划之间使用中性底色间隔和独立描边形成清晰的工作项边界；卡片不显示会随排序和筛选变化的动态序号，内部再按“问题标题与描述 → 当前步骤与时间 → 展开后的完整执行计划”建立三级层级，避免相邻计划和计划内步骤落在同一视觉平面。没有进入审批的进行中计划在展开详情顶部显示计划级引导，输入只关联 \`planId\`，Agent 可据此调整整个计划和尚未开始的步骤。展开后的进行中步骤只显示 Manager 记录的开始时间，已完成步骤只显示完成时间，未开始步骤不显示时间。计划面板外侧提供粘性悬浮的计划目录，只列出当前页签与搜索条件下可见的计划；每行左侧直接显示去掉开头连续 \`[...]\` 分类前缀的精简标题，右侧只显示一个与当前排序方式对应的标签。时间排序显示相对更新时间；状态、重要程度和紧急程度使用 Manager 返回的整数等级，并分别映射文字和颜色。重要程度从“最高”到“低”排列，未设置排在最后；紧急程度从“紧急”到“低”排列，未设置排在最后。目录标题右侧显示当前结果数；右上角按钮打开名为“列表排序与筛选”的独立模态对话框。用户点击“完成”后，WebGUI 才把排序和筛选参数交给 Manager，由 Manager 在分页前处理，目录与右侧计划卡片始终使用同一结果和顺序。目录自身可滚动，点击标题会平滑定位并聚焦右侧正常页面流中的对应计划卡片；计划卡片仍保留完整原始标题。窄屏下目录移到计划面板上方，计划卡片内部不增加目录。审批合同直接展开在 Manager 指定的对应步骤卡片内，并列出完整审批材料与回执。用户意见、Agent 回复和系统记录按时间从旧到新纵向排列，每条独立占位；新回复不会替换先前意见，新的反馈输入框始终位于记录列表下方。信息不完整时页面标记“审批资料不完整/禁止审批”，审批输入、附件和提交全部禁用；补齐为 \`ready/enabled=true\` 后才允许提交审批决定。已启用时，反馈可以选择普通文件，也可以先复制图片，再在输入框中按 \`Ctrl+V\` 将图片作为附件粘贴；页面会显示图片缩略图或文件卡片，并允许提交前删除。最多 8 个附件，单个不超过 10 MiB、总计不超过 25 MiB。填写意见后可按 \`Enter\` 直接提交，\`Shift+Enter\` 保留换行；中文输入法确认候选词的回车不会误提交。点击或按键提交后，意见落盘即结束按钮加载，Agent 通知在后台继续；终态只刷新当前卡片，失败时恢复原意见与附件供重试，不再整页重载计划与记忆。

当前步骤摘要会在步骤标题下直接显示该步骤的 \`detail\` 描述，用户无需展开完整执行计划即可看到本步要做什么。步骤没有描述时不显示空白占位。

目录不会产生整个面板的水平滚动。右侧排序标签固定不动，左侧标题在溢出时于鼠标悬停或键盘聚焦后匀速往返滚动；减少动态效果的系统偏好会关闭标题滚动。列表弹窗里的选择只是草稿，关闭弹窗不会改变列表；点击“完成”后，页面关闭弹窗并立即重新调用整个计划列表，排序、筛选、目录和内容卡片一次更新。

筛选弹窗同时提供状态和计划 \`keywords\` 标签。两个分组都可多选：同组匹配任一项，计划需要同时满足状态组和标签组。标签较多时可在弹窗内搜索；按钮和结果摘要显示当前筛选数量，并提供分组清除与一键清除。窄屏下两个筛选组改为单栏，复选项和操作按钮保持至少 44px 操作区。

直接进入“计划与记忆”页面时，页面会并行读取记忆数量，因此“近期记忆”“沉淀记忆”和“已归档”的数字不需要等用户切换标签后才出现。近期记忆卡片显示“记录时间”和“上次命中召回”两个时间；从未被消息真正命中过的记忆显示“尚未命中召回”。已归档来源记忆显示记录时间和归档时间。记忆正文按 Markdown 显示，可混排标题、列表、代码、链接和 HTTP(S) 图片；本机绝对路径与危险协议不会加载。单张记忆卡片最高 512px，超出的正文在卡片内裁剪，不出现卡片内滚动条；点击“查看详情”可在独立窗口阅读完整内容。当最不活跃的记忆距离 72 小时触发点不足 24 小时时，记忆列表上方出现独立的“近期记忆沉淀”区域，显示剩余时间、将触发的记忆和预计进入本次沉淀的数量。会进入本次沉淀的卡片带有标记。倒计时到 0 后，Manager 会自动创建并投递本批沉淀任务，无需保持这个页面打开。本轮候选固定为原始 72 小时触发时已经超过 24 小时的记忆，晚执行不会追加后来才跨过边界的条目；候选结果由 Manager 动态给出，页面不会把普通查看当成召回，也不会自行推算候选范围。

计划本体也可以由 Agent 在创建或更新计划时附带图片、视频或普通文件，包括待审批计划已经产出的效果图、演示视频、设计稿、报告或补丁。图片、视频和 Markdown 在计划描述下方统一使用紧凑的固定宽度 16:9 预览卡片，只有容器更窄时才等比缩小。Markdown 卡片会安全读取文档开头并显示截断的纯文本简短预览，卡片内不会执行 HTML、打开链接或加载图片；点击后才在页内以文档样式预览标题、列表、表格、引用和代码块，并保留原文件下载入口。视频缩略图在未悬停、未选中时也会常驻显示播放图标，并由浏览器读取媒体 metadata 后在右下角显示 \`m:ss\` 或 \`h:mm:ss\` 时长。点击图片在当前页面打开大图，点击视频打开带播放控制的页内预览。单个 Markdown 超过 2 MiB 时只提供下载，避免浏览器因超长文档卡顿。完整文档预览会转义原始 HTML、禁用危险或相对链接，并把远程图片显示为文本占位，不从附件内容自动加载第三方资源。支持识别 PNG、JPEG、WebP、GIF 与 MP4/M4V、WebM、Ogg Video、MOV/QuickTime，视频的实际解码能力取决于浏览器。其它文件显示文件名、类型与大小，点击后由 Manager 打开或下载。浏览器不会直接读取计划记录中的本机路径，所有附件都经过受控 Manager 接口；局域网 WebGUI 会把当前会话密钥自动附加到缩略图、媒体预览和文件链接。

RabiLink 远程 WebGUI 会自动为缩略图、媒体预览和文件链接保留 \`/manage/<账号>/<RabiGUID>\` 前缀，并为视频转发字节范围请求；不需要也不应在远程 URL 中添加局域网 \`webgui_token\`。

Agent 处理意见后会先更新计划，再把说明作为 \`approval_response\` 直接显示在该计划记录中；Codex 任务只保留简短处理状态，不作为回复正文的交付位置。

先用左侧选择当前 Route，再看顶栏的 Manager 连接状态。Route 是否正在运行，要以控制台或日志诊断里的运行状态为准。

“计划与记忆”页不直接读取 \`data/\`，也不在浏览器里重新解释分类、状态颜色或合同完整性。Manager 返回计划的状态整数等级、重要程度整数等级、紧急程度整数等级、各自文字和色板、\`counts.stages\` 及审批状态；默认顺序也由 Manager 决定。用户在列表菜单选择排序或筛选时，浏览器只提交参数。时间排序使用 \`updatedAt\`；其余三种排序都比较 Manager 返回的整数等级。没有进入审批步骤的进行中计划在展开详情后提供“计划引导”：输入针对整个计划，不绑定某一步；Agent 会根据引导继续推进，并在需要时调整尚未开始的步骤。进入审批状态后只显示对应步骤里的审批入口，不同时开放计划引导。计划引导和审批输入都支持用 \`@\` 引用计划附件，并共享键盘提交、附件选择、粘贴、预览和删除操作。未终态计划只显示绿色“进行中”、蓝色“等待打包”、紫色“等待 QA”、灰色“暂停”、红色“待审批”、橙色“待人工核验”；暂停绝对排在最后。外部资料、账号、设备、owner、授权和回执等原因只保留在计划详情中。

等待审批、方案确认或授权时，当前步骤写入完整的 \`approvalRequest\`。只有合同完整、可提交且 \`responseStatus=pending\` 时，Manager 才显示红色“待审批”，并同时开放审批入口。审批资料缺项时计划仍显示绿色“进行中”，由 Agent 继续调查和补齐。会改变交付内容的计划只有在适用同步、SVN 提交和无冲突回读完成后才显示蓝色“等待打包”；目标包完成并证明纳入后显示紫色“等待 QA”。开发闭环后只剩人工视觉或交互确认的 \`manual-verify-*\` 步骤显示橙色“待人工核验”。完全没有安全动作时显示灰色“暂停”，具体缺口继续保存在 \`waitingFor\`。

“实施/开发验证/适用同步提交 → 等待打包 → 等待 QA 验收 → QA 通过完成；QA 失败回实施”只用于代码、Prefab、资源、配置等会改变项目内容的计划。调查、设计评审、运营、资料收集、外部依赖与控制面维护继续显示自身真实步骤和等待原因，不会为了凑流程被塞入打包或 QA 阶段。

工作群中的“已认领”只表示 Agent 已通过引用消息公开接手。计划与记忆中出现对应工作项，还要求后台完成受管登记：源消息、有效认领回执、唯一计划、唯一正式任务、两轮查重和三方 workspace 必须一致。认领成功但登记失败时，不能把它当成已经进入计划闭环。

长计划列表保持正常页面滚动，只有外侧计划目录限制在视口高度内独立滚动。滚动右侧计划时，页面使用浏览器可见性观察更新目录中的当前阅读项；只有高亮项离开目录自身的可见区域时才调整目录滚动，不对整页滚动执行持续的全列表扫描。点击目录跳转时会暂时锁定所选高亮，平滑滚动结束后再恢复当前阅读项观察，避免沿途计划让目录光标连续跳动。计划分类、搜索和刷新工具栏在桌面宽度下会吸附在固定顶栏下方；目录跳转为卡片标题预留工具栏高度，不会把定位目标遮住。窄屏下工具栏恢复普通页面流，避免双行控件长期占用可视区域。展开详情不执行高度动画，审批输入也不自动反复增高。

计划引导或审批意见落盘后，Agent 通知会在后台继续。通知期间下一条草稿仍可编辑，只暂时禁止再次提交，并在输入区附近明确说明原因。计划引导回写为只关联 \`planId\` 的处理说明；审批回复仍关联 \`planId / stepId\`。计划详情中的“工作留痕”默认折叠，展开后可以查看计划引导、步骤审批意见、Agent 回复和计划版本；已批准、已完成和已归档计划也保留该入口。

## 左侧栏：先选择当前 Route

左侧“当前航线”决定大多数页面正在查看和修改哪一条 Route。切换前如果存在未保存修改，界面会请求确认。

Route 下拉旁的数量是当前配置数量。下拉选中项和候选项优先显示人格标题；Route 配置名、禁用状态和消息端组合作为辅助信息，便于同一人格存在多条 Route 时继续区分。没有可用人格标题时，界面依次回退到 Route 显示名、人格 ID 和配置名。下方状态不代表每个外部平台都已经登录。

主导航下方依次是“语音服务”“性能监控”“日志诊断”和“设置”；这些页面位于“使用手册”上方。

## 界面主题

在“设置”的“RabiRoute 桌面功能”中选择“跟随系统”“浅色”或“深色”，再点击顶栏“保存配置”。当前 WebGUI 会立即切换；Windows 托盘、角色面板、滑词操作条和截图窗口会在下一次设置刷新时切换，通常不超过十秒。主题只改变颜色和控件外观。完整说明见[界面主题](interface-theme.md)。

## 系统截图与人格投递

在 WebGUI 打开“设置”，找到“桌面快捷功能”：

1. 开启“系统级截图”，设置截图快捷键、“自动复制选区”和“贴图快捷键”。默认贴图快捷键为 \`F3\`；所有快捷键都可单独使用 \`F1\` 到 \`F12\`，也支持 \`Ctrl\`、\`Alt\`、\`Shift\`、\`Win\` 加一个字母或功能键。完成设置页的其他修改后，统一点击顶栏“保存配置”。
2. 在任意 Windows 软件中按截图快捷键后，截图窗口会先打开，画面不会整体变暗，可立即拖动框选区域。光标移到窗口上会显示可选范围和尺寸，图片就绪后窗口以外的画面会变暗，窗口本身保持原亮度；此时该窗口已是当前操作区域，可直接按 \`Enter\` / \`Ctrl+C\` 复制、按 \`F2\` 发送或按贴图快捷键贴图。单击左键也可保留整个窗口作为待确认选区。拖拽后选区以外的画面变暗，选区内保持原亮度；可在选区内拖动调整位置，也可拖动边框四角和四边中点调整范围。截图工具栏使用图标按钮；悬停可以查看文字提示，当前工具会显示青绿色背景和亮色边框，当前颜色会显示选中边框。选区确定后，工具栏可选择“框”“箭头”或“文字”，并用红、黄、绿、蓝四种颜色标注；文字标注支持不限长度的多行输入；直接输入文字，输入范围会随最长一行和换行数自动扩展；点击文字区域外的空白处完成，点击已有文字可选中，拖动文字可移动，拖动八个控制点可调整文字范围，双击可再次编辑，文字属性栏中的字号按钮可调整文字大小。按 \`Ctrl+Z\` 删除最后一笔。复制、贴图或发送时会把标注写入图片。图片尚未准备完时点击“复制”“贴图”或“发送”，会在图片就绪后继续。拖拽只创建待确认选区：按 \`Enter\` / \`Ctrl+C\` 复制，按 \`F2\` 发送，按贴图快捷键确认并贴图；默认确认贴图或发送时也复制到剪贴板，可在“自动复制选区”关闭，关闭后仍可按 \`Ctrl+C\` 或点击“复制”。\`Ctrl+A\` 选择整个屏幕。未框选时，光标右下角会跟随显示静态画面的 10 倍像素采样预览、当前颜色块和 HTML 颜色代码 \`#RRGGBB\`；按 \`C\` 直接复制该代码，不确认选区、不写入截图历史，也不弹通知。按鼠标右键、\`Esc\` 或关闭截图窗口会取消本次截图，不写入截图历史；复制、贴图或发送才会保存截图和框选区域。
3. 截图窗口按 \`<\` / \`>\` 查看上一张和下一张已保存的屏幕截图；切换后会恢复该截图最后一次用于复制、贴图或发送的框选区域。截图窗口打开且已框选区域时，按贴图快捷键会直接贴出该区域；其他时候按贴图快捷键会贴出剪贴板中的图片；框选贴图会保留原屏幕位置和大小，拖动、缩放、复制、保存和调整透明度后，RabiRoute Desktop 重启仍会恢复。关闭单个贴图才删除它。
4. 点击“发送”后，输入可选文字并从“投递至人格”中选择已激活人格。文字可以留空，图片仍会发送。

截图和文字共用角色面板投递入口。Codex 和 DSH 会把截图作为图片输入接收；截图文件暂存在项目私有目录 \`.rabiroute-message-images/\`，贴图图片和区域记录保存在私有 \`data/desktop/\`。修改截图开关、截图快捷键、自动复制选区、贴图快捷键或“Windows 登录启动”后，托盘会自动读取新配置，不需要重启。

## 开启滑词菜单

在 WebGUI 打开“设置”，找到“开启滑词菜单”：

1. 打开“开启滑词菜单”。完成设置页的其他修改后，统一点击顶栏“保存配置”。在 Windows 软件中用鼠标拖选，或用 \`Shift\` + 方向键 / \`Home\` / \`End\` / \`PageUp\` / \`PageDown\` 扩选文字后，会出现系统悬浮按钮。悬浮条按选区范围横向居中；鼠标向上拖选时显示在上方，向下或同一行拖选时显示在下方，不遮挡选中文字。键盘扩选会使用系统插入符范围；Unity 没有系统插入符时，使用同一窗口最近一次点击位置。
2. 把光标移到“投递至”，会列出当前已启用且运行中的人格；点击一项后，把选中文字投递到对应 Route。
3. “滑词朗读”是滑词菜单的子功能。开启时悬浮条左侧还有“朗读”，点击后才进入本机语音队列；关闭后悬浮条只保留“投递至”。
4. 只有同时打开“滑词朗读”和“高级选项”，才显示“滑词朗读模型”。

划选本身不朗读、不投递。密码控件和仍无法读取的选区会被忽略。普通软件不会模拟 \`Ctrl+C\`；Unity 编辑器只有在 UI Automation 读不到文字时才发送受保护的临时复制，等待编辑器更新剪贴板，并在读取后恢复原剪贴板。保存后托盘会读取新配置，不需要重启。

左下角有四个辅助入口：

- **快速配置**：用三步向导完成常见配置。
- **GitHub**：打开项目仓库。
- **使用手册**：打开本页所在的用户文档中心。
- **打开配置目录**：在本机查看 Manager 配置位置。

## 顶栏：区分连接、保存和刷新

顶栏中的 \`Manager 已连接\` 只表示浏览器能访问 Manager。它不等于 Route 正在运行，也不等于 NapCat 或 Codex 已经就绪。

| 控件 | 实际作用 |
| --- | --- |
| 中 / EN | 切换当前浏览器的界面语言，不修改 Route 数据 |
| 刷新状态 | 重新读取 Manager、配置和运行状态，不保存编辑内容 |
| 新增航线 | 新建 Route 并打开快速配置 |
| 保存配置 | 在 Route 页面保存当前 Route；在“设置”页一次保存桌面功能、滑词、Rabi 实例、目录和局域网访问配置；在“性能监控”页保存性能记录设置 |

出现“有未保存的修改”时，先保存再切换 Route 或离开页面。刷新不是保存，重启也不会替你保存表单。


## 常见运行状态

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| 运行中 | 需要子进程的 Route 已启动 | 继续检查消息端和处理端连接 |
| 启用中 | Route 已启用，但当前入口不需要独立 Gateway listener | 查看对应 Manager 入口状态 |
| 已停止 | Route 配置存在，但子进程没有运行 | 到日志诊断启动或检查错误 |
| 禁用中 | Route 或消息输入被关闭 | 确认是否应启用后保存 |
| Manager 未连接 | WebGUI 无法访问本地 Manager | 检查进程、端口和启动目录 |

实验适配器显示“实验”并不等于故障。它表示代码入口存在，但外部系统或真机链路仍需在你的环境里验收。

## 启动、停止和重启的区别

- **启动**：让当前 Route 的运行入口开始工作。
- **停止**：停止当前 Route 子进程，不删除配置和历史记录。
- **重启**：停止后重新启动，用于应用构建或连接变化。
- **删除**：删除 Route 配置，风险高于停止；操作前先确认数据范围。

Manager 只守护自己启动的 Route 子进程。NapCat、QQNT、Codex/ChatGPT Desktop 等外部程序有各自的生命周期。

## 语言切换边界

界面语言保存在当前浏览器。Route/persona ID、规则名、模板、正则、任务名、路径、token、日志和运行数据保持原文，不随语言切换改变。

使用手册会切换到对应语言文件。开发者文档、代码路径和外部页面会按链接打开，不会生成第三份自动翻译内容。

## 接下来阅读

- 还没有成功投递：回到[跑通第一条 Route](first-route.md)。
- 不知道该选哪个入口：阅读 [Route 与消息端](routes-and-adapters.md)。
- 状态正常但消息没到：阅读[运行、日志与排障](operations-and-troubleshooting.md)。
`,be="<!-- docs-language-switch -->\n<div align=\"center\">\nEnglish | <a href=\"./interface-and-status.md\">简体中文</a>\n</div>\n<!-- /docs-language-switch -->\n\n# Interface and status\n\nRibiWebGUI is RabiRoute's local control console. It edits configuration, invokes Manager actions, and shows diagnostics. Local files and runtime state remain the underlying sources of truth.\n\n## Access WebGUI from the LAN\n\nManager on the Rabi PC is RibiWebGUI's complete HTTP backend. The default `http://127.0.0.1:8790/` is local-only. On another device, `127.0.0.1` points back to that device, not to the Rabi PC.\n\nOn the Rabi PC, open **Console → Directory configuration → LAN WebGUI access**, enable access, and generate a key. After restarting Manager, a WebGUI still opened locally through `localhost/127.0.0.1` automatically redirects to the preferred LAN IP while preserving the current Route, page, and authentication. You can also copy the generated link, for example:\n\nAn HTTP LAN page may not receive secure browser clipboard permission. Copy-link, copy-key, and other WebGUI copy actions try the Clipboard API first and automatically fall back to an in-page copy operation when that API is unavailable or rejected. A manual-copy message appears only when the browser rejects both mechanisms.\n\n```text\nhttp://192.168.0.57:8790/#/routes/<Route-config-name>/overview?webgui_token=<access-key>\n```\n\nThe sidebar **Current Route** selector is the only selection source. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, and Runtime Diagnostics all use `#/routes/<Route-config-name>/<page>`, with `overview`, `adapters`, `persona`, `knowledge`, `speech`, and `runtime` respectively. Changing Current Route preserves the page type and immediately redirects the URL. **Performance** and **Settings** are host-wide pages and do not change with the selected Route. To open that Route's **Plans & Memory** directly, use the same Route configuration name with the `knowledge` page, or click **Copy Route knowledge link**:\n\nClicking any sidebar page label updates the selected state, top title, and URL first, then immediately shows **Page switched. Loading content…**. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, Performance, Runtime Diagnostics, and Settings load their page code and data asynchronously instead of delaying the tab switch until the complete page is ready. If a page chunk fails to load, WebGUI refreshes once and restores the intended page.\n\n```text\nhttp://192.168.0.57:8790/#/routes/<Route-config-name>/knowledge?webgui_token=<access-key>\n```\n\nThe Route configuration name is URL-encoded. Any Route-scoped link selects that Route before rendering the page. Switching the sidebar Route updates the current browser session to the same page type under the new Route. To bookmark, reopen, or share the shortcut with an authorized device on the same LAN, use a complete keyed link rather than the address bar after WebGUI has removed the key.\n\nWebGUI keeps the URL key in the current browser session, automatically applies it to HTTP, SSE, and persona-avatar requests, and removes it from the address bar so later screenshots do not keep exposing it. Rotating the key immediately invalidates old links. The switch and key can be managed only from the Rabi PC running Manager; that PC's redirected LAN address remains manageable, while other devices cannot manage them. If the link times out, first confirm that Manager restarted, then check whether Windows Firewall allows RabiRoute or Node.js TCP `8790` on the private/domain network. Never publish the link in a public chat, log, or repository.\n\nRequests from the Rabi PC to its own LAN address are still treated as local requests. Enabling LAN access therefore does not make message sending, the tray, or local tools on that same PC require the WebGUI key. Other devices must still use the complete link with a valid key.\n\n## Access WebGUI remotely through RabiLink\n\nWhen the Rabi PC has the global RabiLink Relay connection enabled and belongs to the current Relay account, sign in at `https://rabiroute.cottongame.com/manage`, then open:\n\n```text\nhttps://rabiroute.cottongame.com/manage/<account>/<RabiGUID>/#/routes/<Route-config-name>/knowledge\n```\n\nThe remote entry uses the same Route page names. Replace `knowledge` with `overview`, `adapters`, `persona`, `speech`, or `runtime` as needed. Settings uses the host-wide `#/settings` path, and Performance uses the host-wide `/performance` path.\n\nReplace the final page with `overview` or another WebGUI route when needed. This remote entry does not use the LAN `webgui_token`; it uses the browser's Relay management login cookie, while the PC worker separately authenticates with its application token. Ordinary APIs, images, attachments, audio, downloads, and byte-range video playback return to the selected PC's loopback Manager, and Manager events refresh through remote SSE. If the shell opens but data, attachments, or live status do not, verify that the target PC is online in Relay, the RabiGUID is correct, and the Relay script plus `ribiwebgui/dist` were published together. Restarting only the local Manager does not update the public Relay.\n\n## The main pages\n\n| Area | Primary purpose | Common actions |\n| --- | --- | --- |\n| Console | View and operate each Route | Add, enable, restart, or delete a Route |\n| Message Adapters | Message sources and Agent handlers | Scan, add, connect, and bind tasks |\n| Persona Configuration | Persona, Route variables, and message rules | Add rules, regexes, and schedules |\n| Plans & Memory | Plans, recent memory, consolidated memory, plan guidance, and approval records for the current persona | Search, guide running plans, expand steps, review execution contracts, submit approval feedback, and refresh Manager data |\n| Speech Service | Host TTS, ASR, microphone, and playback | Inspect status, adjust parameters, and test speech |\n| Performance | Manager, Route, and speech-service runtime metrics | Inspect live state and history |\n| Log Diagnostics | Find path breaks and run real tests | Start, restart, trigger, and inspect logs |\n| Settings | Host identity, RabiLink, directories, LAN access, and desktop entry points | Configure screenshots, the selected-text menu, login startup, access keys, and access links |\n| User Guide | Task-based product instructions | Search, change page, and open deeper material |\n\nWhen Plans & Memory opens, it first requests eight lightweight plan summaries and fetches the complete details for the first two visible cards in parallel before mounting those cards, so the first screen does not pause on `Loading plan details`. Without requiring scroll, it then completes the selected plan category in background pages of up to 50 summaries and completes the visible memory category in pages of up to 100 items. The page keeps the loaded and total counts visible. These background requests pause while the tab is hidden; when the tab becomes visible again, the page refreshes and resumes completion. The left directory retains every returned title, while the content area initially mounts only eight plan cards and 24 memory cards, then appends bounded batches while scrolling. Clicking a directory item that is not mounted creates a bounded forward window starting at that target and gives that plan's detail request highest priority; the current Manager and LAN environment uses a one-second interactive detail budget. The page does not create every preceding body card at once. Scrolling down renders later plans, while scrolling up restores earlier plans in bounded batches and keeps the current card at the same viewport position. Other body text, steps, approvals, and attachment metadata hydrate only when cards are genuinely near the viewport; each observer turn promotes only the nearest two cards and runs at most two concurrent detail requests. Each later summary page yields one rendering frame without waiting for body hydration, so heavy cards or attachments cannot delay directory completion. Only cards with a real in-flight detail request show the loading animation; cards that have not approached the viewport use a compact hint instead of instantiating a large skeleton for every plan, and the browser skips layout and paint for off-screen cards. Image and video cards show a light `Loading attachment` placeholder instead of a black block until media is ready.\n\nThe page reads Codex Desktop state only when the user expands a plan, and after a page refresh it checks only plans that remain expanded. It no longer starts a state scan for every loaded plan. One plan is not requested twice in the same pass, and each read has a three-second limit. Expanded details show the Task Agent, the Plan Secretary when enabled, each Agent's work state, and the matching Codex task state. A missing task has its own `Task Agent session is missing` label. A valid non-working binding can be located or awakened in Codex from the card or Agent row; this opens only the exact task ID and sends no message or replacement task.\n\nFor a running plan outside approval, expanding the card exposes whole-plan guidance. It is associated only with `planId`, not one step; the Agent uses it to continue the plan and adjust not-started steps when needed, then writes a `guidance_response` without `stepId`. Approval plans continue to use the owning step's approval contract and `approval_response`.\n\nChoose the current Route in the sidebar, then check the Manager connection in the top bar. Use the Console or Log diagnostics runtime state to decide whether that Route is running.\n\nThe **Plans & Memory** page never reads `data/` directly or reinterprets Manager presentation. Non-terminal cards expose only green `In progress`, blue `Awaiting package`, purple `Awaiting QA`, gray `Paused`, red `Awaiting approval`, and orange `Awaiting manual verification`. External information, accounts, devices, owners, authorization, and receipts remain internal plan details instead of status labels. RibiWebGUI and the Qt tray consume the same Manager DTO, palette, counts, and order.\n\nThe current-step summary now shows the step's `detail` description directly below its title, so users can see what the step requires without opening the full execution plan. Steps without a description do not render an empty placeholder.\n\nThe directory never introduces horizontal scrolling for the whole panel. The trailing sort label remains fixed while an overflowing title moves at a constant speed on pointer hover or keyboard focus. Reduced-motion preferences disable title movement. Choices in the list dialog remain drafts until **Done**. Closing the dialog leaves the current list unchanged; **Done** closes it and immediately calls the complete plan list once with the selected Manager-side sort and filters, updating directory and content cards together.\n\nThe dialog includes both status filters and plan `keywords` tags. Each group supports multiple selections with OR matching inside the group; a plan must match both groups. The tag section is searchable. The trigger and result summary show the active filter count, with per-group clear actions and **Clear filters**. Narrow screens stack the groups into one column, and checkbox and action targets remain at least 44px.\n\nWhen Plans & Memory is opened directly, the page loads memory counts in parallel, so the Recent Memory, Consolidated Memory, and Archived tab numbers do not wait for the user to open those tabs. Each Recent Memory card shows both its recorded time and its last true recall-hit time; a memory that has never matched a message says `Not recalled yet`. Archived source-memory cards show the recorded time and archive time. Memory bodies render as Markdown with headings, lists, code, links, and HTTP(S) images; local absolute paths and dangerous protocols are not loaded. A memory card is capped at 512px. Extra body content is clipped without an internal card scrollbar, and **View details** opens the complete memory in a separate dialog. When the least-active memory is less than 24 hours away from the 72-hour trigger, a separate consolidation panel appears above the list with the remaining time, the memory that will trigger the run, and the expected candidate count. Candidate cards are marked. At zero, Manager automatically creates and delivers the batch; the page does not need to remain open. The cohort is frozen to memories already beyond 24 hours at the original 72-hour trigger, so late execution does not append later boundary crossings. Manager derives and caches the booleans; the browser neither treats a direct view as a recall nor recalculates the candidate set.\n\nA complete actionable `approvalRequest` with `responseStatus=pending` produces red `Awaiting approval`; an incomplete contract remains green `In progress`. A content-changing plan becomes blue `Awaiting package` after applicable sync, commit, and conflict-free readback. Proven package inclusion produces purple `Awaiting QA`. A development-closed `manual-verify-*` step produces orange `Awaiting manual verification`. A plan with no safe action becomes gray `Paused`, while `waitingFor` keeps the exact internal reason.\n\nAvailable CLI, static checks, fallback validation, retries, sending, or coordination stay green `In progress`. A completed delivery gate that only lacks package identity or inclusion proof is blue `Awaiting package`; proven inclusion is purple `Awaiting QA`. Test infrastructure, assets, documents, owner replies, renewed authorization, or external receipts produce gray `Paused` only when no safe action remains, and their exact reason stays outside the status badge.\n\nThe `implementation/development validation/applicable sync and commit → Awaiting package → Awaiting QA → complete on QA pass; return to implementation on failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance continue to show their real steps and wait reasons instead of being forced into package or QA stages.\n\nA quoted **claim** in the work group only means that the Agent publicly took ownership. For the matching item to appear under Plans & Memory, managed registration must also validate the source message, verified claim receipt, unique plan, unique business task, two deduplication passes, and the same workspace across all three records. A successful claim with failed registration has not entered the managed plan lifecycle.\n\nThe Agent may also add images, videos, or ordinary files to the plan itself when creating or updating it, including effect previews, demo videos, design drafts, reports, or patches already produced for a plan awaiting approval. Images, videos, and Markdown appear below the plan description in compact, fixed-width 16:9 preview cards that shrink only when the container is narrower. A Markdown card safely reads the beginning of the document and displays a clamped plain-text excerpt; it does not execute HTML, open links, or load images. Clicking it opens the in-page document preview with headings, lists, tables, blockquotes, and code blocks plus a source-download action. Video thumbnails keep a play icon visible before hover or selection, then show an `m:ss` or `h:mm:ss` duration in the lower-right corner after the browser reads media metadata. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Markdown files larger than 2 MiB remain download-only to avoid freezing the browser. The complete-document renderer escapes raw HTML, disables dangerous or relative links, and replaces remote images with text placeholders instead of loading third-party resources from attachment content. Recognized media includes PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime, with actual video codec support depending on the browser. Other files show name, type, and size and open or download through Manager. The browser never reads a local path from the plan record directly; every attachment crosses the constrained Manager endpoint, and LAN WebGUI automatically applies the current session key to thumbnails, media previews, and file links.\n\nRabiLink remote WebGUI automatically preserves the `/manage/<account>/<RabiGUID>` prefix for thumbnails, media previews, and file links, and forwards byte-range video requests. Do not add the LAN `webgui_token` to a remote URL.\n\nLong plan lists keep the normal page scroll, while only the external plan directory scrolls independently within the viewport. As the plan cards scroll, browser visibility observation updates the directory's current reading item; the directory adjusts its own scroll only when that highlighted item leaves the directory viewport, without continuously scanning the full list on every page-scroll event. A directory click temporarily locks the selected highlight and resumes reading-position observation after smooth scrolling settles, so intermediate cards do not make the cursor jump through the directory. On desktop widths, the plan-view tabs, search field, and refresh action stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so the destination card heading remains visible. Narrow layouts return the toolbar to normal page flow instead of letting a two-row control block occupy the viewport. Detail expansion remains animation-free, and the approval input does not repeatedly auto-grow.\n\nAfter plan guidance or approval feedback is durably recorded, Agent notification continues in the background. The next draft remains editable while another submission is temporarily disabled, and a nearby status row explains the reason and recovery condition. Each plan detail also has a collapsed **Work history** section. Open it to review plan guidance, step approval feedback, Agent replies, and plan revisions; the entry remains available for approved, completed, and archived plans.\n\n## Sidebar: select the current Route first\n\n**Current Route** determines which configuration most pages display and edit. If changes are unsaved, the interface asks before switching.\n\nThe count beside the selector is the number of configurations. The selected value and menu items prefer the persona title, while the Route configuration name, disabled state, and adapter combination remain secondary details so multiple Routes for one persona stay distinguishable. When no persona title is available, WebGUI falls back to the Route display name, persona ID, and then configuration name. The status below does not prove that every external platform is authenticated.\n\nThe secondary navigation above the footer contains **Speech Service**, **Performance**, **Log Diagnostics**, and **Settings**; these entries sit above **User Guide**.\n\n## Interface theme\n\nIn **Settings** > **RabiRoute desktop features**, choose **Follow system**, **Light**, or **Dark**, then use the top-bar **Save configuration** action. The current WebGUI changes immediately. The Windows tray, role panel, selected-text action bar, and screenshot windows change on the next settings refresh, usually within ten seconds. The theme changes colors and control appearance only. See [Interface theme](interface-theme_en.md) for the full guide.\n\n## System screenshots and persona delivery\n\nOpen **Settings** in WebGUI and find **Desktop shortcuts**:\n\n1. Enable **System screenshot**, then set the screenshot shortcut, **Auto-copy selection**, and **Pin shortcut**. The default pin shortcut is `F3`. Every shortcut can use `F1` through `F12` alone, or `Ctrl`, `Alt`, `Shift`, or `Win` plus one letter or function key. When the other Settings edits are ready, use the single top-bar **Save configuration** action.\n2. Press the screenshot shortcut in any Windows application; the capture window opens first without dimming the screen so you can drag to select immediately. Hovering over a window shows its selectable bounds and size; once the image is ready, the area outside that window is dimmed while the window keeps its original brightness. That window is immediately the active operation area: press `Enter` / `Ctrl+C` to copy it, `F2` to send it, or the pin shortcut to pin it. A left click can still keep the whole window as a selection awaiting confirmation. After dragging, everything outside the selection is dimmed while the selected area remains at its original brightness; drag inside the selection to reposition it, or drag a corner or edge-midpoint handle to resize it. The screenshot toolbar uses icon buttons; hover shows the text label, the active tool has a teal background and bright border, and the active color has a visible selection border. After selecting an area, use the toolbar to add a rectangle, arrow, or text in red, yellow, green, or blue; Text annotations accept unlimited multiline input; type directly on the screenshot; the input range grows with the longest line and line count, then click outside the text area to commit, click the annotation again to select it, drag it to move, drag its handles to resize the text box, double-click to edit, and use the separate text-properties bar to change the font size. `Ctrl+Z` removes the last mark. Copying, pinning, and sending bake the marks into the image. If the image is still preparing, **Copy**, **Pin**, or **Send** continues when it is ready. Dragging only creates a selection awaiting confirmation: `Enter` / `Ctrl+C` copies it, `F2` sends it, and the pin shortcut confirms and pins it. By default, confirming a pin or send also copies the selection to the clipboard; turn that off in **Auto-copy selection** and use `Ctrl+C` or **Copy** when needed. `Ctrl+A` selects the full screen. Before a region is selected, a cursor-following tip shows a 10x pixel-sampling preview, the current color swatch, and the static-image HTML color code `#RRGGBB`. Press `C` to copy it directly without confirming a region, adding screenshot history, or showing a notification. Right-clicking, pressing `Esc`, or closing the capture window cancels that capture without adding it to history; copying, pinning, or sending saves the screen capture and selected area.\n3. Press `<` / `>` in the capture window to view the previous / next saved screen capture. The last area used to copy, pin, or send that capture is restored. While a selected capture is open, press the pin shortcut to pin that selected area. Otherwise, it pins an image already on the clipboard. A pinned selection keeps its original screen position and size; its drag position, zoomed size, and opacity are restored after RabiRoute Desktop restarts. It can also be copied and saved. Closing that individual pin removes it.\n4. Click **Send**, add optional text, choose an active persona in **Send to persona**, and confirm. The image is sent even if the text is empty.\n\nThe screenshot and text use the role-panel delivery entry. Codex and DSH receive the screenshot as image input. The file is kept temporarily in the private project directory `.rabiroute-message-images/`; pinned images and selected-area records are stored in private `data/desktop/`. After changing the screenshot toggle, screenshot shortcut, auto-copy setting, pin shortcut, or **Windows login startup**, the tray reads the new settings automatically; restarting is not required.\n\n## Enable selected-text menu\n\nOpen **Settings** in WebGUI and find **Enable selected-text menu**:\n\n1. Turn on **Enable selected-text menu**. When the other Settings edits are ready, use the single top-bar **Save configuration** action. Select text with a mouse drag or with `Shift` plus an arrow key, `Home`, `End`, `PageUp`, or `PageDown`. The floating buttons are horizontally centered on the selection bounds. An upward mouse drag places them above; a downward or same-line drag places them below. Keyboard selection uses system caret bounds; when Unity has no system caret, the most recent click in the same window keeps the buttons near the text.\n2. Move the cursor to **Send to** to list currently enabled and running personas. Click one item to deliver the selected text to that Route.\n3. **Selected-text reading** is a sub-feature of the selected-text menu. When it is on, the left button is **Read aloud** and only a click enqueues host speech. When it is off, the bar keeps only **Send to**.\n4. The **Selected-text voice model** selector appears only when both **Selected-text reading** and **Advanced options** are on.\n\nSelection alone does not read or send. Password controls and still-unreadable selections are ignored. Normal applications never receive a simulated `Ctrl+C`; only the Unity Editor sends a guarded temporary copy when UI Automation cannot read the selection, waits for the editor to update the clipboard, and restores the original clipboard afterward. After saving, the tray reads the new settings; restarting is not required.\n\nThe footer contains four supporting actions:\n\n- **Quick setup**: configure common paths in three steps.\n- **GitHub**: open the repository.\n- **User Guide**: open this task-based documentation center.\n- **Open config directory**: open the local Manager configuration location.\n\n## Top bar: connection, save, and refresh differ\n\n`Manager connected` only means the browser can reach the Manager. It does not mean the Route, NapCat, or Codex task is ready.\n\n| Control | Actual effect |\n| --- | --- |\n| 中 / EN | Changes this browser's interface language only |\n| Refresh status | Reloads Manager, configuration, and runtime state; does not save edits |\n| Add Route | Creates a Route and opens Quick setup |\n| Save configuration | Saves the current Route on Route pages; on **Settings**, saves desktop features, selected-text menu, Rabi instance, directories, and LAN WebGUI access together; on **Performance monitor**, saves the performance-recording settings |\n\nWhen the unsaved-changes notice appears, save before switching Routes or leaving. Refresh is not Save, and Restart does not save form edits.\n\n\n## Common runtime states\n\n| State | Meaning | Next check |\n| --- | --- | --- |\n| Running | A Route that needs a child process has started | Check source and handler connectivity |\n| Enabled | The Route is enabled but its current entry is Manager-owned | Check the corresponding Manager entry |\n| Stopped | Configuration exists but the child process is not running | Start it or inspect errors in Log Diagnostics |\n| Disabled | The Route or its message input is off | Enable intentionally, then save |\n| Manager disconnected | WebGUI cannot reach the local Manager | Check the process, port, and startup directory |\n\nAn **Experimental** badge is not itself an error. It means a code path exists, while the external system or real-device loop still needs acceptance in your environment.\n\n## Start, stop, restart, and delete\n\n- **Start** begins the current Route's runtime entry.\n- **Stop** ends the Route process without deleting configuration or history.\n- **Restart** stops and starts it again after build or connection changes.\n- **Delete** removes Route configuration and has a wider impact than Stop.\n\nThe Manager supervises Route processes that it starts. External programs such as NapCat, QQNT, and Codex/ChatGPT Desktop keep their own lifecycles.\n\n## Locale boundaries\n\nLocale is stored in this browser. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values stay unchanged.\n\nThe User Guide selects the matching language file. Developer documents, code paths, and external pages open through links; RabiRoute does not maintain a third machine-translated source.\n\n## Continue\n\n- No successful delivery yet: [Run your first Route](first-route_en.md).\n- Unsure which source to choose: [Routes and message adapters](routes-and-adapters_en.md).\n- Status looks healthy but delivery fails: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\n",fe=`<!-- docs-language-switch -->\r
<div align="center">\r
  简体中文 | <a href="./interface-theme_en.md">English</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 界面主题\r
\r
**现行指南。** 设置页、WebGUI、托盘菜单、角色面板、滑词操作条和截图窗口使用同一项主题选择。\r
\r
## 使用方式\r
\r
在 WebGUI 的“设置”页选择：\r
\r
- **跟随系统**：浏览器和 Windows 当前使用浅色或深色时，RabiRoute 随之切换。\r
- **浅色**：始终使用浅色界面。\r
- **深色**：始终使用深色界面。\r
\r
保存后，当前 WebGUI 立即切换；托盘会在下一次设置刷新时切换，通常不超过十秒；重启托盘也会读取已保存的选择。\r
\r
## 唯一设置来源\r
\r
主题属于主机级桌面设置，保存在 \`data/desktop/settings.json\`：\r
\r
\`\`\`json\r
{\r
  "theme": "system"\r
}\r
\`\`\`\r
\r
允许值为 \`system\`、\`light\`、\`dark\`，缺失或无效值按 \`system\` 处理。Manager 的 \`GET\` 和 \`PATCH /api/desktop/settings\` 是 WebGUI 与 Windows 托盘的共同接口。浏览器本地存储、托盘私有文件和单个窗口状态都不能成为第二份主题设置。\r
\r
## 模块分工\r
\r
| 模块 | 负责内容 |\r
| --- | --- |\r
| \`src/shared/desktopSettingsContract.ts\` | 主题值、默认值和输入校验。 |\r
| Manager | 读写主机设置并通过 \`/api/desktop/settings\` 返回。 |\r
| WebGUI | 从 \`ribiwebgui/src/themes/light/\` 或 \`ribiwebgui/src/themes/dark/\` 读取 CSS token 和 Vuetify 色板；在“跟随系统”时监听浏览器系统颜色变化。 |\r
| Windows 托盘 | 从 \`desktop/tray-task-window/rabiroute_tray/themes/light/\` 或 \`desktop/tray-task-window/rabiroute_tray/themes/dark/\` 读取调色板和菜单样式，并在刷新时更新 Qt 应用、角色面板、滑词操作条和截图窗口。 |\r
\r
主题只决定表现颜色和系统颜色偏好，不改变路由、消息、计划、权限或数据处理规则。\r
\r
## 验证\r
\r
1. 修改主题后刷新 WebGUI，主题选择仍然保留。\r
2. 打开托盘菜单和角色面板，背景、文字、边框、按钮与 WebGUI 使用相同的浅色或深色模式。\r
3. 在开启滑词菜单与截图功能后，操作条和截图窗口随托盘主题切换。\r
4. 选择“跟随系统”后，切换系统颜色模式并确认 WebGUI 与托盘都更新。\r
`,ye=`<!-- docs-language-switch -->\r
<div align="center">\r
  <a href="./interface-theme.md">Simplified Chinese</a> | English\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Interface theme\r
\r
**Current guide.** The Settings page, WebGUI, tray menus, role panel, selected-text action bar, and screenshot windows use the same theme choice.\r
\r
## Use it\r
\r
Choose one option on the WebGUI **Settings** page:\r
\r
- **Follow system**: RabiRoute follows the current light or dark appearance of the browser and Windows.\r
- **Light**: always use the light interface.\r
- **Dark**: always use the dark interface.\r
\r
The current WebGUI changes immediately after saving. The tray changes on its next settings refresh, usually within ten seconds, and also reads the saved choice on restart.\r
\r
## Single source of truth\r
\r
The theme is a host-level desktop setting stored in \`data/desktop/settings.json\`:\r
\r
\`\`\`json\r
{\r
  "theme": "system"\r
}\r
\`\`\`\r
\r
The allowed values are \`system\`, \`light\`, and \`dark\`. A missing or invalid value becomes \`system\`. Manager's \`GET\` and \`PATCH /api/desktop/settings\` are the common interface for WebGUI and the Windows tray. Browser local storage, tray-private files, and individual window state must not become a second theme setting.\r
\r
## Module responsibilities\r
\r
| Module | Responsibility |\r
| --- | --- |\r
| \`src/shared/desktopSettingsContract.ts\` | Theme values, default value, and input validation. |\r
| Manager | Read and write the host setting, and return it through \`/api/desktop/settings\`. |\r
| WebGUI | Load CSS tokens and the Vuetify palette from \`ribiwebgui/src/themes/light/\` or \`ribiwebgui/src/themes/dark/\`, and observe browser system-color changes for Follow system. |\r
| Windows tray | Load its palette and menu stylesheet from \`desktop/tray-task-window/rabiroute_tray/themes/light/\` or \`desktop/tray-task-window/rabiroute_tray/themes/dark/\`, then update the Qt application, role panel, selected-text action bar, and screenshot windows during refresh. |\r
\r
The theme controls appearance colors and system color preference only. It does not change routing, messages, plans, permissions, or data handling.\r
\r
## Verification\r
\r
1. Change the theme, refresh WebGUI, and confirm the choice remains.\r
2. Open the tray menu and role panel. Their background, text, borders, and buttons use the same light or dark mode as WebGUI.\r
3. Enable the selected-text menu and screenshot feature. Their action bar and screenshot windows change with the tray theme.\r
4. Choose Follow system, switch the system color mode, and confirm that both WebGUI and tray update.\r
`,ve=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./operations-and-troubleshooting_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 运行、日志与排障\r
\r
排障时不要把“消息没回复”当成一个整体问题。沿着消息链逐段确认，就能判断故障在平台、规则、投递还是回传。\r
\r
\`\`\`text\r
消息端 -> 事件记录 -> 规则命中 -> AgentPacket -> 处理端 -> Outbox / 外部平台\r
\`\`\`\r
\r
## 先看诊断摘要\r
\r
打开“日志诊断”。“诊断摘要”会把当前能识别的连接和配置断点放在最前面。\r
\r
摘要显示“链路正常”只表示没有发现已知断点。如果消息仍未到达，继续检查下方连接详情和最近日志。\r
\r
![日志诊断页先显示诊断摘要，再显示运行状态、消息端和处理端状态](../../assets/screenshots/webgui-diagnostics-zh.png)\r
\r
图中的文档示例没有启动，也没有绑定真实 Desktop 任务，因此状态卡明确显示“禁用中”和“未绑定”。排障时应先处理这类可见断点，再查看更下方的连接详情和最近日志。\r
\r
## 用证据判断停在哪一段\r
\r
| 已有证据 | 说明 | 下一步 |\r
| --- | --- | --- |\r
| 没有消息记录 | 事件没有进入 RabiRoute | 查平台登录、连接、端口和输入 policy |\r
| 有消息记录，没有 \`agent-packets.jsonl\` | 消息进入但规则没命中 | 查人格绑定、\`configName\`、route kind 和 regex |\r
| 有 AgentPacket，Desktop 没消息 | 处理端投递失败 | 查任务 ID、工作目录、Desktop IPC 和最后错误 |\r
| Desktop 有结果，平台没回复 | 回传没有完成 | 查 replyContext、pipeline、输出 policy 和 Outbox 日志 |\r
| Outbox 为 \`blocked\` | policy 或目标不允许外发 | 修正明确目标或授权，不要绕过安全门 |\r
| Outbox 为 \`failed\` | 已尝试发送但平台调用失败 | 修复平台状态后明确重试 |\r
\r
常见运行文件位于 \`data/route/<配置名>/\`。不要把运行期 JSONL、真实消息和账号信息提交到仓库。\r
\r
## 手动触发的用途与副作用\r
\r
“手动触发”可以执行 \`manual_trigger\` 或 \`heartbeat\` 规则，用来验证规则到处理端的链路。\r
\r
它会：\r
\r
- 写手动触发和路由日志。\r
- 构造真实 AgentPacket。\r
- 向处理端开始真实投递。\r
- 在处理端执行时使用该任务自己的权限。\r
\r
它不会模拟外部 QQ 消息，也不是无副作用预览。验证群消息 regex 时，仍要使用受控的真实测试消息或检查 RouteDecision 证据。\r
\r
## 最近日志怎么看\r
\r
“最近日志”显示当前 Route 的最近 gateway 输出。先找最新时间，再看第一条错误，不要被旧启动周期的历史错误误导。\r
\r
\r
升级代码后如果仍看到旧行为，重新构建并重启 Manager 与 Route，再核对启动目录和 \`dist/\` 时间。历史日志可以保留，但不能代表本次运行状态。\r
\r
## NapCat 打开后显示 Unauthorized 或 Token 登录页\r
\r
从 Route 页点击“打开 NapCat”时，RabiRoute 会直接打开带当前 WebUI token 的 \`/web_login\` 地址。这个入口会重新建立 WebUI 会话，避免 NapCat 重启后旧标签页残留的凭据继续触发 \`Unauthorized\`。\r
\r
如果仍停在空 Token 登录页，先关闭旧 NapCat 标签页，再从当前 QQ 实例卡片重新点击“打开 NapCat”。确认实例卡片已保存 WebUI 登录密钥；升级过源码但仍打开旧地址时，需要重新构建并重启 Manager。快速启动只检查 OneBot / WebUI 是否可用，不再同步等待 Windows 全量进程枚举；完整进程列表仍可在显式健康检查和详情中读取。\r
\r
## NapCat 已连接但没有 AgentPacket\r
\r
先确认 \`group-messages.jsonl\` 或 \`private-messages.jsonl\` 是否出现新记录。\r
\r
- 没有记录：查 QQ 登录、WebSocket Client、端口和接收 policy。\r
- 有记录：查人格规则的 \`configName\`、route kind、目标群和 regex。\r
- 合并转发只有 ID：查 OneBot HTTP 和 \`get_forward_msg\`。\r
\r
## NapCat 能收不能发\r
\r
OneBot HTTP 可访问不代表 QQ 核心一定能发送。检查登录状态、quick login、设备验证、Windows 时间和 NapCat 日志。\r
\r
## 消息端扫描超时或显示“部分可用”\r
\r
\`GET /api/scan/message-adapters\` 是纯只读诊断：不会启动 Route/NapCat、不会补写配置、不会触发扫码或自动修复。所有独立探针并行起跑并受共享截止时间约束；响应中的 \`scan.partial=true\` 表示至少一个探针超时或失败，其他已完成结果仍然可信。\r
\r
状态按入口和实例分别解释。\`QQ 可用\` 以 OneBot 健康为准，不能用 WebUI 可打开替代；个人微信未登录只影响个人微信。Watchdog 中单一消息端的错误汇总为 \`degraded\`，只有 Manager、Route 或 Agent 投递等系统级错误才把整轮巡检标为 \`error\`。\r
\r
Outbox 发送失败会保留 \`failed\` 和 draft 数据。当前没有通用自动重试队列；修复登录后需要明确重试，避免重复发送。\r
\r
## Codex 没收到消息\r
\r
按顺序检查：\r
\r
1. Desktop 已打开并能进入目标任务。\r
2. Agent 扫描能看到该任务和工作目录。\r
3. 保存的任务 ID 仍存在，目录没有移动。\r
4. 日志诊断显示投递协议为 \`desktop-ipc\`。\r
5. \`no-client-found\` 自动唤醒后是否仍失败。\r
\r
不要用固定 4510、\`CODEX_APP_SERVER_WS_URL\` 或独立 stdio Runtime 修复真实投递；这些不是当前主链。\r
\r
## RabiRoute Desktop 界面未显示\r
\r
从 \`Start-RabiRoute-Desktop.bat\` 或打包版 RabiRoute Desktop 启动的完整桌面运行态，会在 \`data/runtime/desktop-lifecycle-intent.json\` 记录 \`running\`，并启动工作区唯一的 \`watch-rabiroute-desktop-lifecycle.ps1\`。监督器只检查本项目本机后端 \`/meta\` 和桌面界面进程；\`/meta\` 连续两次失败后，即使旧 Manager 进程仍存在，也会通过原启动器的端口 owner、PID 和单实例门禁恢复完整运行态。界面遇到本机后端暂时离线时会保留入口并继续重连。\r
\r
先重新运行一次 \`Start-RabiRoute-Desktop.bat -NoOpen\`。然后检查 \`data/route/default-main/logs/desktop-lifecycle-supervisor.jsonl\`：正常记录应同时满足 \`desiredState=running\`、\`managerConnected=true\`、\`desktopShellCount>0\`。\`managerFailureCount\` 是连续 \`/meta\` 失败次数，\`managerProbeError\` 是最近一次探测错误。\`desiredState=stopped\` 表示上次由用户明确退出，应手动重新启动；文件缺失或损坏时监督器也会失败关闭，不会自行猜测。不要用半小时业务健康巡检替代这个轻量监督器，也不要单独循环拉起桌面界面。\r
\r
RabiRoute Desktop 菜单的 \`退出 RabiRoute\` 会先把意图写成 \`stopped\` 再关闭本机后端和桌面界面，因此监督器不会反向复活。普通 Manager 构建重载、安装升级和 \`SIGTERM\` 不修改桌面意图；如果桌面仍标记 \`running\`，监督器会在重载后恢复完整运行态。\r
\r
页面切换后如果内容在 12 秒内没有加载出来，RibiWebGUI 会显示“页面加载失败”。点击“重试当前页面”会重新打开相同路径和访问参数。旧页面资源失效时，界面会先自动刷新一次；仍失败再手动重试。\r
\r
## 8790 被旧 Manager 占用\r
\r
如果启动器提示 \`8790\` 已监听，但 \`/meta\` 没有稳定响应，常见原因是同一项目的旧 Manager 仍占着端口。远程页面反复断线重连、Relay 或 SSE 异常不应该成为本地启动依赖；当前实现会让 Manager 先提供本机/局域网 WebGUI，再异步热连 Relay。\r
\r
重新运行 \`Start-RabiRoute-Desktop.bat\`。启动器会核对端口 owner 的命令行，只对精确指向本项目 \`dist/manager.js\` 的旧实例执行有界接管：先请求优雅关闭，超时后才终止已核实的进程树。未知进程不会被停止。如果当前 \`dist\` 比健康运行实例更新，启动器也会重载当前构建。\r
\r
Manager 自身还会在加载控制面前取得工作区级实例锁。若第二条启动链返回退出码 \`17\`，说明已有同工作区 Manager 持有有效锁；不要反复拉起。先用 \`/meta\` 和端口 owner 确认现有实例，只有锁中 PID 已不存在时，下一次启动才会安全回收陈旧锁。\r
\r
恢复后分别验证：本机或局域网 \`/meta\` 可用；Relay 状态可在稍后恢复为在线；远程 \`/api/events\` 与 \`/api/speech/events\` 可重连；媒体 \`Range\` 请求仍返回 \`206\`。Relay 暂时离线时，本机和局域网仍应可用，不需要反复重启 Manager。\r
\r
远程 WebGUI 无法联系对应 PC Manager 时，API 会返回结构化 \`RABI_PC_WEBGUI_UNAVAILABLE\`，等待超时则返回 \`RABI_PC_WEBGUI_TIMEOUT\`；响应同时包含 \`retryable\`、\`Retry-After\` 和诊断请求 ID。浏览器页面会显示相同诊断 ID，而不是空白或静默 502。用该 ID 对照 Relay 日志，再检查 PC 的 \`/meta\` 与 Manager 日志；不要把 502 当成成功或立即重复写请求。\r
\r
如果计划页提交审批意见时正好遇到 Manager 重启或短暂断网，页面会明确提示无法连接，并保留本次文字、附件和同一条幂等 \`feedbackId\`。先确认页面右上角恢复为“Manager 已连接”或 \`/meta\` 已响应，再直接重试；不要因为看到旧版浏览器错误 \`Failed to fetch\` 而重新输入或重复创建另一条审批意见。\r
\r
## 何时重启\r
\r
适合重启的情况：\r
\r
- 刚完成新构建。\r
- 外部端口或连接配置变化。\r
- Route 子进程退出。\r
- 日志证明运行的是旧产物。\r
\r
规则、人格或普通表单改动应先保存。不要把重启当成保存，也不要在没有证据时反复重启外部平台。\r
\r
## 反馈问题前准备\r
\r
收集这些信息即可，不要上传整个运行目录：\r
\r
- RabiRoute 版本和启动方式。\r
- 操作系统、Node.js 版本。\r
- Route 使用的消息端与处理端。\r
- 复现步骤和预期结果。\r
- 本次启动后的最小相关日志。\r
- 已脱敏的状态截图。\r
\r
更多模板见[常见问题与获得帮助](faq-and-support.md)。\r
`,we=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./operations-and-troubleshooting.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Operations, logs, and troubleshooting\r
\r
Do not treat “no reply” as one indivisible problem. Follow the message path and identify whether the break is at the platform, rule, handler delivery, or output stage.\r
\r
\`\`\`text\r
Message adapter -> event record -> rule match -> AgentPacket -> handler -> Outbox / platform\r
\`\`\`\r
\r
## Start with Diagnosis Summary\r
\r
Open **Log Diagnostics**. **Diagnosis Summary** places known connection and configuration breaks first.\r
\r
\`Path healthy\` only means no known break was detected. If delivery still fails, continue through connection details and recent logs.\r
\r
![Log diagnostics showing the diagnosis summary before runtime, message-input, and handler states](../../assets/screenshots/webgui-diagnostics-en.png)\r
\r
The documentation sample is not running and is not bound to a real Desktop task, so its cards clearly show **Disabled** and **Not bound**. Fix visible breaks like these before moving to the connection details and recent logs below.\r
\r
## Locate the break with evidence\r
\r
| Evidence | Meaning | Next check |\r
| --- | --- | --- |\r
| No message record | The event did not enter RabiRoute | Platform login, connection, port, input policy |\r
| Message record, no \`agent-packets.jsonl\` | Input worked but no rule matched | Persona, \`configName\`, Route kind, regex |\r
| AgentPacket exists, no Desktop message | Handler delivery failed | Task ID, workspace, Desktop IPC, last error |\r
| Desktop result, no platform reply | Output did not complete | Reply context, pipeline, output policy, Outbox log |\r
| Outbox is \`blocked\` | Policy or target denied output | Correct the target or permission; do not bypass the gate |\r
| Outbox is \`failed\` | A platform send was attempted and failed | Repair platform state, then retry explicitly |\r
\r
Common runtime files live under \`data/route/<configName>/\`. Do not commit runtime JSONL, real messages, or account data.\r
\r
## Manual-trigger effects\r
\r
**Manual trigger** can execute \`manual_trigger\` or \`heartbeat\` rules to validate the rule-to-handler path.\r
\r
It will:\r
\r
- write manual-trigger and routing logs;\r
- construct a real AgentPacket;\r
- perform a real handler delivery;\r
- use the target task's own permissions during execution.\r
\r
It does not simulate an external QQ event and is not a side-effect-free preview. Validate a group regex with a controlled real message or RouteDecision evidence.\r
\r
## Read recent logs\r
\r
**Recent logs** shows the current Route's latest gateway output. Find the newest time boundary and the first error in that run; do not let a historical startup error mislead you.\r
\r
\r
After an upgrade, rebuild and restart the Manager and Route, then verify the startup directory and \`dist/\` timestamp. Historical logs can remain for audit but do not define current state.\r
\r
## NapCat opens with Unauthorized or an empty token login\r
\r
When **Open NapCat** is clicked from a Route, RabiRoute now opens the token-bearing \`/web_login\` URL directly. This creates a fresh WebUI session instead of letting credentials left in an old tab continue to produce \`Unauthorized\` after a NapCat restart.\r
\r
If the token field is still empty, close the old NapCat tab and click **Open NapCat** again from the current QQ instance card. Confirm that the instance has a saved WebUI access token. If source code was upgraded but the old URL still opens, rebuild and restart Manager. The fast startup path checks OneBot and WebUI readiness without synchronously enumerating every Windows process; the full process list remains available through explicit health checks and details.\r
\r
## NapCat connected but no AgentPacket\r
\r
First check for a new \`group-messages.jsonl\` or \`private-messages.jsonl\` record.\r
\r
- No record: check QQ login, WebSocket Client, port, and input policy.\r
- Record exists: check persona \`configName\`, Route kind, target group, and regex.\r
- Forwarded message contains only an ID: check OneBot HTTP and \`get_forward_msg\`.\r
\r
## NapCat receives but cannot send\r
\r
Reachable OneBot HTTP does not prove that the QQ core can send. Check login, quick login, device verification, Windows time, and NapCat logs.\r
\r
## Message-endpoint scan times out or reports partial availability\r
\r
\`GET /api/scan/message-adapters\` is a strictly read-only diagnostic. It does not start a Route or NapCat, write configuration, trigger QR login, or run automatic repair. Independent probes start concurrently under one shared deadline. \`scan.partial=true\` means at least one probe timed out or failed; completed results from the other endpoints remain available.\r
\r
Interpret state per endpoint and per instance. \`QQ available\` requires OneBot health and cannot be inferred from a reachable WebUI. A logged-out personal-Weixin adapter affects only personal Weixin. The watchdog summarizes a single endpoint error as \`degraded\`; only system-level Manager, Route, or Agent-delivery errors make the whole patrol \`error\`.\r
\r
A failed Outbox attempt retains \`failed\` and draft data. There is no generic automatic retry queue; repair login, then retry intentionally to avoid duplicates.\r
\r
## Codex receives nothing\r
\r
Check in order:\r
\r
1. Desktop is open and can enter the target task.\r
2. Agent scan sees that task and workspace.\r
3. The saved task ID exists and the workspace has not moved.\r
4. Log Diagnostics reports \`desktop-ipc\`.\r
5. A \`no-client-found\` wake-and-retry still fails.\r
\r
Do not use fixed port 4510, \`CODEX_APP_SERVER_WS_URL\`, or a separate stdio Runtime for real delivery. They are not the current transport.\r
\r
## RabiRoute Desktop UI is missing\r
\r
A full desktop runtime launched by \`Start-RabiRoute-Desktop.bat\` or packaged RabiRoute Desktop records \`running\` in \`data/runtime/desktop-lifecycle-intent.json\` and starts one \`watch-rabiroute-desktop-lifecycle.ps1\` owner per workspace. The supervisor checks only this project's local backend \`/meta\` and desktop UI process. After two consecutive \`/meta\` failures, it restores the complete desktop runtime through the original launcher's port-owner, PID, and single-instance gates even if an old Manager process still exists. The UI stays available and reconnects during a temporary local-backend outage.\r
\r
Run \`Start-RabiRoute-Desktop.bat -NoOpen\` once, then inspect \`data/route/default-main/logs/desktop-lifecycle-supervisor.jsonl\`. A healthy record has \`desiredState=running\`, \`managerConnected=true\`, and \`desktopShellCount>0\`. \`managerFailureCount\` is the consecutive \`/meta\` failure count, and \`managerProbeError\` records the latest probe error. \`desiredState=stopped\` means the previous exit was intentional and requires an explicit user start. Missing or malformed intent fails closed. Do not substitute the half-hour business-health patrol for this lightweight owner or create a separate desktop-UI relaunch loop.\r
\r
\`Exit RabiRoute\` from the RabiRoute Desktop menu persists \`stopped\` before shutting down the local backend and desktop UI, so supervision cannot undo a deliberate exit. Ordinary Manager build reloads, installer upgrades, and \`SIGTERM\` preserve desktop intent; when it remains \`running\`, supervision restores the complete desktop runtime after the reload.\r
\r
If a page does not load within 12 seconds after navigation, RibiWebGUI shows Page failed to load. Retry this page opens the same path with its access parameters preserved. For stale page assets, the UI first reloads once automatically; use the button if that does not restore the page.\r
\r
## Port 8790 held by a stale Manager\r
\r
If the launcher reports a listener on port \`8790\` but \`/meta\` is not stably responsive, a stale Manager from the same project may still own the port. Remote-page reconnects, Relay outages, and SSE failures must not become local startup dependencies: Manager serves local/LAN WebGUI first and hot-connects to Relay asynchronously.\r
\r
Run \`Start-RabiRoute-Desktop.bat\` again. The launcher inspects the port owner's command line and performs bounded takeover only for an old process that precisely references this project's \`dist/manager.js\`: graceful shutdown first, then the verified process tree only after timeout. Unknown processes remain untouched. The launcher also reloads a healthy Manager when the current \`dist\` is newer than the running process.\r
\r
Manager also acquires a workspace-level instance lock before loading its control plane. Exit code \`17\` from a second startup path means a live Manager for that workspace still owns the lock; do not keep relaunching it. Check \`/meta\` and the port owner first. A later start reclaims the lock only after its recorded PID no longer exists.\r
\r
After recovery, verify separately that local or LAN \`/meta\` responds, Relay can become online later, remote \`/api/events\` and \`/api/speech/events\` reconnect, and media Range requests still return \`206\`. Local and LAN access should remain available while Relay is offline, without repeated Manager restarts.\r
\r
When remote WebGUI cannot reach the selected PC Manager, API callers receive structured \`RABI_PC_WEBGUI_UNAVAILABLE\`; a response deadline returns \`RABI_PC_WEBGUI_TIMEOUT\`. Both include \`retryable\`, \`Retry-After\`, and a diagnostic request ID. Browser navigation shows the same ID instead of a blank or silent 502. Correlate that ID with Relay logs, then check the PC \`/meta\` endpoint and Manager logs; do not treat the 502 as success or blindly repeat a write request.\r
\r
If plan approval submission coincides with a Manager restart or a temporary network interruption, the page now reports the connection problem explicitly and preserves the feedback text, attachments, and the same idempotent \`feedbackId\`. Wait until the header shows \`Manager connected\` or \`/meta\` responds, then retry directly. Do not retype the feedback or create another approval entry because an older build displayed the raw browser error \`Failed to fetch\`.\r
\r
## When to restart\r
\r
Restart when:\r
\r
- a new build completed;\r
- an external port or connection changed;\r
- the Route child process exited;\r
- logs prove an old build is still running.\r
\r
Save rule, persona, and form changes first. Restart is not Save, and repeated external-platform restarts without evidence hide the real break.\r
\r
## Prepare a useful report\r
\r
Collect only:\r
\r
- RabiRoute version and startup method;\r
- operating system and Node.js version;\r
- Route message adapter and handler;\r
- reproduction steps and expected result;\r
- minimal logs after the current startup;\r
- sanitized status screenshots.\r
\r
See [FAQ and support](faq-and-support_en.md) for a report template.\r
`,ke=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./personas-and-rules_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 人格与消息规则\r
\r
Route 决定消息怎么进入和投给哪个处理端；人格决定处理端以什么身份、背景和判断框架理解消息。两者分开保存，也可以独立复用。\r
\r
## Route 和人格的边界\r
\r
| 内容 | 归属 |\r
| --- | --- |\r
| 消息端、端口、处理端、工作目录、pipeline | Route |\r
| 指向哪个人格 | Route 的 \`agentRoleId\` |\r
| 人格头像、正文、规则、计划、记忆和技能 | 人格目录 |\r
| 规则服务哪条 Route | 规则中的 \`configName\` |\r
\r
一个人格可以服务多条 Route。修改人格正文或规则会影响所有绑定到它、且命中对应 \`configName\` 的 Route。\r
\r
## 配置人格\r
\r
打开“人格配置”，在“指向人格”中选择已有角色。页面会显示 \`persona.md\` 预览、路由变量和人格自动化。\r
\r
选择人格后，可以在同一张配置卡中设置或更换头像。支持 PNG、JPEG、WebP、GIF，单文件上限 5 MB。头像会跟随人格显示在选择器、Route 总览、语音人格选择和本地角色面板；没有头像时显示人格 ID 首字。头像属于人格目录，不需要为每条 Route 重复上传。\r
\r
如果需要编辑完整正文，点击“打开人格配置”。运行语义文件不应机械翻译；改变语言、措辞和约束可能改变 Agent 行为。\r
\r
## 让人格互相联系\r
\r
开启相关 Route 后，Agent 可以查询当前有哪些人格可以接收消息，再向另一个人格单向投递。你不需要把对方复制成自己的规则，也不需要新增一种网络消息端。RabiRoute 会校验消息确实来自当前 Route 绑定的人格，并在目标处理端接收后才显示发送成功。\r
\r
目标人格的普通回复不会自动回到来源人格。需要答复时，它必须明确再发一条跨人格消息；系统会保留同一段联系的会话关联，并限制连续互投次数。网络超时后，Agent 会先按原投递编号查询结果，不能换新编号盲目重发，因此不会因为一次响应丢失就重复创建目标任务。\r
\r
界面和用户文档统一称“人格”。\`roleId\`、\`/api/roles/*\` 和 \`data/roles/\` 是为兼容现有配置保留的内部名称，不要求迁移目录。\r
\r
## 在多台电脑间同步当前人格\r
\r
选择人格后，点击页面顶部的“多电脑人格同步”，会打开独立的人格文件夹同步窗口。先从左侧选择使用同一个 RabiLink 应用 token 的电脑，右侧 Changed Files 会只读显示哪些文件将拉取、推送、删除、自动合并或需要确认；比较本身不会修改文件，点击“拉取并同步”后才执行同步。自动同步在后端运行，不要求一直打开页面：本机人格文件变化、其它 PC 上下线或 Relay 重连会触发一次 manifest 对账，优先走局域网，局域网不可达才经 Relay 受限中转。未完成的对账范围会保存到本机，断网和 Manager 重启不会把它忘掉；目标离线时等待连接事件，不按固定间隔查询业务数据。\r
\r
页面可以查看自动对账状态，也可以点击“同步当前人格”立即执行。同步结果会区分拉取、推送、已一致、LAN/Relay 和冲突数量。普通文件双方都修改、删除与编辑并发时不会按最后写入者覆盖，而是进入“需要人工确认”：\r
\r
- **保留本机**：保留当前文件，并尝试把这个决定发布回来源 PC。\r
- **采用对方版本 / 采用对方删除**：明确接受远端内容或删除意图。\r
- **手工合并**：让本机 Agent 使用 \`use_merged\` API 提交已经审阅的正文。\r
\r
语音账号归类的并发分支不在文件冲突窗口猜测谁是用户；回到下方“身份关系”中的语音消息端账号再次确认，新的归类事件会显式收敛分支。Relay 只负责发现和中转，不保存服务器端主人格；同步也不能替代独立备份或 Git/SVN。\r
\r
## 认识联系人和整理不同账号\r
\r
选择人格后，“身份定位”分成两个卡片：\r
\r
- **已识别身份**按人整理。一个人的名字、QQ、微信、声纹和其它已经确认的账号放在同一张人物卡中。点击整张人物卡，会打开统一的身份详情；基本信息、消息端账号、说话习惯和关系都在这里查看和编辑，不再通过三点菜单分别进入不同弹窗。\r
- **未识别身份**按 QQ、微信、声纹等消息端整理。账号还不知道对应谁、候选尚未指向已识别人物或证据存在冲突时，都会留在这里，不按同名昵称自动合并。\r
\r
身份详情中的“关系”统一记录这个人与其他人、组织或项目的关系，不再分成长期关系和短期关系。当前消息里“谁提出了方案、谁正在回复谁”等临时角色由系统自动生成的情景记录表示，不需要手工建立另一类关系。基本信息和说话习惯一起保存；账号和关系分别在各自区域保存，因此一次失败不会让页面误报为全部写入成功。\r
\r
当消息端能够提供不会随昵称变化的账号标识，而且消息命中当前人格的消息规则时，陌生账号会自动出现为“待认识”候选。这一步只说明“以后可以继续积累这个账号的线索”，不说明系统已经知道对方是谁。确认后，账号才会进入对应的人物卡。\r
\r
一个人自报姓名、别人转述、临时昵称，以及词汇、句式或回复节奏长期相似，都可以帮助核对候选，但不能单独确认身份。如果身份说法只出现在转发、引用或附件文字里，或者消息端无法提供稳定账号标识，系统会继续显示未识别，不会自动关联到现有人物。\r
\r
同一个账号可能由多人使用。已知使用者范围时，应把账号同时关联到这些人的身份卡并标记“共用”；这只说明谁可能使用该账号，不说明当前这一条是谁发的。系统需要结合明确自称、回复链、正在延续的事情和说话习惯一致性判断本条消息，并保留置信度；不要因为其中一人最近说得更多，就把整个账号永久归给他。纠正身份时应保留真实账号，把由昵称误建的人物关联标记为不再使用，这样历史记录仍然可追溯。\r
\r
## 在身份定位中归类语音账号\r
\r
选择人格后，“身份定位”会把 QQ、企业微信等文字账号和“语音消息端账号”放在同一区域。每个“处理主机 + 声纹 ID”相当于一条语音账号；同一段多人录音可以同时关联多个账号。语音区域会显示最近 24 小时的归类覆盖率、我的发言、其他人、未判断/冲突分段，以及当前人格已经保存的语音账号归类。这里的“这是我”只代表当前人格对该处理主机声纹的明确解释；RabiSpeech 和 RabiRoute 主机不会替人格判断谁是谁，也不会默认把任何声纹设为用户。\r
\r
对未解决声纹可以选择：\r
\r
- **这是我**：把当前 \`sourceHostId + voiceprintId\` 关系记为当前人格认定的用户。\r
- **其他人**：明确记为非用户。\r
- **清除判断**：保留语音账号归类事件，但取消 \`isUser\` 结论，重新回到未判断状态。\r
\r
页面只请求统计、声纹缩写、时长、最后出现时间和关系，不请求或显示转写正文。新录音、本机关系修正和多电脑人格同步都通过事件触发一次刷新；事件流断线重连后会补查一次，不会固定间隔轮询覆盖率。当前版本继续使用人格自己的 \`voice/voice-identities.jsonl\` 保存既有语音归类数据，并在“身份关系”页面中统一呈现；后续统一身份数据时应提供兼容迁移，不能让旧归类消失。多电脑冲突会明确显示，后续再次确认可收敛冲突分支。\r
\r
第一次使用时，如果不透明声纹 ID 无法辨认，点击“标记下一段”，然后用准备归类的电脑、手机或眼镜，在尽量安静的环境里只让本人连续说一句。下一次录音事件完成后，本次新出现的未归类声纹会移到列表前面并标记“本次出现”。这个流程只是帮助缩小候选：它不会启动第二套录音、不会自动认人，也不会因为只出现一个候选就直接设为用户；如果现场同时有人说话，应只确认能够确定属于本人的声纹，或者重新捕获。\r
\r
## 人格自动化怎样组成\r
\r
每条规则只回答两个问题：什么时候触发，以及触发后做什么。\r
\r
触发方式有两种：\r
\r
- **收到消息时**：选择一个或多个消息来源，还可以按消息内容、群和说话人继续筛选。\r
- **定时任务**：选择固定间隔、每天某时或一次性日期时间。\r
\r
动作也有两种：\r
\r
- **通知 Agent**：把当前消息或定时任务交给这个人格处理；可填写额外判断要求，不需要重新拼完整消息。\r
- **运行脚本**：运行当前人格 \`scripts/\` 目录内的 \`.cmd\`、\`.bat\` 或 \`.py\` 文件。\r
\r
因此，同一套规则可以表达“私聊到达后通知 Agent”“每天九点通知 Agent”“收到指定消息后运行脚本”和“每隔十分钟运行脚本”。以后新增触发来源或动作时，也不需要再增加一套独立的规则页面。\r
\r
界面把规则分为“收到消息时”和“定时任务”两个标签。消息规则再按聊天消息、语音与设备、手动与系统消息、其他来源分组。编辑时先选触发方式，再选动作；页面只显示当前选择需要的参数，减少一屏同时出现无关字段。\r
\r
## 常用路由类型\r
\r
| 类型 | 什么时候使用 |\r
| --- | --- |\r
| \`private\` | QQ 私聊 |\r
| \`direct_at\` | 群里直接 @ 当前账号 |\r
| \`direct_reply\` | 直接回复当前账号或角色参与的消息 |\r
| \`indirect_reply\` | 更宽的回复链观察，容易产生噪声 |\r
| \`group_message\` | 普通群消息，建议搭配窄正则 |\r
| \`heartbeat\` | 定时计划和手动验证 |\r
| \`manual_trigger\` | 只在用户或 API 明确触发时运行 |\r
| \`role_panel_message\` | 内置人格消息；本地角色面板与跨人格投递共用 |\r
| \`plan_feedback\` | 独立计划审批系统事件；不带最近消息 |\r
| \`voice_transcript\` | RabiRoute/RabiSpeech、本地桥接或 FenneNote 兼容转写 |\r
| \`wecom_message\` | 企业微信群消息 |\r
| \`rabilink\` | RabiLink 事件 |\r
\r
界面会按当前 Route 已添加的消息端组织可选类型。消息规则没有选择任何来源时会匹配全部收到的消息，页面会明确提示。每条规则都可以单独启停和编辑；先从私聊、直接回复或窄关键词开始，再逐步增加更宽的群消息规则。\r
\r
## 正则应该多窄\r
\r
普通群消息不要使用空正则全量转发。先从能解释业务意图的关键词开始，例如：\r
\r
\`\`\`text\r
需求|报错|构建失败|提醒|请记录\r
\`\`\`\r
\r
正则只决定是否命中，不决定最终是否回复。人格模板仍应要求处理端先看上下文，区分新事实、任务、风险、普通确认和礼貌回应。\r
\r
## 定时任务\r
\r
定时触发支持：\r
\r
- 每隔一段时间。\r
- 每天指定时间。\r
- 某一天指定时间。\r
\r
定时任务需要当前 Route 启用“定时任务”入口。通知 Agent 时，事件只携带当前任务、人格/计划/记忆索引和必要路径，不自动输入聊天历史。脚本动作直接进入本机脚本执行器，不经过 Agent。\r
\r
## 运行脚本前的限制\r
\r
脚本默认不能运行。必须在当前 Route 明确打开“允许当前 Route 运行人格脚本”；这个权限只留在本机，不会随人格同步到其它电脑。\r
\r
- 脚本必须位于当前人格的 \`scripts/\` 目录，符号链接或 \`..\` 不能越过该目录。\r
- 只支持 \`.cmd\`、\`.bat\` 和 \`.py\`，不接受任意命令文本。\r
- Manager 的 token、密码和消息正文不会作为环境变量传给脚本。\r
- 同一 Route 的同一规则不会重叠执行；超时后会停止对应进程树。\r
- 脚本执行与 Agent 投递分别记结果，任何一方成功都不会代替另一方成功。\r
\r
脚本路径在界面中填写相对于人格 \`scripts/\` 目录的位置，例如 \`daily-check.py\` 或 \`tools/check.cmd\`。参数每行一个。先在测试人格和无破坏性的脚本上验证，再用于会修改文件或调用外部系统的任务。\r
\r
## 模板写什么\r
\r
模板适合补充“如何判断”，不需要重复拼完整消息。RabiRoute 已经注入事件、人格路径、日志路径、知识索引和回复上下文；普通消息端还会按额度注入最近消息，Heartbeat 不会。\r
\r
工作型模板可以简短写成：\r
\r
\`\`\`text\r
先判断消息是信息、问题、任务、风险还是决策。\r
只有出现新增事实、阻塞或待办变化时才推进动作。\r
需要向外部消息端发送时，使用注入的 RabiRoute 发送模板，确认渠道和目标参数后再提交。\r
\`\`\`\r
\r
绑定人格的 AgentPacket 还会自动附加“本轮工作契约”：区分事实、推断、未知和待用户完成的最小一步；只推进一个可验证动作；没有新价值时保持安静；外部动作继续遵守 Action Gate。人格模板只补充当前入口的判断重点，不要重复这段公共收口。\r
\r
RabiLink 的固定线程主动审阅另有一层连续反思模板：它会先读取当前账本及其历史索引，再按需恢复计划、记忆和最近工具结果。角色目录若提供 \`prompts/rabilink-proactive-review.md\`，优先使用它；否则回退到 \`prompts/proactive-review.md\`。反思入口可以在用户明确允许、且角色目录提供有界工具时，每轮短时读取一帧屏幕、一帧摄像头和已经运行的本机语音摘要；原始材料只在本轮查看，随后删除并核对清理，不写入记忆、日记或外发消息。没有新记录不等于用户不在场，取证失败也只能降低证据置信度，不能冒充“没有变化”。\r
\r
不要只靠自然语言模板授予外部发送权限。实际发送仍受消息端发送策略控制，来源聊天记录也不会自动成为目标。\r
\r
## 保存与验证\r
\r
完成规则编辑后关闭对话框，再点击顶栏“保存配置”。下一条消息或下一次定时触发时生效。旧版消息模板规则会自动显示在新界面中；保存后，人格配置会改写为新的 \`automationRules\` 结构。\r
\r
当前 WebGUI 没有无副作用的 RouteDecision / AgentPacket 预览。验证规则请使用日志诊断的手动触发，并明确知道它会进入真实投递链。\r
\r
## 接下来阅读\r
\r
- 验证规则和投递：[运行、日志与排障](operations-and-troubleshooting.md)。\r
- 理解回传权限：[安全、回传与数据](safety-and-data.md)。\r
`,Re=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./personas-and-rules.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Personas and message rules\r
\r
A Route decides how messages enter and which handler receives them. A persona supplies identity, background, and decision guidance. They are stored separately and can be reused independently.\r
\r
## Route and persona boundaries\r
\r
| Content | Owner |\r
| --- | --- |\r
| Sources, ports, handler, workspace, pipeline | Route |\r
| Selected persona | Route \`agentRoleId\` |\r
| Persona avatar, text, rules, plans, memory, skills | Persona directory |\r
| Route served by a rule | Rule \`configName\` |\r
\r
One persona can serve several Routes. Editing its text or rules affects every bound Route that matches the relevant \`configName\`.\r
\r
## Configure a persona\r
\r
Open **Persona Configuration** and select an existing role under **Persona binding**. The page shows the \`persona.md\` preview, Route variables, and persona automation.
\r
After selecting a persona, use the same configuration card to set or replace its avatar. PNG, JPEG, WebP, and GIF images up to 5 MB are supported. The avatar follows the persona into selectors, the Route overview, speech persona selection, and the local role panel; the first character of the persona ID is used as the fallback. Because the image belongs to the persona directory, it does not need to be uploaded again for each Route.\r
\r
Use **Open persona configuration** to edit the full text. Do not mechanically translate runtime-semantic files; language and wording changes can change Agent behavior.\r
\r
## Let personas contact each other\r
\r
After the relevant Routes are enabled, an Agent can discover which personas can receive messages and explicitly send a one-way message to another persona. You do not need to copy the target into local rules or add another network adapter. RabiRoute verifies that the message comes from the persona bound to the current Route and reports success only after the target handler accepts it.\r
\r
The target persona's ordinary reply does not return to the source automatically. To answer, it must explicitly send another cross-persona message. RabiRoute keeps correlation for that exchange and limits repeated back-and-forth hops. After a timeout, the Agent checks the result under the original delivery ID instead of blindly resending under a new one, preventing one lost response from creating duplicate target work.\r
\r
User-facing copy uses **persona**. Existing \`roleId\`, \`/api/roles/*\`, and \`data/roles/\` names remain compatibility internals; no directory migration is required.\r
\r
## Synchronize the current persona across PCs\r
\r
After selecting a persona, use **Multi-PC persona sync** in the page header to open a dedicated persona-folder synchronization workspace. Choose another PC using the same RabiLink application token on the left. Changed Files then shows, without writing files, what would be pulled, pushed, deleted, automatically merged, or require confirmation. Synchronization starts only after you select **Pull and synchronize**. Automatic synchronization runs in the backend and does not require the page to remain open. A local persona-file change, peer availability change, or Relay reconnection triggers one manifest reconciliation. LAN is preferred, with restricted Relay transit only when direct access is unavailable. Unfinished scope is persisted locally, so disconnects and Manager restarts do not forget it; an offline target waits for a connection event instead of fixed-interval business queries.
\r
The page shows automatic-reconciliation state, and **Sync current persona** runs it immediately. Results distinguish pull, push, already converged, LAN/Relay transport, and conflict counts. Two-sided ordinary-file edits or concurrent deletion versus editing never use last-writer-wins replacement. They enter **Human confirmation required**:\r
\r
- **Keep local** retains the current file and tries to publish that decision back to the source PC.\r
- **Use remote / Accept remote deletion** explicitly accepts the remote content or deletion intent.\r
- **Manual merge** lets the local Agent submit reviewed content through the \`use_merged\` API.\r
\r
Concurrent voice-account classification branches do not let the file-conflict dialog guess who is the user. Confirm them again under **Voice endpoint accounts** in **Identity relations** so a new classification event explicitly converges the branch. Relay performs discovery and transit only; it stores no server-side master persona. Synchronization also does not replace independent backups or Git/SVN.

## Recognize a person across endpoint accounts

After selecting a persona, **Identity positioning** is divided into two cards:

- **Recognized identities** is organized by person. One person's name and confirmed QQ, Weixin, voice, and other endpoint accounts appear on the same person card. Selecting the whole card opens one identity workspace where basic details, endpoint accounts, speaking habits, and relations can be viewed and edited without separate three-dot-menu dialogs.
- **Unrecognized identities** is organized by endpoint type. An account stays here when its people are unknown, its candidates do not yet point to recognized people, or its evidence conflicts. Matching display names do not merge accounts automatically.

The **Relations** section uses one relation model for people, organizations, and projects; it does not split records into long-term and short-term types. Temporary roles in the current message, such as who proposed an idea or who is replying to whom, remain in automatically created Situation records instead of becoming another manually maintained relation type. Basic details and speaking habits save together, while accounts and relations save inside their own sections so a partial failure is not presented as a successful all-at-once update.

When an endpoint supplies an account identifier that does not change with its display name and the message matches a rule for the current persona, an unfamiliar account appears automatically as a “getting to know” candidate. This means only that the persona can accumulate clues for the account. It does not mean RabiRoute already knows the person. The account moves to a person card only after confirmation.

A self-reported name, another person's claim, a temporary display name, or long-term consistency in vocabulary, sentence patterns, and response rhythm may help review a candidate, but none can confirm identity alone. If a claim exists only in forwarded, quoted, or attached content, or the endpoint cannot supply a stable account identifier, the system keeps the account unrecognized instead of attaching it automatically to an existing person.

Several people may use one account. Once the allowed user set is known, attach the account to every relevant person card and mark it **Shared**. This identifies who may use the account, not who wrote the current message. The system may combine explicit self-identification, reply chains, task continuity, and speaking-habit consistency for per-message attribution, while retaining confidence and uncertainty. Recent activity by one person must not turn the whole account into their permanent account. When correcting an identity, retain the real endpoint account and retire any fictional person record created from its nickname so the history remains traceable.

## Classify voice accounts under Identity positioning

After a persona is selected, **Identity positioning** presents text accounts such as QQ and WeCom together with **Voice endpoint accounts**. Each processing-host and voiceprint-ID pair is one voice account, and a recording with several speakers may reference several accounts. The voice section shows the latest 24-hour classification coverage, speech attributed to the user, speech attributed to other people, unknown/conflicting segments, and relationships already stored by this persona. **This is me** is only the current persona's explicit interpretation of a voiceprint on its processing host. Neither RabiSpeech nor the RabiRoute host decides who a person is or assigns any voiceprint to the user by default.
\r
For an unresolved voiceprint, choose:\r
\r
- **This is me**: mark the current \`sourceHostId + voiceprintId\` relationship as the user according to this persona.\r
- **Another person**: explicitly mark it as not the user.\r
- **Clear decision**: retain the relationship event while removing the \`isUser\` conclusion, returning it to unknown.\r
\r
The page requests only statistics, abbreviated voiceprints, duration, last-seen time, and relationships; it neither requests nor displays transcript text. New recordings, local relationship corrections, and multi-PC persona synchronization each trigger one event-driven refresh. Reconnecting the event stream performs one catch-up query instead of fixed-interval coverage polling. The current version keeps existing voice classifications in the persona's \`voice/voice-identities.jsonl\` while presenting them inside Identity relations. A later unified-data migration must preserve those classifications. Multi-PC conflicts remain visible until a later explicit confirmation converges the branches.
\r
On first use, an opaque voiceprint ID may be impossible to recognize. Select **Mark the next recording**, then speak one continuous sentence by yourself through the PC, phone, or glasses you want to classify, preferably in a quiet environment. When the next recording event completes, unresolved voiceprints newly observed during that attempt move to the front and receive an **Observed this time** marker. This only narrows the candidates: it starts no second recorder, performs no automatic identification, and never assigns the user merely because one candidate appeared. If other people spoke at the same time, confirm only a voiceprint you can identify confidently or capture again.\r
\r
## How persona automation is composed

Each rule answers two questions: when it runs, and what happens next.

Triggers are:

- **When a message arrives**: select one or more message sources, with optional text, group, and speaker filters.
- **Scheduled task**: use a fixed interval, a daily time, or a one-off date and time.

Actions are:

- **Notify Agent**: send the current message or scheduled task to this persona, with optional extra decision guidance.
- **Run script**: run a \`.cmd\`, \`.bat\`, or \`.py\` file from the current persona's \`scripts/\` directory.

The same model therefore covers message-to-Agent, schedule-to-Agent, message-to-script, and schedule-to-script rules. New trigger or action types can extend this model without creating another independent rules screen.

The interface separates **When a message arrives** from **Scheduled tasks**. Message rules are then grouped into chat, voice and devices, manual and system, and other sources. The editor asks for the trigger first and the action second, showing only fields relevant to the current choices.
\r
## Common Route kinds\r
\r
| Kind | Use it for |\r
| --- | --- |\r
| \`private\` | QQ private messages |\r
| \`direct_at\` | A direct group mention |\r
| \`direct_reply\` | A direct reply to the account or role conversation |\r
| \`indirect_reply\` | Wider reply-chain observation; potentially noisy |\r
| \`group_message\` | Ambient group messages, normally with a narrow regex |\r
| \`heartbeat\` | Schedules and manual validation |\r
| \`manual_trigger\` | Explicit UI or API triggers only |\r
| \`role_panel_message\` | Built-in persona messages shared by local role panel and cross-persona delivery |\r
| \`plan_feedback\` | Independent plan-approval system events without recent messages |\r
| \`voice_transcript\` | FenneNote, XiaoAI, and related transcripts |\r
| \`wecom_message\` | WeCom group events |\r
| \`rabilink\` | RabiLink events |\r
\r
The interface groups available kinds by adapters on the current Route. A message rule with no selected source matches every received message, and the page displays a warning. Start with private messages, direct replies, or narrow keywords before adding broader group-message matches.
\r
## Keep regex focused\r
\r
Do not forward every ambient group message with an empty regex. Begin with terms that express the intended work, for example:\r
\r
\`\`\`text\r
requirement|error|build failed|reminder|please record\r
\`\`\`\r
\r
Regex decides whether the rule matches, not whether the Agent must reply. The persona guidance should still distinguish new facts, tasks, risks, acknowledgements, and polite responses.\r
\r
## Scheduled tasks

Schedule triggers support:
\r
- recurring intervals;\r
- a daily time;\r
- a one-off date and time.\r
\r
A scheduled task requires the Route's Scheduled Tasks input. Agent actions carry the current task, persona/plan/memory indexes, and required paths without automatic chat history. Script actions go directly to the local script executor instead of passing through the Agent.

## Script restrictions

Scripts are disabled by default. The current Route must explicitly enable **Allow this Route to run persona scripts**. This permission stays on the local PC and is not synchronized with the persona.

- A script must remain physically inside the current persona's \`scripts/\` directory; links and \`..\` cannot escape it.
- Only \`.cmd\`, \`.bat\`, and \`.py\` are accepted. Arbitrary command text is not.
- Manager tokens, passwords, and message bodies are not exposed as script environment variables.
- The same rule cannot overlap on the same Route, and a timeout stops its process tree.
- Script execution and Agent delivery keep separate results; one cannot impersonate the other's success.

Enter paths relative to the persona \`scripts/\` directory, such as \`daily-check.py\` or \`tools/check.cmd\`. Enter one argument per line. Validate non-destructive scripts with a test persona before using tasks that modify files or call external systems.
\r
## What belongs in the template\r
\r
Use the template for decision guidance, not to reconstruct the whole event. RabiRoute already injects the event, persona and log paths, knowledge indexes, and reply context. Ordinary endpoints may also receive their configured recent context; Heartbeat never does.\r
\r
A concise work template can say:\r
\r
\`\`\`text\r
Classify this as information, question, task, risk, or decision.\r
Act only when facts, blockers, or next actions changed.\r
Use the injected RabiRoute reply interface for external output.\r
\`\`\`\r
\r
Conversational wording alone cannot grant send permission. Pipeline and message-adapter policy still gate real output.\r
\r
## Save and validate\r
\r
Close the rule dialog, then select **Save configuration**. The change applies to the next message or scheduled event. Legacy message-template rules appear automatically in the new interface; after saving, the persona file uses the new \`automationRules\` structure.
\r
The current WebGUI has no side-effect-free RouteDecision or AgentPacket preview. Use manual trigger for validation only when you intend to enter the real delivery path.\r
\r
## Continue\r
\r
- Validate rules and delivery: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\r
- Understand reply permission: [Safety, replies, and data](safety-and-data_en.md).\r
`,Ae=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./routes-and-adapters_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Route 与消息端\r
\r
一条 Route 是一套可独立启停的消息流配置。它把消息入口、处理端、工作目录、人格绑定和回传意图组合在一起。\r
\r
\`\`\`text\r
消息端 -> Route 规则 -> 人格与上下文 -> Agent 处理端 -> Outbox / 回复\r
\`\`\`\r
\r
## 什么时候新建 Route\r
\r
下面情况适合拆成不同 Route：\r
\r
- 消息来自不同平台或账号。\r
- 需要投递到不同项目或 Desktop 任务。\r
- 使用不同人格或规则集合。\r
- 回传策略、允许的消息类型或文件目录不同。\r
- 需要单独启停、观察和排障。\r
\r
多个 Route 可以复用同一个人格。不要只因为消息入口不同就复制一份人格目录。\r
\r
跨人格投递也不需要新增 Route 类型或消息端。它从 Manager 的人格目录选择目标，再复用目标现有 Route 的内置人格消息链；两端 Route 都必须已启用。\r
\r
## 消息端成熟度\r
\r
| 消息端 | 状态 | 适合用途 | 额外依赖 |\r
| --- | --- | --- | --- |\r
| 定时触发 | 已验证 | 周期巡检和首次闭环 | 无外部账号 |\r
| 角色面板 | 已验证 | 托盘、本地人格消息和经过身份校验的跨人格投递 | Manager / 托盘入口；不是网络 listener |\r
| NapCat / OneBot | 已验证 | QQ 群聊和私聊 | NapCat、QQNT、OneBot 配置 |\r
| 企业微信 / WeCom | 实验 | 企业微信群聊 | Bot ID、Secret、真实环境验收 |\r
| 飞书 / Feishu | 实验 | 飞书应用群聊文本收发 | App ID/Secret、Verification Token、Encrypt Key、公网 HTTPS 事件订阅 |\r
| 远端 Agent | 实验 | 连接独立 bridge 设备 | 远端 bridge 和密码挑战 |\r
| FenneNote / 小爱 | 实验 | 语音转写 | 对应桥接程序或设备 |\r
| RabiLink | 实验 | Relay、眼镜和主动下行 | Relay 配置和真机验收 |\r
| 通用 Webhook | 实验 | 没有专用适配器的 POST | 外部系统和回调网络 |\r
\r
“已验证”表示项目内实现、配置和契约测试完整；外部账号、网络、设备和平台风控仍可能影响运行。\r
\r
## 添加消息端\r
\r
打开“消息适配器”，在“消息端”区域点击添加入口。目录按本地桌面、实时消息、远端设备、内部触发、语音转写和外部接口分组。\r
\r
每个消息端会显示成熟度、连接状态、依赖检查和自己的配置面板。先让一个入口稳定，再增加第二个。\r
\r
![消息适配器页显示当前 Route 的启用状态、消息入口和主 Agent](../../assets/screenshots/webgui-adapters-zh.png)\r
\r
截图时暂时停用了文档示例 Route，但 NapCat 和定时触发仍清楚列在消息入口中。启用 Route 前，先确认入口和主 Agent 与预期一致。\r
\r
## 接收与回传是两个开关\r
\r
消息端 policy 会区分：\r
\r
- **接收消息**：RabiRoute 是否允许这个入口产生事件。\r
- **允许回传/代发**：Agent 是否可以通过 RabiRoute 的 Outbox 向该平台发送。\r
- **支持的输出类型**：例如文本、图片、语音和文件。\r
- **本地文件白名单**：允许上传文件时，限定可读目录。\r
\r
关闭接收不会删除历史数据。关闭回传也不会阻止处理端在自己的任务里产出结果，只会阻止对应外部发送。\r
\r
## QQ / NapCat 最小配置\r
\r
NapCat 通过两条连接与 RabiRoute 协作：\r
\r
- WebSocket Client：把 QQ 事件送到 RabiRoute，常用地址为 \`ws://127.0.0.1:8789\`。\r
- OneBot HTTP Server：供状态查询和回复，常用地址为 \`http://127.0.0.1:3000\`。\r
\r
在 Route 的 NapCat 面板中确认实例、RabiRoute WS 端口、HTTP 地址和 WebUI 地址。扫描只读取状态；启动、登录和修复只会在明确点击相关按钮后执行。各消息端探针并行执行并共享本轮截止时间；单个探针超时会保留其他入口的部分结果，不会被解释成离线。\r
\r
QQ / NapCat 与个人微信拥有完全独立的登录态。QQ 的“可用”只由 OneBot 实际连接和健康结果支持；NapCat WebUI 可打开只说明诊断/配置页面可访问，不能证明 QQ 已登录或可收发。个人微信未登录时只标记个人微信，不会把已在线的 QQ 或全部消息端显示成离线。\r
\r
RabiRoute 不保存或绕过 QQ 密码、验证码、设备确认和风控。首次登录与异常验证必须在 NapCat / QQNT 中完成。\r
\r
完整恢复流程见 [NapCat 无值守与登录稳定性](../napcat-unattended.md)。\r
\r
## 定时触发\r
\r
启用“定时触发”后，还需要在人格规则中配置 \`heartbeat\` 的触发计划。计划支持间隔、每天指定时间和一次性指定时间。\r
\r
未开启 Codex“消息处理 Agent 模式”时，“会话工作中时跳过心跳”只影响固定 Codex 任务仍忙碌时的 heartbeat。开启消息处理 Agent 后，heartbeat 会立即交给独立消息处理任务，这个忙碌跳过选项不再显示；QQ、私聊和其他实时消息不会因此被丢弃。\r
\r
## Webhook 和命名适配器\r
\r
已存在专用适配器的平台应优先使用专用入口。它们通常能保留更准确的状态、日志、模板变量和回传语义。\r
\r
通用 Webhook 适合尚未命名的外部 POST。飞书必须使用独立 \`feishu\` adapter 和应用事件订阅，群机器人 Webhook 不能作为替代。公开配置只应使用 localhost、占位域名和脱敏 token。\r
\r
需要在原生灵珠智能体、AIUI 和原生 App 之间选择时，查看 [RabiLink 眼镜端三条路线对比](../rabilink-glasses-route-comparison.md)。\r
\r
## 保存和生效\r
\r
添加、删除、启停或修改消息端后，点击顶栏“保存配置”。Manager 可能同步配置或重载当前 Route。\r
\r
保存后到“日志诊断”确认运行状态。外部入口还要在平台侧检查连接，例如 NapCat WebSocket、WeCom 鉴权或 Relay 在线状态。\r
\r
## 接下来阅读\r
\r
- 选择处理端和任务：[Agent、项目与任务](agents-and-sessions.md)。\r
- 决定什么消息会命中：[人格与消息规则](personas-and-rules.md)。\r
- 消息进入但没投递：[运行、日志与排障](operations-and-troubleshooting.md)。\r
`,Ce=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./routes-and-adapters.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Routes and message adapters\r
\r
A Route is an independently controlled message-flow configuration. It combines message sources, a handler, workspace, persona binding, and output intent.\r
\r
\`\`\`text\r
Message adapter -> Route rules -> persona and context -> Agent handler -> Outbox / reply\r
\`\`\`\r
\r
## When to create another Route\r
\r
Separate Routes are useful when:\r
\r
- messages come from different platforms or accounts;\r
- work must enter different projects or Desktop tasks;\r
- a different persona or rule set applies;\r
- output policy, payload types, or file roots differ;\r
- you need independent lifecycle and diagnostics.\r
\r
Several Routes can reuse one persona. Do not duplicate a persona only because the message source changes.\r
\r
Cross-persona delivery does not require another Route kind or message adapter. It selects a target from Manager's persona directory and reuses the target's existing built-in persona-message path. Both source and target Routes must be enabled.\r
\r
## Adapter maturity\r
\r
| Message adapter | Status | Good for | Additional dependency |\r
| --- | --- | --- | --- |\r
| Scheduled trigger | Verified | Periodic checks and first-run validation | No external account |\r
| Role panel | Verified | Tray, local persona messages, and authenticated cross-persona delivery | Manager/tray entry; not a network listener |\r
| NapCat / OneBot | Verified | QQ groups and private messages | NapCat, QQNT, OneBot setup |\r
| WeCom | Experimental | WeCom groups | Bot ID, Secret, environment acceptance |\r
| Remote Agent | Experimental | Independent bridge devices | Remote bridge and password challenge |\r
| FenneNote / XiaoAI | Experimental | Speech transcripts | Matching bridge or device |\r
| RabiLink | Experimental | Relay, glasses, and proactive output | Relay setup and real-device acceptance |\r
| Generic Webhook | Experimental | POST from an unnamed system | External callback system |\r
\r
Verified means the repository path, configuration, and contracts are complete. Accounts, networks, devices, and platform risk controls can still affect operation.\r
\r
## Add a message adapter\r
\r
Open **Message Adapters** and add an entry under **Message sources**. The catalog groups local desktop, real-time chat, remote devices, internal triggers, speech, and external interfaces.\r
\r
Each adapter shows maturity, connection state, dependency checks, and its own settings. Stabilize one source before adding another.\r
\r
![Message Adapters showing the current Route state, message inputs, and primary Agent](../../assets/screenshots/webgui-adapters-en.png)\r
\r
The documentation sample Route was paused for the screenshot, while NapCat and Scheduled trigger remain visible in its input list. Confirm the inputs and primary Agent before enabling a Route.\r
\r
## Input and output are separate gates\r
\r
Adapter policy distinguishes:\r
\r
- **Receive messages**: whether this source may create RabiRoute events.\r
- **Allow reply/send**: whether an Agent may send through RabiRoute's Outbox.\r
- **Supported outputs**: text, image, voice, file, or a smaller set.\r
- **Allowed file roots**: local directories permitted for file upload.\r
\r
Disabling input does not delete history. Disabling output does not prevent the handler from producing a result in its task; it blocks the platform send.\r
\r
## Minimal QQ / NapCat setup\r
\r
NapCat uses two connections:\r
\r
- WebSocket Client sends QQ events to RabiRoute, commonly \`ws://127.0.0.1:8789\`.\r
- OneBot HTTP Server supports health and replies, commonly \`http://127.0.0.1:3000\`.\r
\r
In the Route's NapCat panel, verify the instance, RabiRoute WS port, HTTP address, and WebUI address. Scans are read-only; start, login, and repair actions require an explicit click. Endpoint probes start concurrently under one scan deadline. A timed-out probe preserves partial results from other endpoints and is not interpreted as offline.\r
\r
QQ/NapCat and personal Weixin have completely independent login states. QQ is marked usable only from a live OneBot connection and health result. A reachable NapCat WebUI proves only that the diagnostic/configuration surface is reachable; it does not prove that QQ is logged in or can send and receive. A logged-out personal-Weixin adapter affects only that adapter and never turns an online QQ or every message endpoint into an offline state.\r
\r
RabiRoute does not store or bypass QQ passwords, CAPTCHA, device confirmation, or risk controls. Complete first login and exceptional verification in NapCat/QQNT.\r
\r
See [Unattended NapCat and login stability](../napcat-unattended_en.md) for the recovery flow.\r
\r
## Scheduled trigger\r
\r
After enabling Scheduled trigger, add a \`heartbeat\` schedule in persona rules. Schedules can use intervals, daily times, or a one-off date and time.\r
\r
While Codex Message Agent mode is off, **Skip heartbeat while task is busy** affects only heartbeat when the fixed Codex task is active. With Message Agent mode on, heartbeat goes immediately to an independent Message Agent and the busy-skip option is hidden. QQ, private, and other real-time messages are not discarded by this setting.\r
\r
## Webhook and named adapters\r
\r
Prefer a named adapter when one exists. It normally preserves more accurate status, logs, template values, and reply semantics.\r
\r
Generic Webhook is for POST sources without a dedicated integration. Public configuration should use localhost, placeholder domains, and sanitized tokens.\r
\r
For native Lingzhu agent, AIUI, and native app selection, see the [RabiLink glasses three-route comparison](../rabilink-glasses-route-comparison_en.md).\r
\r
## Save and apply\r
\r
After adding, removing, enabling, or editing an adapter, select **Save configuration**. The Manager may synchronize or reload the Route.\r
\r
Then verify runtime state in **Log Diagnostics**. External systems also need platform-side checks such as NapCat WebSocket, WeCom authentication, or Relay presence.\r
\r
## Continue\r
\r
- Select a handler and task: [Agents, projects, and tasks](agents-and-sessions_en.md).\r
- Decide which messages match: [Personas and message rules](personas-and-rules_en.md).\r
- Input works but delivery fails: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\r
`,xe=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./safety-and-data_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 安全、回传与数据\r
\r
RabiRoute 把“Agent 能做什么”和“结果能否写到外部系统”分成两道边界。理解这点，可以避免把一次任务审批误当成长期外发授权。\r
\r
## 两道权限边界\r
\r
| 边界 | 控制什么 | 在哪里决定 |\r
| --- | --- | --- |\r
| Desktop 任务权限 | 命令、文件、网络、工具和沙箱 | 目标 Codex/ChatGPT Desktop 任务 |\r
| RabiRoute Action Gate | QQ、WeCom、RabiLink 等外部回传 | pipeline、replyContext 和消息端 policy |\r
\r
Desktop 允许 Agent 读取文件，不等于允许把文件发到群里。RabiRoute 允许 QQ 文本回传，也不等于允许上传任意本地文件。\r
\r
## Outbox 结果是什么意思\r
\r
| 结果 | 含义 |\r
| --- | --- |\r
| \`sent\` | 请求的输出路径已成功完成；如果目标是 Agent 会话，也可能表示结果被保留在会话中 |\r
| \`draft\` | 结果保留为草稿数据，没有完成外部发送 |\r
| \`blocked\` | policy、消息类型或目标不允许执行 |\r
| \`failed\` | 已尝试执行，但平台或连接返回失败 |\r
\r
当前没有通用、持久化、可在 WebGUI 中逐条审批外部动作的 Action Queue。计划页的“审批建议”只记录 Agent 计划上的用户意见并通知 Agent，不批准 Outbox 外发，也不直接推进计划。\`draft\` 是结果和审计状态，不是一个等待处理的完整审批中心。\r
\r
![消息适配器页按当前 Route 分开显示消息入口和处理端](../../assets/screenshots/webgui-adapters-zh.png)\r
\r
接收和回传都属于当前 Route 的消息端配置。展开具体入口后再检查允许的输出类型和文件目录；修改完成后必须点击顶栏“保存配置”。\r
\r
## 来源回复与主动发送\r
\r
回复当前来源时，Agent 应使用 RabiRoute 注入的 \`replyContext\`。它包含 Route、消息端和来源目标信息，能减少发错群或发错账号的风险。\r
\r
主动发送必须提供明确目标。目标不清、消息类型不支持或输出 policy 关闭时，Outbox 应返回 \`blocked\`，而不是猜测收件人。\r
\r
## 本地文件上传\r
\r
NapCat 群文件使用本地 \`filePath\` 时，路径必须位于配置的 \`allowedFileRoots\` 之一。RabiRoute 会检查真实路径、文件存在性和普通文件类型。\r
\r
公开示例只使用占位目录。不要把个人目录、构建服务器路径、真实文件名或私有发布目录写进仓库。\r
\r
## 哪些操作有真实副作用\r
\r
- 保存配置会写本地配置，并可能同步或重载 Route。\r
- 启动、停止和重启会改变当前 Route 进程状态。\r
- “打开 NapCat”可能启动实例、选择 quick login 并修复 OneBot 配置。\r
- 手动触发会写日志并投递真实 AgentPacket。\r
- Outbox 允许时会向外部平台发送真实内容。\r
- 删除 Route 会移除对应配置，不能当作停止使用。\r
\r
执行前看清当前 Route、目标平台和是否存在未保存修改。\r
\r
## 数据放在哪里\r
\r
常见本地数据：\r
\r
\`\`\`text\r
data/Config.json\r
data/route/<configName>/adapterConfig.json\r
data/route/<configName>/*.jsonl\r
data/roles/<RoleId>/persona.md\r
data/roles/<RoleId>/personaConfig.json\r
data/roles/<RoleId>/plans/\r
data/roles/<RoleId>/memory/\r
\`\`\`\r
\r
Route 配置、消息历史、AgentPacket、Outbox 和运行日志通常位于 Route 数据目录。人格正文、规则、计划、记忆和技能位于角色目录。\r
\r
## 不应进入仓库或反馈附件的数据\r
\r
- QQ 号、群号、私聊内容和未脱敏截图。\r
- token、Cookie、密码、Bot Secret 和 WebUI 密钥。\r
- 真实本机用户名、私有绝对路径和发布目录。\r
- 运行期 \`data/\`、日志、录音、转写和附件。\r
- 处理端任务中的私有上下文。\r
\r
反馈时保留字段名、状态、时间顺序和最小错误文本；用占位值替换身份与凭据。\r
\r
## 备份与迁移\r
\r
迁移前停止相关写入或关闭 Manager，备份需要保留的 Route 配置和人格目录。不要把构建产物、\`node_modules\` 和全部历史日志当成必要配置。\r
\r
新版本启动前先阅读版本更新日志。配置 Schema 可能归一化旧字段；备份能让你比较保存前后的真实变化。\r
\r
## 接下来阅读\r
\r
- 排查外发失败：[运行、日志与排障](operations-and-troubleshooting.md)。\r
- 准备脱敏反馈：[常见问题与获得帮助](faq-and-support.md)。\r
`,Ie=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./safety-and-data.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Safety, replies, and data\r
\r
RabiRoute separates what an Agent may execute from whether its result may write to an external system. A task approval is not permanent outbound authorization.\r
\r
## Two permission boundaries\r
\r
| Boundary | Controls | Decided by |\r
| --- | --- | --- |\r
| Desktop task permission | Commands, files, network, tools, sandbox | Target Codex/ChatGPT Desktop task |\r
| RabiRoute Action Gate | QQ, WeCom, RabiLink, and other output | Pipeline, reply context, adapter policy |\r
\r
Desktop file-read approval does not permit sending that file to a group. QQ text output permission does not allow an arbitrary local-file upload.\r
\r
## Outbox results\r
\r
| Result | Meaning |\r
| --- | --- |\r
| \`sent\` | The requested output path completed; for an Agent-session target, it can mean the result stayed in that session |\r
| \`draft\` | Draft data was retained without completing an external send |\r
| \`blocked\` | Policy, payload type, or target denied the action |\r
| \`failed\` | An action was attempted, but the platform or connection failed |\r
\r
There is no generic persistent Action Queue for approving external actions item by item in WebGUI. The Plans page's approval feedback only records user guidance on an Agent plan and notifies the Agent; it neither approves Outbox delivery nor advances the plan directly. \`draft\` is an output and audit result, not a complete pending-approval center.\r
\r
![Message Adapters separating message inputs and the handler for the current Route](../../assets/screenshots/webgui-adapters-en.png)\r
\r
Input and reply permissions belong to the current Route's adapter settings. Expand the relevant adapter to check output types and allowed file roots, then use **Save configuration** to apply changes.\r
\r
## Source replies and proactive sends\r
\r
For a source-bound reply, the Agent should use the injected \`replyContext\`. It carries the Route, adapter, and source target and reduces wrong-group or wrong-account sends.\r
\r
A proactive send needs an explicit target. If the target is ambiguous, the payload is unsupported, or output policy is off, Outbox should return \`blocked\` instead of guessing.\r
\r
## Local file uploads\r
\r
For a NapCat group upload with local \`filePath\`, the resolved path must remain inside an \`allowedFileRoots\` directory. RabiRoute checks existence, real path, and ordinary-file type.\r
\r
Public examples use placeholder directories. Do not publish personal directories, build-server paths, real filenames, or private release locations.\r
\r
## Actions with real side effects\r
\r
- Save writes local configuration and may synchronize or reload a Route.\r
- Start, Stop, and Restart change the Route process.\r
- Open NapCat may start an instance, select quick login, and repair OneBot settings.\r
- Manual trigger writes logs and delivers a real AgentPacket.\r
- Allowed Outbox actions send real content to external platforms.\r
- Delete removes Route configuration and is not a substitute for Stop.\r
\r
Before acting, confirm the current Route, target platform, and unsaved-change state.\r
\r
## Data locations\r
\r
Common local data:\r
\r
\`\`\`text\r
data/Config.json\r
data/route/<configName>/adapterConfig.json\r
data/route/<configName>/*.jsonl\r
data/roles/<RoleId>/persona.md\r
data/roles/<RoleId>/personaConfig.json\r
data/roles/<RoleId>/plans/\r
data/roles/<RoleId>/memory/\r
\`\`\`\r
\r
Route configuration, message history, AgentPackets, Outbox, and runtime logs normally live under the Route. Persona text, rules, plans, memories, and skills live under the role.\r
\r
## Never publish these values\r
\r
- QQ accounts, group IDs, private messages, and unsanitized screenshots.\r
- Tokens, cookies, passwords, Bot Secrets, and WebUI keys.\r
- Real local usernames, private absolute paths, and release directories.\r
- Runtime \`data/\`, logs, recordings, transcripts, and attachments.\r
- Private context from handler tasks.\r
\r
Keep field names, status, event order, and minimal error text. Replace identities and credentials with placeholders.\r
\r
## Backup and migration\r
\r
Stop related writes or close the Manager before migration, then back up required Route configurations and persona directories. Build output, \`node_modules\`, and all historical logs are not configuration essentials.\r
\r
Read the changelog before starting a new version. Schema normalization can migrate old fields; a backup lets you compare the actual saved changes.\r
\r
## Continue\r
\r
- Diagnose output failure: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).\r
- Prepare a sanitized report: [FAQ and support](faq-and-support_en.md).\r
`,Te=`<!-- docs-language-switch -->\r
<div align="center">\r
<a href="./speech-api_en.md">English</a> | 简体中文\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# 从远端调用 TTS 与 ASR\r
\r
这篇指南用于让另一台电脑、手机后端或自动化客户端通过 RabiLink Relay 调用目标 Rabi PC 上的 RabiSpeech。普通 TTS 与文件 ASR 请求直接返回音频或转写，不进入 Agent、人格、Route 或会话账本；Android/眼镜连续 PCM 流是明确例外，目标 PC 完成 ASR 后会自动进入主机语音库和 \`rabilink\` Route。
\r
> 成熟度：实验。先在受控环境验证模型、超时和公网反代，再接入正式客户端。\r
\r
## 先选对入口\r
\r
| 调用位置 | Base URL | 鉴权 | 适用场景 |\r
| --- | --- | --- | --- |\r
| Rabi PC 本机 | \`http://127.0.0.1:8781\` | 无公网 token | 本机脚本、插件排障 |\r
| 任意远端客户端 | \`https://<RELAY_ORIGIN>/api/rabilink/speech\` | RabiLink **应用 token** | 手机后端、其他电脑、受控服务 |\r
\r
不要把本机回环地址复制到另一台设备。不要使用眼镜设备 token 调语音 API；该接口只接受应用 token。\r
\r
## 远端调用前准备\r
\r
1. 在目标 Rabi PC 的“Rabi 实例”中连接 Relay。\r
2. 打开“允许语音中转”，本机语音地址保持 \`http://127.0.0.1:8781\`。\r
3. 在 Relay \`/manage\` 的目标应用中选择这台在线 Rabi PC。\r
4. 复制该应用的 token。只把它放入当前进程的临时变量或密钥存储，不写进仓库、日志或 URL。\r
\r
下面命令使用 Windows PowerShell 和系统自带的 \`curl.exe\`。先设置两个变量：\r
\r
\`\`\`powershell\r
$RelayOrigin = "https://relay.example.com"\r
$Token = "<RABILINK_APP_TOKEN>"\r
$SpeechBase = "$RelayOrigin/api/rabilink/speech"\r
\`\`\`\r
\r
把 \`https://relay.example.com\` 换成真实 Relay HTTPS 根地址，把 \`<RABILINK_APP_TOKEN>\` 换成应用 token。\r
\r
## 1. 先确认 PC 和模型在线\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  "$SpeechBase/health" \`\r
  -H "Authorization: Bearer $Token"\r
\r
curl.exe --fail-with-body --silent --show-error \`\r
  "$SpeechBase/v1/models" \`\r
  -H "Authorization: Bearer $Token"\r
\`\`\`\r
\r
成功时两条命令都返回 JSON；模型列表来自被选中的那台 PC，而不是 Relay 服务器。\r
\r
## 2. 生成一段 TTS 音频\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  -X POST "$SpeechBase/v1/audio/speech" \`\r
  -H "Authorization: Bearer $Token" \`\r
  -H "Content-Type: application/json" \`\r
  --data-raw '{"input":"你好，这是通过 RabiLink 调用的本机语音。","voice":"default","response_format":"wav","sample_rate":16000,"speed":1.0}' \`
  --output speech.wav\r
\r
Get-Item .\\speech.wav | Select-Object Name, Length\r
\`\`\`\r
\r
成功判据：HTTP 返回成功，并且 \`speech.wav\` 的 \`Length\` 大于 0。WAV 输出的 \`sample_rate\` 由目标 PC 的 RabiSpeech 本地完成，不要求远端客户端安装 ffmpeg；MP3、FLAC、Opus、AAC、PCM 等跨格式输出仍取决于目标 PC 的 ffmpeg 配置。若要指定模型，先从 \`/v1/models\` 复制当前 PC 实际提供的模型 ID，再在 JSON 中加入 \`model\`。
\r
## 3. 把音频交给 ASR\r
\r
下面直接识别上一步生成的文件：\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  -X POST "$SpeechBase/v1/audio/transcriptions" \`\r
  -H "Authorization: Bearer $Token" \`\r
  -F "file=@speech.wav" \`\r
  -F "language=zh" \`\r
  -F "response_format=verbose_json"\r
\`\`\`\r
\r
成功时返回包含转写文本的 JSON。\`file\` 必填；需要指定 ASR 模型时同样先从 \`/v1/models\` 取得真实 ID。\r
\r
完成后清除当前 PowerShell 会话中的 token：\r
\r
\`\`\`powershell\r
$Token = $null\r
\`\`\`\r
\r
## 常见错误\r
\r
| 状态 | 含义 | 恢复动作 |\r
| --- | --- | --- |\r
| \`401\` | 应用 token 缺失、错误或已重置 | 从目标应用重新复制 token，检查请求头 |\r
| \`403\` | 使用了设备 token 等不允许的凭据 | 改用应用 token |\r
| \`404\` | 路径不在 Relay 语音 allowlist | 核对完整 \`/api/rabilink/speech/...\` 路径 |\r
| \`409\` | 应用没有选择可用 PC，或目标 PC 未启用语音中转 | 在 \`/manage\` 选 PC，并检查 PC 在线与开关 |\r
| \`413\` | 上传超过当前限制，默认 25 MiB | 缩短或压缩音频后重试 |\r
| \`502\` | PC 或本机 RabiSpeech 在处理时失败 | 到目标 PC 查看语音服务状态和日志 |\r
| \`504\` | 模型冷启动或处理超过 Relay 等待时间 | 先跑健康检查/预热，或调整受控部署的超时 |\r
\r
公网 allowlist 不包含麦克风启停、人格目录、模型下载或 Python 扩展加载。远端客户端只能调用已允许端点并选择目标 PC 已安装的模型。\r
\r
## 本机调用怎么改\r
\r
在目标 PC 本机调用时，把 \`$SpeechBase\` 改为 \`http://127.0.0.1:8781\`，并删除 \`Authorization\` 请求头。其他 OpenAI-compatible 请求体保持相同。\r
\r
## 查看目标测试机报告\r
\r
在本机或远端 RibiWebGUI 打开“语音服务”，点击“目标测试机报告”。远端页面会沿当前 \`/manage/<账号>/<RabiGUID>/\` 前缀打开报告；报告只代表页面标明的测试机，不是当前客户端的实时性能。\r
\r
## API 参考\r
\r
- \`GET /api/rabilink/speech/health\`\r
- \`GET /api/rabilink/speech/v1/models\`\r
- \`GET /api/rabilink/speech/v1/capabilities\`\r
- \`POST /api/rabilink/speech/v1/audio/speech\`
- \`POST /api/rabilink/speech/v1/audio/transcriptions\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/start\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/stop\`
- \`GET /api/rabilink/speech/openapi.json\`

前三个流式接口供 Android/眼镜连续传 16 kHz mono PCM 使用。\`sequence\` 从 1 开始严格递增；VAD、切句、ASR 和声纹均由目标 PC RabiSpeech 完成，15 秒无 PCM 会自动回收。普通人工 TTS/文件 ASR 调用仍使用前面的同步端点。字段、兼容端点和本机扩展边界见 [RabiSpeech 本机 TTS / ASR 服务](../rabispeech-plugin.md)。
`,Se=`<!-- docs-language-switch -->\r
<div align="center">\r
English | <a href="./speech-api.md">简体中文</a>\r
</div>\r
<!-- /docs-language-switch -->\r
\r
# Call TTS and ASR remotely\r
\r
Use this guide to call RabiSpeech on a selected Rabi PC from another computer, a phone backend, or an automation client through RabiLink Relay. Ordinary TTS and file-ASR requests return audio or a transcription directly and do not enter an Agent, persona, Route, or conversation ledger. Continuous Android/glasses PCM streaming is the explicit exception: after PC ASR, it automatically enters the host-wide speech store and \`rabilink\` Route.
\r
> Maturity: experimental. Validate models, timeouts, and the public reverse proxy in a controlled environment before integrating a production client.\r
\r
## Choose the correct entry point\r
\r
| Caller location | Base URL | Authentication | Use case |\r
| --- | --- | --- | --- |\r
| On the Rabi PC | \`http://127.0.0.1:8781\` | No public token | Local scripts and plugin troubleshooting |\r
| Any remote client | \`https://<RELAY_ORIGIN>/api/rabilink/speech\` | RabiLink **application token** | Phone backends, other computers, controlled services |\r
\r
Do not copy the loopback address to another device. Do not use a glasses device token for this API; speech calls require an application token.\r
\r
## Prepare the remote path\r
\r
1. Connect the target Rabi PC to Relay from **Rabi instances**.\r
2. Enable **Allow speech relay** and keep the local speech target at \`http://127.0.0.1:8781\`.\r
3. In the application's Relay \`/manage\` page, select that online Rabi PC.\r
4. Copy the application's token. Keep it in a temporary process variable or secret store, not in the repository, logs, or URL.\r
\r
The commands below use Windows PowerShell and the system \`curl.exe\`. Define two values first:\r
\r
\`\`\`powershell\r
$RelayOrigin = "https://relay.example.com"\r
$Token = "<RABILINK_APP_TOKEN>"\r
$SpeechBase = "$RelayOrigin/api/rabilink/speech"\r
\`\`\`\r
\r
Replace \`https://relay.example.com\` with the Relay HTTPS origin and \`<RABILINK_APP_TOKEN>\` with the application token.\r
\r
## 1. Verify the PC and model inventory\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  "$SpeechBase/health" \`\r
  -H "Authorization: Bearer $Token"\r
\r
curl.exe --fail-with-body --silent --show-error \`\r
  "$SpeechBase/v1/models" \`\r
  -H "Authorization: Bearer $Token"\r
\`\`\`\r
\r
Both commands return JSON on success. The model inventory comes from the selected PC, not the Relay server.\r
\r
## 2. Generate TTS audio\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  -X POST "$SpeechBase/v1/audio/speech" \`\r
  -H "Authorization: Bearer $Token" \`\r
  -H "Content-Type: application/json" \`\r
  --data-raw '{"input":"Hello from the RabiSpeech API through RabiLink.","voice":"default","response_format":"wav","sample_rate":16000,"speed":1.0}' \`
  --output speech.wav\r
\r
Get-Item .\\speech.wav | Select-Object Name, Length\r
\`\`\`\r
\r
Success means the HTTP request completed and \`speech.wav\` has a \`Length\` greater than zero. The target PC's RabiSpeech applies WAV \`sample_rate\` locally, so the remote caller does not need ffmpeg; MP3, FLAC, Opus, AAC, and raw-PCM output still depends on the target PC's ffmpeg configuration. To select a model, copy an actual model ID from \`/v1/models\` and add \`model\` to the JSON body.
\r
## 3. Transcribe the generated audio\r
\r
Use the file created above:\r
\r
\`\`\`powershell\r
curl.exe --fail-with-body --silent --show-error \`\r
  -X POST "$SpeechBase/v1/audio/transcriptions" \`\r
  -H "Authorization: Bearer $Token" \`\r
  -F "file=@speech.wav" \`\r
  -F "language=en" \`\r
  -F "response_format=verbose_json"\r
\`\`\`\r
\r
A successful call returns JSON containing the transcription. \`file\` is required. To select an ASR model, first obtain its current ID from \`/v1/models\`.\r
\r
Clear the token from the current PowerShell session when finished:\r
\r
\`\`\`powershell\r
$Token = $null\r
\`\`\`\r
\r
## Common errors\r
\r
| Status | Meaning | Recovery |\r
| --- | --- | --- |\r
| \`401\` | The application token is missing, invalid, or was reset | Copy it again from the target application and inspect the request header |\r
| \`403\` | A device token or another unsupported credential was used | Use the application token |\r
| \`404\` | The path is not in the Relay speech allowlist | Verify the complete \`/api/rabilink/speech/...\` path |\r
| \`409\` | No usable PC is selected, or speech relay is disabled on the target | Select the PC in \`/manage\`; verify that it is online and enabled |\r
| \`413\` | The upload exceeds the current limit, 25 MiB by default | Shorten or compress the audio |\r
| \`502\` | The PC or local RabiSpeech failed while processing | Inspect Speech service status and logs on the target PC |\r
| \`504\` | Model startup or processing exceeded the Relay wait | Run health/warmup first, or adjust the controlled deployment timeout |\r
\r
The public allowlist excludes microphone start/stop, persona directories, model downloads, and Python extension loading. A remote caller may only use allowed endpoints and models already installed on the target PC.\r
\r
## Switch to a local call\r
\r
On the target PC, set \`$SpeechBase\` to \`http://127.0.0.1:8781\` and remove the \`Authorization\` header. The other OpenAI-compatible request fields stay the same.\r
\r
## Open the target-machine report\r
\r
Open **Speech service** in the local or remote RibiWebGUI, then select **Target-machine report**. On a remote page, the report stays under the current \`/manage/<account>/<RabiGUID>/\` prefix. It describes only the named test machine, not the current client's live performance.\r
\r
## API reference\r
\r
- \`GET /api/rabilink/speech/health\`\r
- \`GET /api/rabilink/speech/v1/models\`\r
- \`GET /api/rabilink/speech/v1/capabilities\`\r
- \`POST /api/rabilink/speech/v1/audio/speech\`
- \`POST /api/rabilink/speech/v1/audio/transcriptions\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/start\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/chunk?streamId=...&sequence=1\`
- \`POST /api/rabilink/speech/v1/audio-streams/rabilink/stop\`
- \`GET /api/rabilink/speech/openapi.json\`

The three streaming endpoints are for continuous Android/glasses 16 kHz mono PCM. \`sequence\` starts at 1 and must remain contiguous. Target-PC RabiSpeech owns VAD, segmentation, ASR, and voiceprint processing, and retires a stream after 15 seconds without PCM. Manual TTS/file-ASR callers keep using the synchronous endpoints above. See [RabiSpeech local TTS / ASR service](../rabispeech-plugin_en.md) for fields, compatibility endpoints, and local extension boundaries.
`,_e={class:"page-shell user-guide-page"},Pe={class:"guide-header app-card"},Me={class:"eyebrow"},De={class:"guide-title"},We={class:"page-subtitle"},Ue={class:"guide-layout"},Ne={class:"guide-sidebar app-card"},Ee={class:"guide-count"},Oe=["aria-label"],Qe=["onClick"],Ge={key:0,class:"guide-empty"},Le={class:"guide-article app-card"},Be={class:"guide-meta"},qe=["innerHTML"],je=["aria-label"],ze={class:"guide-outline-card app-card"},He={class:"guide-outline-title"},Fe=["onClick"],Ve="https://github.com/vb2250158/RabiRoute/blob/main/",$e=re({__name:"ProjectDocsPage",setup(Ke){const{isEnglish:C,setLocale:Q}=te(),b=ee(),x=ne(),G=Object.assign({"../../../docs/user-guide/README.md":ie,"../../../docs/user-guide/README_en.md":de,"../../../docs/user-guide/agents-and-sessions.md":le,"../../../docs/user-guide/agents-and-sessions_en.md":ce,"../../../docs/user-guide/faq-and-support.md":he,"../../../docs/user-guide/faq-and-support_en.md":ue,"../../../docs/user-guide/first-route.md":pe,"../../../docs/user-guide/first-route_en.md":ge,"../../../docs/user-guide/interface-and-status.md":me,"../../../docs/user-guide/interface-and-status_en.md":be,"../../../docs/user-guide/interface-theme.md":fe,"../../../docs/user-guide/interface-theme_en.md":ye,"../../../docs/user-guide/operations-and-troubleshooting.md":ve,"../../../docs/user-guide/operations-and-troubleshooting_en.md":we,"../../../docs/user-guide/personas-and-rules.md":ke,"../../../docs/user-guide/personas-and-rules_en.md":Re,"../../../docs/user-guide/routes-and-adapters.md":Ae,"../../../docs/user-guide/routes-and-adapters_en.md":Ce,"../../../docs/user-guide/safety-and-data.md":xe,"../../../docs/user-guide/safety-and-data_en.md":Ie,"../../../docs/user-guide/speech-api.md":Te,"../../../docs/user-guide/speech-api_en.md":Se}),L=/<!-- docs-language-switch -->[\s\S]*?<!-- \/docs-language-switch -->/g,I=["README","first-route","interface-and-status","routes-and-adapters","speech-api","agents-and-sessions","personas-and-rules","operations-and-troubleshooting","safety-and-data","faq-and-support"];function B(e){return e.replace(L,"").trim()}function q(e){const n=e.replace(/\\/g,"/");return`docs/user-guide/${n.split("/docs/user-guide/")[1]||n.split("/").pop()||"README.md"}`}function T(e){return(e.split("/").pop()||"README.md").replace(/_en\.md$/,"").replace(/\.md$/,"")}function j(e,n){return e.match(/^#\s+(.+)$/m)?.[1]?.trim()||T(n)}function z(e,n){const t=e.split(/\r?\n/);for(const a of t){const r=a.trim();if(!(!r||r.startsWith("#")||r.startsWith(">")||r.startsWith("|")||r.startsWith("```")||r.startsWith("<"))&&!(/^[-*]\s/.test(r)||/^\d+\.\s/.test(r)))return r.replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[`*_]/g,"")}return n}function H(e){return e.replace(/```[\s\S]*?```/g," ").replace(/<[^>]+>/g," ").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[#>*_`|~-]/g," ").replace(/\s+/g," ").toLowerCase()}function F(e,n){const t=n==="en"?["Start here","Use RabiRoute","Operate safely","Help"]:["开始使用","日常使用","运行与安全","获得帮助"];return e==="README"||e==="first-route"?t[0]:["interface-and-status","routes-and-adapters","speech-api","agents-and-sessions","personas-and-rules"].includes(e)?t[1]:["operations-and-troubleshooting","safety-and-data"].includes(e)?t[2]:t[3]}function S(e){return e.replace(/<[^>]+>/g,"").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[`*_~]/g,"").trim()}function V(e){return S(e).toLowerCase().replace(/[^\p{Letter}\p{Number}\s-]/gu,"").trim().replace(/[\s-]+/g,"-")||"section"}function _(e){const n=[],t=new Map;for(const a of e.split(/\r?\n/)){const r=a.match(/^(#{1,3})\s+(.+?)\s*#*$/);if(!r)continue;const o=S(r[2]),d=V(o),w=t.get(d)||0;t.set(d,w+1),n.push({id:w?`${d}-${w+1}`:d,title:o,depth:r[1].length})}return n}const P=Object.entries(G).map(([e,n])=>{const t=q(e),a=B(String(n)),r=T(t),o=t.endsWith("_en.md")?"en":"zh-CN",d=I.indexOf(r);return{key:r,path:t,title:j(a,t),summary:z(a,o==="en"?"Open this guide.":"打开这篇使用指南。"),source:a,searchText:H(a),section:F(r,o),order:d<0?I.length:d,locale:o}}).sort((e,n)=>e.order-n.order||e.title.localeCompare(n.title)),f=O(""),m=O("README"),c=g(()=>P.filter(e=>e.locale===(C.value?"en":"zh-CN"))),h=g(()=>c.value.find(e=>e.key===m.value)||c.value[0]);D(c,e=>{e.length&&!e.some(n=>n.key===m.value)&&(m.value=e[0].key)}),D(()=>b.query.page,e=>{const n=Array.isArray(e)?e[0]:e,t=typeof n=="string"&&c.value.some(a=>a.key===n)?n:"README";t!==m.value&&(m.value=t),n&&t==="README"&&x.replace({query:{...b.query,page:void 0}})},{immediate:!0});const l=g(()=>C.value?{eyebrow:"RabiRoute User Guide",title:"Use RabiRoute with confidence",subtitle:"Task-based instructions for setup, routing, daily operation, safety, and troubleshooting.",badge:"user guides",search:"Search the user guide",count:"guides",empty:"No guide matches this search.",toc:"On this page",nav:"User guide navigation"}:{eyebrow:"RabiRoute 使用手册",title:"从第一条消息到稳定运行",subtitle:"按真实任务组织的配置、路由、日常运维、安全与排障说明。",badge:"篇用户指南",search:"搜索使用手册",count:"篇指南",empty:"没有找到匹配的指南。",toc:"本页目录",nav:"使用手册导航"}),y=g(()=>{const e=f.value.trim().toLowerCase().split(/\s+/).filter(Boolean);return e.length?c.value.filter(n=>{const t=`${n.title} ${n.summary} ${n.searchText}`.toLowerCase();return e.every(a=>t.includes(a))}):c.value}),$=g(()=>{const e=new Map;for(const n of y.value){const t=e.get(n.section)||[];t.push(n),e.set(n.section,t)}return[...e.entries()].map(([n,t])=>({section:n,items:t}))}),K=g(()=>_(h.value?.source||"").filter(e=>e.depth>1)),J=g(()=>{const e=h.value?.source||"",n=Z.parse(e,{async:!1,gfm:!0});if(typeof DOMParser>"u")return n;const t=new DOMParser().parseFromString(n,"text/html"),a=_(e);return t.querySelectorAll("h1, h2, h3").forEach((r,o)=>{const d=a[o];d&&(r.id=d.id)}),t.body.innerHTML});function X(e,n){const t=decodeURIComponent(n.split("#")[0].split("?")[0]).replace(/\\/g,"/"),a=e.split("/");a.pop();for(const r of t.split("/"))!r||r==="."||(r===".."?a.pop():a.push(r));return a.join("/")}async function M(e,n=""){m.value=e;const t=e==="README"?void 0:e;b.query.page!==t&&await x.replace({query:{...b.query,page:t}}),await oe(),n?v(n):window.scrollTo({top:0,behavior:"smooth"})}function v(e){document.getElementById(e)?.scrollIntoView({behavior:"smooth",block:"start"})}function Y(e){const n=e.target?.closest("a");if(!(n instanceof HTMLAnchorElement))return;const t=n.getAttribute("href")||"";if(!t||!h.value)return;if(t.startsWith("#")){e.preventDefault(),v(decodeURIComponent(t.slice(1)));return}if(/^https?:/i.test(t)||!/\.md(?:$|[?#])/i.test(t))return;e.preventDefault();const a=X(h.value.path,t),r=P.find(o=>o.path===a);if(r){const o=t.includes("#")?decodeURIComponent(t.split("#")[1].split("?")[0]):"";r.locale!==h.value.locale&&Q(r.locale),M(r.key,o);return}window.open(`${Ve}${a}`,"_blank","noopener,noreferrer")}return(e,n)=>{const t=W("v-chip"),a=W("v-text-field");return u(),p("div",_e,[s("header",Pe,[s("div",null,[s("div",Me,i(l.value.eyebrow),1),s("h1",De,i(l.value.title),1),s("p",We,i(l.value.subtitle),1)]),k(t,{color:"secondary",variant:"tonal","prepend-icon":"mdi-book-open-page-variant-outline"},{default:U(()=>[N(i(c.value.length)+" "+i(l.value.badge),1)]),_:1})]),s("div",Ue,[s("aside",Ne,[k(a,{modelValue:f.value,"onUpdate:modelValue":n[0]||(n[0]=r=>f.value=r),label:l.value.search,"prepend-inner-icon":"mdi-magnify",clearable:"",density:"compact"},null,8,["modelValue","label"]),s("div",Ee,i(y.value.length)+" / "+i(c.value.length)+" "+i(l.value.count),1),s("nav",{"aria-label":l.value.nav},[(u(!0),p(R,null,A($.value,r=>(u(),p("section",{key:r.section,class:"guide-group"},[s("h2",null,i(r.section),1),(u(!0),p(R,null,A(r.items,o=>(u(),p("button",{key:o.path,type:"button",class:E({active:o.key===h.value?.key}),onClick:d=>M(o.key)},[s("strong",null,i(o.title),1),s("span",null,i(o.summary),1)],10,Qe))),128))]))),128)),y.value.length===0?(u(),p("div",Ge,i(l.value.empty),1)):ae("",!0)],8,Oe)]),s("main",Le,[s("div",Be,[k(t,{size:"small",color:"secondary",variant:"tonal"},{default:U(()=>[N(i(h.value?.section),1)]),_:1}),s("span",null,i(h.value?.summary),1)]),s("article",{class:"markdown-body","data-no-i18n":"",onClick:Y,innerHTML:J.value},null,8,qe)]),s("aside",{class:"guide-outline","aria-label":l.value.toc},[s("div",ze,[s("div",He,i(l.value.toc),1),(u(!0),p(R,null,A(K.value,r=>(u(),p("button",{key:r.id,type:"button",class:E({nested:r.depth===3}),onClick:o=>v(r.id)},i(r.title),11,Fe))),128))])],8,je)])])}}}),nn=se($e,[["__scopeId","data-v-615bcd17"]]);export{nn as default};
