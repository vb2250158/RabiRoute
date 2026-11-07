import { pluginTranslation } from "./translationRegistry";

export const englishCatalog: Record<string, string> = {
  "初始化中": "Initializing",
  "更新初始化中": "Initializing update",
  "旧运行实例正在停止": "Previous activation is stopping",
  "旧运行实例": "Previous activations",
  "准备中": "Preparing",
  "正在停止": "Stopping",
  "插件实例": "Plugin instances",
  "插件包已导入，可在下方安装。": "Plugin package imported. Install it below.",
  "插件已安装，初始化状态见列表。": "Plugin installed. See its initialization status in the list.",
  "已读取到该安装实例，请查看其运行状态。": "The installed instance was found. Check its running state.",
  "卸载结果待确认，请刷新查看。": "Uninstall result is not confirmed. Refresh to check.",
  "配置已移除，正在停止原运行实例。": "Configuration removed. The original running instance is stopping.",
  "插件已卸载，设置和用户数据已保留。": "Plugin uninstalled. Settings and user data are preserved.",
  "卸载保留设置和用户数据，之后可以重新安装。": "Uninstalling preserves settings and user data. You can install it again later.",
  "卸载插件": "Uninstall plugin",
  "安装插件": "Install plugins",
  "导入这台电脑上的插件运行包目录，或选择已有插件包安装。": "Import a runtime package directory on this computer, or install an available package.",
  "本机插件包目录": "Local runtime package directory",
  "导入目录": "Import directory",
  "添加实例": "Add instance",
  "此 Agent 插件暂不可用，原配置和主控选择已保留。请在插件页检查启用状态与加载结果。": "This Agent plugin is unavailable. Your settings and primary selection are preserved. Check its status on the Plugins page.",
  "对应 Agent 插件未启用、未安装或加载失败，原配置与主控选择已保留。": "The Agent plugin is disabled, missing or failed to load. Your settings and primary selection are preserved.",
  "未取得此 Agent 的扫描结果，请恢复对应插件后刷新。": "No scan result was returned for this Agent. Restore its plugin and refresh.",

  "打开任务": "Open task",

  "会话列表": "Conversations",

  "历史记录": "Saved history",
  "筛选": "Filter",
  "附件": "Attachment",
  "重试": "Retry",

  "下载": "Download",

  "消息 ID": "Message ID",

  "时间": "Time",
  "正在加载历史记录": "Loading history",

  "Agent 发现": "Agent discovery",
  "查找可连接的 Agent 与现有会话": "Find available Agents and existing sessions",
  "Agent 通信": "Agent communication",
  "提供接口发现、文件上传与 Agent 消息交互": "Provide API discovery, file uploads and Agent messaging",
  "Agent 运行状态": "Agent runtime status",
  "跟踪 Agent 运行状态与当前会话绑定": "Track Agent status and current session bindings",
  "Agent 会话管理": "Agent session management",
  "管理会话、任务请求与提醒": "Manage sessions, task requests and reminders",

  "哔哩哔哩历史": "Bilibili history",
  "同步观看记录并管理历史整理任务": "Sync viewing history and manage history organization",

  "核心管理": "Core management",
  "管理更新、资源与远程电脑；可在插件页重新启用": "Manage updates, resources and remote PCs; re-enable from this plugin page",
  "桌面与启动设置": "Desktop and startup settings",
  "管理桌面偏好、自启动和配置目录": "Manage desktop preferences, startup and configuration locations",
  "桌面伙伴": "Desktop companion",
  "管理角色形象、桌宠资源与桌面动作": "Manage character appearances, pet assets and desktop actions",
  "运行诊断": "Runtime diagnostics",
  "查看路由与消息网关的运行状态": "Inspect route and message gateway runtime status",
  "消息网关运行": "Message gateway runtime",
  "启动、停止并管理各路由的消息网关": "Start, stop and manage each route's message gateway",

  "记忆整理": "Memory organization",
  "定期整理角色记忆并维护长期记录": "Organize persona memories and maintain long-term records",
  "消息端发现": "Message input discovery",
  "扫描已安装消息端与可用连接": "Find installed message inputs and available connections",
  "消息自动跟进": "Message follow-up",
  "跟进待处理消息与知识回调并发送提醒": "Follow pending messages and knowledge callbacks, and send reminders",
  "待办消息管理": "Pending message management",
  "登记消息处理要求、核对上下文并记录回复进度": "Register message requirements, verify context and record reply progress",
  "性能监测": "Performance monitoring",
  "查看运行耗时、资源采样与性能分析结果": "Inspect operation times, resource samples and performance analysis",
  "角色与人格": "Roles and personas",
  "管理角色配置、对话记录与共享资源": "Manage persona settings, conversations and shared resources",
  "计划进度反馈": "Plan progress feedback",
  "投递计划进展并恢复待确认的反馈消息": "Deliver plan progress and reconcile unconfirmed feedback",
  "连接远程电脑并管理 Agent 任务": "Connect remote PCs and manage Agent tasks",
  "创建、编辑和保存消息路由与发送规则": "Create, edit and save message routes and sending rules",
  "视频生成工作台": "Video generation workbench",
  "管理视频生成、模型、媒体项目与任务": "Manage video generation, models, media projects and jobs",
  "可穿戴健康同步": "Wearable health sync",
  "从手机与可穿戴设备同步健康记录": "Sync health records from phones and wearables",
  "YeYu Gamer 连接": "YeYu Gamer connection",
  "查看本机游戏助手状态并提交游戏计划": "Inspect the local gaming assistant and submit game plans",
  "配置错误": "Config error",
  "停止未确认": "Stop unconfirmed",
  "当前路线已保存并生效": "The current route has been saved and applied",
  "当前路线已保存，等待运行端生效": "The current route has been saved; runtime application is pending",
  "当前路线已保存，运行端未应用本次更新": "The current route has been saved; the runtime did not apply this update",
  "当前路线已保存，运行生效待确认": "The current route has been saved; runtime application is unconfirmed",
  "当前路线已保存，运行生效失败": "The current route has been saved; runtime application failed",
  "当前路线已保存，部分入口不可用": "The current route has been saved; some inputs are unavailable",
  "管理共享的语音识别、合成、播放与模型服务": "Manage shared speech recognition, synthesis, playback and model services",
  "将语音转写按订阅发送给人格与消息路由": "Send speech transcripts to subscribed personas and message routes",
  "插件": "Plugins",
  "查看插件的运行状态、能力和版本。": "View plugin status, capabilities and versions.",
  "返回插件": "Back to plugins",
  "正在读取插件": "Loading plugins",
  "启动失败": "Failed to start",
  "等待依赖": "Waiting for dependencies",
  "启动中": "Starting",
  "缺少依赖": "Missing dependencies",
  "插件信息": "Plugin information",

  "运行位置": "Runs on",
  "提供的能力": "Provided capabilities",
  "未声明能力": "No capabilities declared",
  "已安装插件": "Installed plugins",
  "搜索插件": "Search plugins",
  "查看插件": "View plugin",
  "没有匹配的插件": "No matching plugins",
  "没有可用的插件记录": "No plugin records available",
  "未运行": "Not running",
  "启用插件": "Enable plugin",
  "插件状态未确认，请刷新后查看。": "Plugin status is unconfirmed. Refresh to check.",

  "合并转发": "Forwarded messages",
  "卡片消息": "Card message",
  "其他消息": "Other message",
  "戳一戳": "Poke",
  "窗口抖动": "Nudge",

  "更多会话": "More conversations",

  "管理员": "Admin",

  "Agent 间投递": "Agent-to-Agent",
  "任务回复": "Task replies",
  "眼镜 AIUI": "Glasses AIUI",

  "消息渠道": "Message channels",

  "收到": "Received",

  "请先在米家设置中配置事件接收角色。": "Configure the event recipient in Xiaomi Home settings first.",

  "继续加载": "Continue loading",

  "排除心跳类型的任务": "Exclude heartbeat tasks",
  "请选择支持的条件类型。": "Select a supported condition type.",

  "只有任务的工作目录与所选项目一致时才投递。Git 项目的不同工作树可匹配同一项目，但项目内不同子目录不会自动视为相同。请填写绝对目录，也可以读取当前 Agent 端的项目候选。": "Deliver only when the task directory matches the selected project. Git worktrees can match the same project, but different subdirectories are not automatically identical. Enter an absolute directory or load project candidates from the selected Agent.",
  "只有当前任务绑定了当前角色的计划时才投递。按任务 ID 核对绑定，不按任务名称猜测；未绑定计划的任务会跳过。此条件无需额外参数。": "Deliver only when the current task is bound to a plan of this role. Matching uses the task ID, never guesses from its name. Tasks without a bound plan are skipped. No extra parameters are required.",
  "只投递所选聊天会话的任务结果。可以多选，命中其中任意一个即可满足此条件；实际按会话 ID 匹配，改名不影响匹配。至少选择一个会话。": "Deliver results only from selected chat sessions. You can select several; any selected session ID matches. Renaming does not affect matching. Select at least one session.",
  "所选聊天会话的任务结果不通过本规则投递，其他会话仍需满足本规则的其余条件。可以多选，实际按会话 ID 匹配；同一会话同时被限定和排除时，以排除为准。至少选择一个会话。": "This rule skips results from selected sessions. Other sessions must still meet its remaining conditions. Select one or more sessions; matching uses IDs. Exclusion wins if a session also appears in the include list.",
  "跳过本轮回复为完整心跳控制消息的任务结果，包括 DONT_NOTIFY 和 NOTIFY，避免通过本规则发群或播报。同一任务的普通回复不受影响；正文中引用的心跳示例不会被误判。此条件无需额外参数，只作用于当前投递规则。": "Skip results whose current reply is a complete heartbeat control message, including DONT_NOTIFY and NOTIFY, for this rule's group delivery or speech output. Ordinary replies in the same task and quoted examples are unaffected. No extra parameters; this applies only to the current rule.",

  "消息": "Messages",
  "消息路由": "Message Route",

  "恢复": "Restore",
  "归档": "Archive",
  "角色名称": "Role name",

  "归档角色": "Archive role",
  "新建角色": "Create role",
  "已归档角色": "Archived roles",

  "刷新会话": "Refresh sessions",
  "错误详情": "Error details",

  "投递目标": "Delivery target",
  "指定会话": "Target session",

  "计划秘书": "Plan secretary",
  "消息处理 Agent": "Message processing Agent",
  "记忆整理 Agent": "Memory consolidation Agent",
  "设备列表": "Device list",

  "设备信息": "Device information",

  "没有可复用的 DSH 登录。请在当前浏览器登录同一地址的 DSH，或粘贴当前登录链接连接。": "No reusable DSH login is available. Sign in to DSH at the same address in this browser, or paste the current login link to connect.",

  "音箱": "Speaker",

  "刷新设备": "Refresh devices",

  "正在提交实例 ID 重置请求…": "Submitting the instance ID reset request…",
  "实例 ID 重置处理中，正在等待 Host 确认…": "Resetting the instance ID. Waiting for Host confirmation…",
  "实例 ID 重置结果仍待确认。页面连接可能已切换，请从托盘重新打开 RabiLink 配置查看结果。": "The instance ID reset is still unconfirmed. The page connection may have changed. Reopen RabiLink settings from the tray to check the result.",
  "实例 ID 已重置并确认。旧连接可能需要重新建立。": "The instance ID reset is confirmed. Existing connections may need to be established again.",
  "重置已回滚，原实例 ID 已保留。": "The reset was rolled back. The previous instance ID was retained.",
  "实例 ID 重置失败，请检查 Host 日志。": "The instance ID reset failed. Check the Host logs.",
  "实例 ID 重置请求被拒绝，请核对当前实例和 Host 状态。": "The instance ID reset request was rejected. Check the current instance and Host state.",
  "当前浏览器无法生成安全操作标识，请从托盘重新打开页面。": "This browser cannot generate a secure operation ID. Reopen the page from the tray.",
  "无法核对本机实例标识，请刷新重试。": "The local instance ID could not be verified. Refresh and try again.",

  "此操作需要安装版 RabiRoute Host。": "This operation requires an installed RabiRoute Host.",
  "实例 ID 已改变，请重新读取页面。": "The instance ID has changed. Reload the page.",
  "Host 未接受重置。请核对当前运行版本和实例状态。": "Host did not accept the reset. Check the running version and instance state.",
  "Host 未确认重置请求，请查询操作状态或从托盘重新打开页面。": "Host did not confirm the reset request. Check the operation status or reopen the page from the tray.",
  "先前请求的结果未确认，请查询操作状态，不要重复重置。": "The earlier request is unconfirmed. Check its status without resetting again.",
  "重置未完成，请检查 Host 日志与备份。": "The reset did not complete. Check the Host logs and backup.",
  "重置失败，已恢复原身份。": "The reset failed. The original identity was restored.",
  "角色来源 PC": "Role source PC",
  "版本未知": "Version unknown",

  "远端 PC": "Remote PC",
  "刷新远端 PC": "Refresh remote PCs",

  "在线 · 将自动连接": "Online · Connects automatically",

  "角色来源": "Role source",

  "远端角色引用": "Remote role reference",

  "来源 PC": "Source PC",
  "角色 ID": "Role ID",

  "全天记录": "All-day recording",
  "尚未保存": "Not saved yet",

  "服务器返回的数据不完整，请刷新重试。": "The server returned incomplete data. Refresh to try again.",

  "未提供": "Not provided",
  "任务处理": "Task processing",
  "网页管理": "Web management",
  "语音合成": "Speech synthesis",
  "语音识别": "Speech recognition",
  "跨电脑调用": "Cross-computer calls",
  "跨电脑连接": "Cross-computer connection",
  "服务已连接": "Service connected",
  "服务未连接": "Service disconnected",
  "本机实例": "Local instance",
  "实例标识": "Instance identifier",

  "远端智能体": "Remote Agent",
  "修改名称": "Rename",

  "保存名称": "Save name",

  "名称保存结果未确认，请刷新后核对。": "The saved name could not be confirmed. Refresh to check it.",
  "节点名称已被修改，请刷新后重试。": "The node name has changed. Refresh before trying again.",
  "节点名称须为不超过 80 个字符的单行文字。": "The node name must be a single line of up to 80 characters.",
  "路由与智能体设置": "Route and Agent settings",
  "此实例还没有智能体。": "This instance has no Agents yet.",
  "添加智能体": "Add Agent",

  "接入其他电脑前，请在设置中开启局域网访问，然后重启 RabiRoute。": "Before connecting another computer, enable LAN access in Settings, then restart RabiRoute.",
  "提示词含一次性票据，30 分钟内有效，成功兑换后立即失效。只粘贴到目标电脑的私密智能体任务中，无需手填管理密钥。": "The prompt contains a one-time ticket valid for 30 minutes; it expires immediately after successful redemption. Paste it only into a private Agent task on the target computer. No admin key needs to be entered manually.",
  "是否启用Agent": "Enable Agent",

  "目标电脑可访问的 RabiRoute 地址": "RabiRoute URL reachable from the target computer",
  "使用本机 RabiRoute 的局域网地址": "Use this RabiRoute instance's LAN URL",
  "主页": "Home",
  "高级信息": "Advanced information",

  "TTS 播报": "TTS announcement",

  "用于消歧同名会话；选择已有会话时自动采用会话目录": "Disambiguates conversations with the same name; selecting one uses its working directory.",
  "使用 HTTP 回调接收事件。": "Receives events through an HTTP callback.",
  "专注": "Focus",

  "WorkBuddy 任务由本机 WorkBuddy 桌面应用承载。RabiRoute 把消息投递到该任务会话进程的本地网关（": "A WorkBuddy task is hosted by the WorkBuddy desktop app on this machine. RabiRoute delivers messages to the local gateway of that task's session process (",

  "WorkBuddy 任务 ID": "WorkBuddy task ID",
  "请选择或粘贴会话 ID": "Select or paste a session ID",
  "来自 WorkBuddy 任务库的任务 ID；投递时它同时是会话路由键": "Task ID from the WorkBuddy task library; it doubles as the delivery routing key",
  "任务名称": "Task name",
  "可选标识，只用于显示，不会改写 WorkBuddy 中的任务名": "Optional label for display only; it never renames the WorkBuddy task",
  "必须与 WorkBuddy 任务的目录一致；不一致会停止投递": "Must match the WorkBuddy task directory; a mismatch stops delivery",
  "上次网关地址（可选）": "Last gateway address (optional)",
  "WorkBuddy 端口每次启动都会变化；通常留空，投递时按会话描述文件动态发现": "The WorkBuddy port changes on every start; leave this empty and delivery discovers it from the live session descriptor",
  "WorkBuddy（腾讯 AI 办公工作台）": "WorkBuddy (Tencent AI office workspace)",
  "实验支持，投递到本机 WorkBuddy 任务的会话网关": "Experimental: deliver to a local WorkBuddy task through its session gateway",
  "WorkBuddy 任务": "WorkBuddy task",
  "未选择 WorkBuddy 任务": "No WorkBuddy task selected",
  "会话在线": "Session open",
  "会话未打开": "Session not open",
  "WorkBuddy 需要选择任务并填写与任务一致的工作目录；请先在 WorkBuddy 中打开该任务。": "WorkBuddy needs a selected task and a work directory matching that task; open the task in WorkBuddy first.",
  "Antigravity（Google 的 Agent 开发环境）": "Antigravity (Google's Agent development environment)",
  "实验支持，通过官方 agy agentapi 投递到本机会话": "Experimental: deliver to a local conversation through the official agy agentapi interface",

  "Antigravity 会话": "Antigravity conversation",
  "Antigravity 会话 ID": "Antigravity conversation ID",
  "请选择或粘贴 Antigravity 会话 ID": "Select or paste an Antigravity conversation ID",
  "留空时每次投递都会新开会话；填写后按同一会话续投": "Left empty, every delivery starts a new conversation; filled in, deliveries continue in that conversation",
  "会话名称": "Conversation name",
  "可选标识，只用于显示，不会改写 Antigravity 中的会话名": "Optional label for display only; it never renames the conversation in Antigravity",
  "宿主已运行": "Host running",
  "宿主未运行": "Host not running",

  "会话发现": "Conversation discovery",
  "未选择 Antigravity 会话（每次投递将新开会话）": "No Antigravity conversation selected (each delivery starts a new one)",
  "Antigravity 会话由本机 Antigravity 桌面应用承载。RabiRoute 通过官方": "An Antigravity conversation is hosted by the Antigravity desktop app on this machine. RabiRoute delivers messages through the official",

  "代码": "Code",

  "可多选": "Select all that apply",

  "请选择审批意见": "Choose an approval response",
  "按此方案执行": "Proceed with this plan",
  "提出审批建议": "Suggest changes",
  "选择提出审批建议时，请填写具体建议": "Describe your suggested changes when selecting Suggest changes",

  "待机与休眠": "Idle and sleep",
  "任务与连接反馈": "Task and connection feedback",
  "鼠标交互": "Mouse interactions",
  "空闲随机动作": "Random idle actions",
  "其他动作": "Other actions",
  "默认待机": "Default idle",
  "空闲后休眠": "Sleep after inactivity",
  "空闲时随机播放": "Random playback while idle",
  "点击桌宠": "Click the pet",
  "拖动桌宠": "Drag the pet",
  "任务未完成或连接中断": "Task not completed or connection lost",
  "手动播放": "Manual playback",

  "循环播放": "Loop",
  "帧": "frames",
  "结束后": "After playback",
  "预览": "Preview",

  "待机": "Idle",
  "思考": "Thinking",
  "说话": "Talking",
  "担心": "Concerned",
  "回应": "Attention",
  "睡觉": "Sleeping",
  "拖动": "Dragging",
  "读书": "Reading",
  "挥手": "Waving",
  "噘嘴": "Pouting",
  "捂嘴": "Covering mouth",
  "限定聊天会话": "Include sessions",
  "排除聊天会话": "Exclude sessions",

  "加载更多会话": "Load more sessions",
  "会话条件至少需要选择一个聊天会话。": "Select at least one session for a session condition.",

  "事件投递": "Event delivery",

  "事件": "Event",
  "条件": "Conditions",

  "任务完成": "Task completed",
  "限定项目": "Project filter",
  "必须绑定计划": "Require a linked plan",
  "NapCat（QQ）": "NapCat (QQ)",

  "消息路线": "Message Route",

  "群": "Group",
  "群号": "Group ID",
  "QQ 号": "QQ ID",

  "请选择支持的事件。": "Select a supported event.",

  "项目条件需要填写绝对目录。": "The project condition requires an absolute directory.",
  "请选择消息路线。": "Select a message Route.",
  "请选择支持的消息端。": "Select a supported endpoint.",
  "请选择 QQ 账号。": "Select a QQ account.",
  "请选择群或个人 QQ。": "Select a group or private QQ.",
  "请填写有效的群号或 QQ 号。": "Enter a valid group or QQ ID.",

  "Agent 投递": "Agent delivery",
  "目标任务": "Target task",
  "接收消息": "Receive messages",
  "Agent Hook": "Agent Hook",

  "未开启": "Off",

  "一条路由只能绑定一个 QQ，请为另一个 QQ 新建路由。": "A Route can bind only one QQ account. Create another Route for a different account.",

  "管理接口": "Management API",

  "扫码登录": "QR sign-in",

  "控制台": "Console",
  "设置": "Settings",

  "新增路由": "Add route",

  "页面已切换，正在加载内容": "Page switched. Loading content…",
  "页面加载失败": "Page failed to load",
  "页面内容未能及时加载。请重试当前页面。": "The page did not load in time. Retry this page.",
  "重试当前页面": "Retry this page",

  "模型管理": "Model management",

  "安装或下载没有完成。": "The installation or download did not complete.",

  "NapCat 管理接口地址": "NapCat management API URL",
  "先检查 HTTP、管理接口与本机进程；保存 Route 后，直接在 NapCat 卡片完成快速、密码或扫码登录。": "Check HTTP, the management API, and the local process first. After saving the Route, finish quick, password, or QR-code sign-in directly on the NapCat card.",
  "管理接口：": "Management API:",
  "管理凭据：已从 NapCat webui.json 读取": "Management credential: read from NapCat webui.json",
  "位；仅由 Rabi 后端代理使用。": " characters; used only by the Rabi backend proxy.",
  "管理凭据：使用当前 Route 保存的": "Management credential: using the",
  "位凭据。": "-character credential saved for the current Route.",
  "管理凭据：": "Management credential:",

  "当前浏览器不允许自动复制，请手动选择文本复制。": "This browser does not allow automatic copying. Select and copy the text manually.",
  "当前浏览器拒绝复制，请手动选择文本复制。": "The browser rejected the copy action. Select and copy the text manually.",
  "消息连接器": "Message connectors",

  "可投递": "Ready for delivery",
  "已绑定": "Bound",
  "主控": "Primary",
  "备用": "Secondary",

  "投递测试": "Delivery test",

  "目标：": "Target:",

  "投递测试失败": "Delivery test failed",

  "已停用": "Disabled",
  "当前计划": "Current plans",
  "沉淀记忆": "Consolidated memory",

  "记录时间": "Recorded",

  "查看详情": "View details",

  "未绑定角色": "Unbound role",
  "未记录": "Not recorded",

  "进行中": "In progress",
  "分析中": "Analyzing",
  "执行中": "Executing",

  "待 QA": "Awaiting QA",
  "状态未知": "Status unknown",
  "暂停": "Paused",

  "正在执行": "Executing",

  "已完成": "completed",

  "全部状态": "All statuses",

  "重要程度": "Importance",
  "紧急程度": "Urgency",

  "清除": "Clear",

  "视频预览": "Video preview",

  "加载更多": "Load more",

  "文件": "File",
  "更新时间": "Updated",
  "完成时间": "Completed",

  "待决定事项": "Decision needed",

  "提交": "Submit",

  "标记状态": "Marker status",
  "已归档": "Archived",
  "当前步骤": "Current step",
  "创建计划": "Plan created",

  "审批执行合同": "Approval execution contract",

  "已取消": "Cancelled",

  "新建": "Create",
  "修改": "Modify",
  "移动": "Move",

  "无法连接 Manager，服务可能正在重启或网络暂时中断。计划反馈内容已保留，请稍后重试。": "Cannot reach the Manager. It may be restarting or the network may be temporarily interrupted. Your plan feedback is preserved; retry shortly.",

  "角色头像": "Role avatar",

  "移除": "Remove",

  "记录中": "Recording",

  "记录设置": "Recording settings",

  "保存设置": "Save settings",

  "查看范围": "Time range",

  "最近 24 小时": "Last 24 hours",

  "语音服务": "Speech service",

  "在线": "Online",

  "状态检查": "status check",
  "未设置": "Not set",

  "本机": "Local PC",
  "尚未加载": "Not loaded",
  "尚未检查": "Not checked",

  "模型状态": "Model state",

  "已加载": "Loaded",

  "快速配置": "Quick setup",

  "当前路由": "Current route",
  "未选择路由": "No route selected",
  "等待配置": "Waiting for configuration",

  "未配置": "Not configured",
  "已禁用": "Disabled",

  "已启用": "Enabled",
  "已关闭": "Off",
  "运行中": "Running",
  "已停止": "Stopped",
  "连接中": "Connecting",
  "已连接": "Connected",
  "未连接": "Disconnected",
  "连接失败": "Connection failed",

  "未知": "Unknown",
  "有未保存的修改": "Unsaved changes",
  "保存结果待确认": "Save result awaiting confirmation",
  "重新加载当前路线": "Reload current route",
  "正在确认上次保存结果": "Confirming the previous save",
  "正在保存当前路线": "Saving the current route",
  "当前路线已保存": "Current route saved",
  "已确认当前路线保存成功": "Current route save confirmed",
  "配置已保存": "Configuration saved",
  "状态已刷新": "Status refreshed",
  "刷新状态": "Refresh status",

  "保存配置": "Save configuration",
  "当前配置有未保存修改。确定要切换吗？": "This configuration has unsaved changes. Switch anyway?",

  "保存": "Save",
  "新增": "Add",
  "删除": "Delete",
  "编辑": "Edit",
  "复制": "Copy",
  "刷新": "Refresh",
  "重新扫描": "Scan again",
  "加载更多 Desktop 任务": "Load more Desktop tasks",
  "重启": "Restart",
  "启动": "Start",
  "停止": "Stop",
  "打开": "Open",
  "关闭": "Close",
  "取消": "Cancel",
  "确认": "Confirm",
  "继续": "Continue",
  "返回": "Back",
  "下一步": "Next",
  "上一步": "Previous",
  "完成": "Finish",
  "检查": "Check",
  "测试": "Test",
  "触发": "Trigger",
  "部署": "Deploy",
  "安装": "Install",
  "登录": "Sign in",
  "断开": "Disconnect",
  "选择": "Select",
  "搜索": "Search",
  "清空": "Clear",

  "环境和依赖": "Environment & dependencies",
  "安装状态": "Installation status",
  "状态": "Status",
  "来源": "Source",
  "连接": "Connection",
  "连接状态": "Connection status",
  "在线状态": "Online status",
  "登录资料": "Login profile",

  "可用": "Available",
  "不可用": "Unavailable",
  "待检查": "Needs attention",
  "未选择": "Not selected",
  "未绑定": "Not bound",
  "未发现": "Not found",
  "未安装": "Not installed",
  "已安装": "Installed",
  "已保存": "Saved",
  "保存失败": "Save failed",

  "没有返回错误详情": "No error details were returned",
  "配置": "Configuration",
  "路由": "Route",
  "路由配置": "Route settings",

  "运行状态": "Runtime state",
  "消息入口": "Message inputs",

  "角色": "Role",
  "当前角色": "Current role",

  "角色目录": "Role directory",

  "配置目录": "Configuration directory",

  "删除路由配置": "Delete Route configuration",

  "Agent 线程": "Agent task",
  "Agent 类型": "Agent type",
  "Agent 端": "Agent handler",
  "主控 Agent": "Primary Agent",
  "Agent 处理端": "Agent handler",
  "处理端": "Handler",
  "工作目录": "Working directory",
  "会话": "Task",
  "会话线程名": "Task name",
  "会话名 + 最后会话时间": "Task name + last activity",
  "自动初始化会话": "Initialize task automatically",

  "推理期上下文刷新": "Reasoning-time context refresh",

  "会话工作中时跳过心跳": "Skip heartbeat while task is busy",
  "Codex Desktop 任务": "Codex Desktop task",
  "Codex/ChatGPT Desktop（必需）": "Codex/ChatGPT Desktop (required)",
  "CLI 可执行路径": "CLI executable",
  "打开 Marvis": "Open Marvis",

  "打开登录": "Open sign-in",
  "打开日志": "Open logs",

  "规则名称": "Rule name",

  "定时计划": "Schedules",
  "计划名称": "Schedule name",

  "计划数量": "Schedule count",

  "变量值": "Variable value",

  "未检查": "Not checked",

  "TTS 模型": "TTS model",

  "跟随系统": "System",
  "浅色": "Light",
  "深色": "Dark",

  "自动复制": "Auto copy",

  "投递至": "Send to",

  "语言": "Language",
  "语速": "Speed",

  "语音唤醒": "Speech wake-up",
  "语音唤醒关键词": "Speech wake-up keywords",

  "条": "messages",
  "热投递": "Hot delivery",

  "投递失败": "Delivery failed",

  "尚未配置": "Not configured",

  "刷新记录": "Refresh records",

  "显示名": "Display name",
  "别名": "Aliases",

  "会话 ID": "Session ID",

  "保存绑定": "Save binding",

  "不配置角色时，只按消息入口默认模板把来源和回传 API 投递给 Agent。": "Without a role, the default input template sends only the source and send API to the Agent.",
  "留空，不配置角色": "Leave empty to disable role injection",
  "不配置角色": "No role",
  "当前路由角色文件路径。": "Role file path for the current Route.",
  "当前路由角色配置目录。": "Role directory for the current Route.",
  "角色配置": "Role settings",

  "桌宠": "Desktop pet",

  "显示名称": "Display name",

  "自动化": "Automation",

  "消息模板": "Message templates",

  "消息模板规则": "Message-template rules",
  "角色自动化": "Role automation",

  "定时任务": "Scheduled tasks",

  "消息类型": "Message type",

  "个人微信 / Weixin": "Personal Weixin",
  "飞书 / Feishu": "Feishu",

  "聊天消息": "Chat messages",

  "自动化规则": "Automation rule",

  "暂无模板正文": "No custom template body",

  "入口默认": "Input defaults",
  "运行模式": "Runtime mode",
  "无角色直通": "Role-free pass-through",
  "无角色直通模式": "role-free pass-through mode",

  "路由类型": "Route kinds",

  "群聊-直接 @": "Group: direct @ mention",
  "群聊-直接回复": "Group: direct reply",
  "群聊-间接回复": "Group: reply chain",
  "群聊-普通消息": "Group: ordinary message",
  "私聊": "Private message",
  "群聊事件": "Group events",
  "私聊事件": "Private events",
  "聊天事件": "Chat events",
  "手动事件": "Manual events",

  "米家设备事件": "Xiaomi Home device event",

  "企业微信群聊": "WeCom group chat",
  "企业微信消息": "WeCom message",
  "通用外部事件": "Generic external event",
  "QQ 实时消息；可先配置规则，再回到消息连接器启用入口。": "Live QQ messages. You can configure rules first, then enable the input under Message connectors.",
  "托盘打开的本地桌面入口；自由聊天使用角色面板消息，按钮动作使用手动触发。": "Local desktop input opened from the tray. Free-form chat uses role-panel messages; button actions use manual triggers.",

  "Home Assistant 中的米家状态与摄像头事件；由 Manager 集成投递到当前角色，不会启动 Gateway 常驻 adapter。": "Xiaomi Home state and camera events from Home Assistant. The Manager integration delivers them to the current role without starting a persistent Gateway adapter.",

  "企业微信群聊消息；变量尽量对齐 NapCat 群聊，并额外提供 wecomReqId / wecomChatId。": "WeCom group messages. Variables align with NapCat group-chat fields where possible and also expose wecomReqId and wecomChatId.",
  "通用 HTTP 事件兜底入口；用于尚未命名的外部系统。": "Generic HTTP fallback for external systems that do not yet have a dedicated input.",

  "当前命中的路由类型，例如 direct_at、private、group_message、heartbeat、manual_trigger、role_panel_message、voice_transcript。": "The matched route kind, such as direct_at, private, group_message, heartbeat, manual_trigger, role_panel_message, or voice_transcript.",
  "机器人 QQ 号，来自当前消息事件 self_id。": "The bot's QQ ID from self_id on the current message event.",
  "发送者 QQ 号。": "The sender's QQ ID.",
  "群号；私聊时为空。": "The QQ group ID; empty for private messages.",
  "被回复消息 ID；非回复消息时为空。": "The replied-to message ID; empty when the message is not a reply.",
  "消息时间，已格式化为本地时间。": "The message time formatted in local time.",
  "模板渲染时的当前本地时间，等同 currentTime。": "The current local time when the template is rendered; equivalent to currentTime.",
  "模板渲染时的当前本地时间。": "The current local time when the template is rendered.",
  "当前日期，格式 YYYY-MM-DD。": "The current date in YYYY-MM-DD format.",
  "当前时分秒，格式 HH:mm:ss。": "The current clock time in HH:mm:ss format.",
  "当前 ISO 时间字符串。": "The current ISO timestamp string.",
  "当前 Unix 时间戳，单位秒。": "The current Unix timestamp in seconds.",
  "当前年份。": "The current year.",
  "当前月份，补零为两位。": "The current month, zero-padded to two digits.",
  "当前日期中的日，补零为两位。": "The current day of the month, zero-padded to two digits.",
  "当前星期，例如 星期四。": "The current weekday, for example Thursday.",
  "当前小时，补零为两位。": "The current hour, zero-padded to two digits.",
  "当前分钟，补零为两位。": "The current minute, zero-padded to two digits.",
  "当前秒数，补零为两位。": "The current second, zero-padded to two digits.",
  "目标会话描述，例如群号或私聊对象。": "A description of the target conversation, such as a group ID or private-chat peer.",
  "群消息的群号；私聊时不填充。": "The group ID for a group message; not populated for private messages.",
  "发送者显示名，优先使用群名片或昵称。": "The sender's display name, preferring the group card or nickname.",
  "原始消息文本，包含 CQ 码。": "The original message text, including CQ codes.",
  "用于路由匹配的消息文本，@ 和回复 CQ 码会转成更易匹配的文本。": "The text used for routing matches; @ mentions and reply CQ codes are normalized into match-friendly text.",
  "被回复消息对应的路由匹配文本。": "The routing-match text for the replied-to message.",
  "被回复消息的原始文本。": "The original text of the replied-to message.",
  "当前命中的 route profile ID。": "The ID of the matched Route profile.",
  "当前命中的 route profile 名称。": "The name of the matched Route profile.",
  "当前 pipeline preset / channel preset ID，例如 qq_chat、voice_chat、webhook_task。": "The current pipeline or channel preset ID, such as qq_chat, voice_chat, or webhook_task.",
  "pipelinePreset 的别名，供使用 channel 命名的模板使用。": "An alias of pipelinePreset for templates that use channel-oriented naming.",
  "pipeline 默认输入适配端。": "The pipeline's default input adapter.",
  "pipeline 默认输出适配端，例如 qq、tts、file、agent。": "The pipeline's default output adapter, such as qq, tts, file, or agent.",

  "提示词输出模式，例如 qq_text、voice_short、markdown、json。": "The prompt output mode, such as qq_text, voice_short, markdown, or json.",

  "TTS 声线 / character_id。": "The TTS voice or character_id.",
  "TTS worker 地址，只作为路由决策上下文。": "The TTS worker URL, exposed only as routing-decision context.",
  "是否建议 worker 播放，true / false。": "Whether the worker is advised to play the result: true or false.",
  "是否开启防回流策略，true / false。": "Whether feedback-loop prevention is enabled: true or false.",
  "是否默认回到原来消息端，true / false。": "Whether replies return to the source message input by default: true or false.",
  "当前选择的路由角色 ID。": "The role ID selected for the current Route.",
  "群聊消息 JSONL 记录路径。": "Path to the group-message JSONL log.",
  "私聊消息 JSONL 记录路径。": "Path to the private-message JSONL log.",
  "定时触发事件 JSONL 记录路径。": "Path to the heartbeat-event JSONL log.",
  "手动触发事件 JSONL 记录路径。": "Path to the manual-trigger event JSONL log.",
  "角色面板聊天记录 JSONL 路径。": "Path to the role-panel chat JSONL log.",
  "定时触发间隔，单位秒。": "The heartbeat interval in seconds.",

  "当前定时计划 ID；仅定时触发时填充。": "The current schedule ID; populated only for heartbeat events.",
  "当前定时计划显示名称；仅定时触发时填充。": "The current schedule display name; populated only for heartbeat events.",
  "手动触发 ID。": "The manual-trigger ID.",
  "手动触发显示名称。": "The manual-trigger display name.",
  "语音转写 JSONL 记录路径。": "Path to the voice-transcript JSONL log.",
  "语音转写来源，例如 speech、xiaoai 或 webhook。": "The transcript source, such as speech, xiaoai, or webhook.",
  "语音片段时长，单位秒。": "The voice-segment duration in seconds.",
  "语音片段峰值音量。": "The peak volume of the voice segment.",
  "企业微信 WebSocket 请求 ID，用于定位来源消息。": "The WeCom WebSocket request ID used to locate the source message.",
  "企业微信会话 ID。": "The WeCom conversation ID.",
  "企业微信群聊 chat id；模板里的 groupId 会优先使用这个值。": "The WeCom group-chat ID; the template's groupId prefers this value.",
  "企业微信发送者 userid；模板里的 userId 会优先使用这个值。": "The WeCom sender userid; the template's userId prefers this value.",
  "企业微信消息类型，例如 text、mixed、image、voice、file。": "The WeCom message type, such as text, mixed, image, voice, or file.",

  "原因：": "Reason: ",

  "远端": "Remote",
  "未验证": "Not verified",
  "下次触发": "Next trigger",
  "投递协议": "Delivery protocol",
  "手动触发": "Manual trigger",
  "计划审批": "Plan approval",

  "最后成功": "Last success",
  "最后连接": "Last connected",
  "最后断开": "Last disconnected",
  "最近消息": "Latest message",
  "线程名": "Task name",

  "当前绑定": "Current binding",

  "NapCat HTTP 地址": "NapCat HTTP URL",

  "RabiRoute WS 端口": "RabiRoute WebSocket port",
  "默认 NapCat": "Default NapCat",

  "复制 WS": "Copy WebSocket URL",
  "复制 curl": "Copy curl command",
  "复制回调": "Copy callback URL",
  "复制监听": "Copy listen URL",

  "自动生成": "Generated automatically",

  "可多选；下面只显示已选入口的参数": "Select one or more inputs. Only their settings are shown below.",

  "语音转写": "Voice transcripts",

  "已满足": "Ready",
  "缺少": "Missing",

  "聊天记录": "Chat log",

  "已配置": "Configured",

  "未启用": "Not enabled",

  "适配器日志": "Adapter log",

  "消息文件": "Message files",

  "NapCat WebUI 可访问": "NapCat WebUI reachable",

  "已登录": "Signed in",

  "角色面板": "Role panel",
  "角色面板消息": "Role-panel message",

  "定时触发": "Heartbeat",
  "定时事件": "Scheduled event",
  "定时计划在“角色配置 / 消息模板规则”的 heartbeat 规则里维护。": "Schedules are maintained by the heartbeat rule under Role / Message template rules.",
  "定时计划在“角色配置 / 消息模板规则”的 heartbeat 规则里维护。下面的忙时策略只影响 heartbeat，普通群聊、私聊和其他消息仍按正常路由直接投递。": "Schedules are maintained by the heartbeat rule under Role / Message template rules. The busy-task policy below affects only heartbeat; group, private, and other messages continue through normal routing.",

  "按固定间隔投递内部提醒": "Deliver internal reminders at a fixed interval",

  "内部定时事件；勾选后仅在规则启用且入口产生 heartbeat 时投递。": "Internal scheduled event. It is delivered only when the rule is enabled and the input emits a heartbeat.",
  "开启后，仅当 Agent 会话仍在工作时把本次 heartbeat 记为 skipped；普通消息不受影响。": "When enabled, only a heartbeat arriving while the Agent task is busy is recorded as skipped; normal messages are unaffected.",
  "Codex 消息处理 Agent 模式已开启。heartbeat 会立即交给独立消息处理 Agent，不会因为主角色会话正在工作而跳过，也不进入聊天消息合并等待。": "Codex Message Agent mode is enabled. Heartbeat is delivered immediately to an independent Message Agent, is not skipped because the Primary Role task is busy, and does not enter conversational batching waits.",
  "远端 Agent": "Remote Agent",

  "连接密码": "Connection password",

  "系统": "System",
  "实例": "Instance",
  "密码": "Password",
  "FenneNote / 芬妮笔记": "FenneNote",
  "小米音箱 / 小爱": "Xiaomi speaker / XiaoAI",
  "米家 / Xiaomi Home": "Xiaomi Home",
  "智能家居": "Smart home",

  "连接 Home Assistant": "Connect Home Assistant",

  "验证并连接": "Verify and connect",
  "检查连接": "Check connection",

  "Home Assistant 授权": "Home Assistant authorization",

  "设备控制": "Device control",

  "RabiLink / Relay 直连": "RabiLink / Relay",
  "企业微信 / WeCom": "WeCom",
  "通用 Webhook": "Generic Webhook",

  "没有专用消息端时的通用 POST 兜底入口": "Generic POST fallback when no dedicated input exists",
  "RabiRoute RabiLink 本地入口": "Local RabiRoute RabiLink endpoint",
  "电脑端 Relay worker 已接入": "PC Relay worker connected",
  "尚未收到 RabiLink Relay 任务。": "No RabiLink Relay task has been received.",
  "公网 HTTPS Relay 地址": "Public HTTPS Relay URL",
  "Rokid/灵珠插件调用公网 Relay；RabiRoute 电脑端负责从 Relay 领取任务并回填回复。": "The Rokid or Rizon plugin calls the public Relay. RabiRoute on the PC claims tasks from Relay and posts replies back.",

  "RabiLink 现在走电脑端直连 Relay；手机 App 只保留为可选调试入口，不再作为主消息中转。": "RabiLink now connects to Relay directly from the PC. The phone app remains an optional debugging path and is no longer the primary message relay.",

  "RabiRoute 通用回调入口": "Generic RabiRoute callback endpoint",
  "外部系统已配置 POST": "External system configured to POST",
  "RabiRoute 无法自动知道外部系统是否已配置；以最近请求日志为准。": "RabiRoute cannot automatically know whether the external system is configured. Use the latest request logs as evidence.",

  "企业微信智能机器人 SDK": "WeCom intelligent-bot SDK",
  "@wecom/aibot-node-sdk 已安装。": "@wecom/aibot-node-sdk is installed.",
  "填写 wecomBotId 或设置 WECOM_BOT_ID。": "Enter wecomBotId or set WECOM_BOT_ID.",
  "填写 wecomBotSecret 或设置 WECOM_BOT_SECRET。": "Enter wecomBotSecret or set WECOM_BOT_SECRET.",
  "WebSocket 已连接并认证": "WebSocket connected and authenticated",
  "启动 route 后查看连接状态。": "Start the Route and inspect the connection state.",
  "最近收到企业微信消息": "Recent WeCom message received",
  "尚未收到企业微信消息；请在企业微信群里向智能机器人发消息验证。": "No WeCom message has been received. Send a message to the intelligent bot in a WeCom group to verify it.",
  "企业微信接入说明": "WeCom integration guide",
  "企业微信接入使用智能机器人 WebSocket 长连接，不使用通用 Webhook。": "WeCom integration uses the intelligent bot's persistent WebSocket connection, not Generic Webhook.",
  "企业微信群聊模板变量会尽量对齐 NapCat：groupId、userId、sender、message、messageId。": "WeCom group-chat template variables align with NapCat where possible: groupId, userId, sender, message, and messageId.",
  "企业微信 Bot ID": "WeCom Bot ID",
  "企业微信 Bot Secret": "WeCom Bot secret",
  "企业微信 WebSocket 地址": "WeCom WebSocket URL",

  "消息数": "Message count",

  "按 voiceSource / source 匹配请求、接收、拒绝和错误等过程日志。": "Process logs for requests, acceptance, rejection, and errors, filtered by voiceSource or source.",
  "测试入口，不会自动发送。": "Test input only; nothing is sent automatically.",
  "监听": "Listen",
  "监听地址": "Listen address",
  "回调": "Callback",
  "鉴权": "Authentication",
  "来源设备": "Source device",

  "Relay 服务器地址": "Relay server URL",
  "Relay 应用 token": "Relay application token",

  "连接服务器": "Connect to server",

  "RabiLink Relay 全局连接已关闭。": "The global RabiLink Relay connection is off.",

  "检查并补齐": "Check and repair",

  "还有必要字段没有填写，请回到对应步骤补全。": "Required fields are still missing. Return to the relevant step and complete them.",
  "当前配置还不能保存。": "The current configuration cannot be saved yet.",
  "按消息入口、Agent 绑定、角色确认三步完成首次配置。": "Complete first-time setup in three steps: message input, Agent binding, and role confirmation.",
  "绑定 Agent 处理端": "Bind an Agent handler",
  "选择消息入口": "Choose message inputs",

  "复制路径": "Copy path",
  "打开本机控制台": "Open local console",
  "打开路由配置": "Open Route settings",
  "打开配置文件": "Open configuration file",

  "打开配置文件失败": "Failed to open configuration file",

  "运行数据": "Runtime data",

  "真源": "Source of truth",

  "副作用": "Side effects",
  "可以直接说": "Try saying",
  "完成标志：": "Done when: ",
  "Token 安全": "Token safety",
  "开始": "Start",

  "开发与云端": "Development & cloud",
  "安装与发布": "Install & publish",
  "安装与运行排障": "Installation & runtime troubleshooting",
  "策略、风险与审计": "Policy, risk & audit",
  "安全、浸泡、resize 和真实 Ink/Craft 运行测试全部通过。": "Safety, soak, resize, and real Ink/Craft runtime tests all passed.",
  "本地验收": "Local acceptance",
  "等待外部状态": "Waiting for external state",
  "等待后台审核": "Waiting for review",
  "等待审核通过": "Waiting for approval",
  "发布链": "Release path",
  "发布验收": "Release acceptance",
  "云端工程": "Cloud project",
  "本地 AIX": "Local AIX",
  "智能体管理": "Agent management",
  "最终用户每次使用": "Every user session",
  "创建者首次接入": "Creator setup",
  "创建者接入，只做一次": "Creator setup, once",
  "连接对话": "Connected conversation",
  "配置助手": "Configuration assistant",
  "切到配置助手": "Switch to configuration assistant",
  "切到连接对话": "Switch to connected conversation",
  "返回连接对话": "Return to connected conversation",
  "重新连接": "Reconnect",
  "确认修改": "Confirm changes",
  "取消修改": "Cancel changes",
  "Rabi 实例": "Rabi instance",
  "是否启用": "Enabled",
  "配置名": "Configuration name",
  "消息端": "Message inputs",

  "本地桌面": "Local desktop",

  "实验": "Experimental",
  "未扫描": "Not scanned",
  "扫描中": "Scanning",

  "实时消息": "Live messages",

  "添加消息端": "Add message input",

  "已验证": "Verified",
  "已发现": "Detected",

  "配置版本": "Configured version",
  "运行版本": "Running version",

  "快速配置 RabiRoute": "Quick setup for RabiRoute",
  "Agent 绑定": "Agent binding",
  "角色与保存": "Role & save",
  "版本": "Version",
  "角色可选与配置确认": "Optional role and configuration review",
  "默认角色 ID": "Default role ID",

  "项目目录": "Project directory",
  "未填写": "Not set",
  "线程": "Task",
  "稍后再配": "Configure later",
  "QQ 群聊、私聊实时入口": "Real-time QQ group and private messages",
  "企业微信群聊双向入口": "Two-way WeCom group messages",

  "眼镜是消息来源；系统内置 RabiLink 负责转接": "Glasses are the message source; the built-in RabiLink service handles forwarding",
  "真实消息由 Codex/ChatGPT Desktop 当前任务执行": "Real messages run in the current Codex/ChatGPT Desktop task",
  "实验支持，需要本机登录状态": "Experimental; requires a local signed-in session",
  "占位支持，人工接力模式": "Placeholder support with manual handoff",
  "实验支持，可绑定 ChatUI 会话": "Experimental; can bind a ChatUI session",
  "当前 AstrBot": "Current AstrBot",
  "已填写本地 AstrBot 密码，保存后写入 route 配置。": "A local AstrBot password is set and will be written to the Route configuration on save.",
  "缺少 AstrBot 密码；请填写本地配置或设置 ASTRBOT_PASSWORD。": "AstrBot password is missing. Enter it locally or set ASTRBOT_PASSWORD.",
  "已填写本地 AstrBot 密码，尚未验证登录。": "A local AstrBot password is set, but sign-in has not been verified.",
  "占位": "Placeholder",
  "RabiRoute 根目录": "RabiRoute root",
  "AstrBot 地址/项目": "AstrBot URL / project",
  "应用 ID": "Application ID",
  "项目目录 (-C)": "Project directory (-C)",
  "AstrBot 会话": "AstrBot session",
  "接力模式": "Handoff mode",
  "未选择，使用插件默认管线": "Not selected; use the plugin's default pipeline",
  "不绑定会话": "No task binding",
  "未命名项目": "Unnamed project",

  "需要小爱桥接层：PC 侧 xiaoai-rabiroute 服务 + 音箱侧 open-xiaoai/xiaogpt/自定义桥，把语音文本转发到这个地址。": "A XiaoAI bridge is required: run xiaoai-rabiroute on the PC and open-xiaoai, xiaogpt, or a custom bridge on the speaker to forward transcripts to this URL.",
  "RabiLink 电脑端直连 Relay：在全局 RabiLink 配置里填写公网 Relay 地址和应用 token 后，可把 Rokid/灵珠文本转给所选 Agent，并把回复写回眼镜侧。": "RabiLink connects the PC directly to Relay. Set the public Relay URL and application token in global RabiLink settings to send Rokid/Rizon text to the selected Agent and return replies to the glasses.",
  "通用 Webhook 只适合未命名外部系统；如果来源是具体工具，建议添加对应的专用消息端。": "Generic Webhook is only for unnamed external systems. Add a dedicated message input when the source is a known tool.",
  "已复制": "Copied",

  "已尝试打开 Marvis。": "Tried to open Marvis.",
  "打开 Marvis 失败。": "Failed to open Marvis.",
  "AstrBot 登录验证成功。": "AstrBot sign-in verified.",
  "AstrBot 登录验证失败。": "AstrBot sign-in verification failed.",
  "消息入口还有必要字段没有填写，请回到第一步补全端口、地址或路径。": "Required message-input fields are missing. Return to step one and complete the port, URL, or path.",
  "Agent 绑定还有必要字段没有填写，请回到第二步补全项目目录、会话或服务地址。": "Required Agent-binding fields are missing. Return to step two and complete the project directory, task, or service URL.",
  "选择项目目录和会话线程": "Select a project directory and task",
  "新建配置": "New configuration",
  "可以组合多个入口；单个入口可在消息连接器页继续停用或调整权限。": "You can combine multiple inputs. Disable an individual input or adjust its permissions later on the Message connectors page.",
  "已复制 NapCat WS 地址": "NapCat WebSocket URL copied",
  "可访问": "Reachable",
  "未发现 NapCat/QQNT 相关进程": "No NapCat or QQNT process found",
  "可留空后改用 WECOM_BOT_ID": "Leave empty to use WECOM_BOT_ID",
  "企业微信智能机器人 Bot ID；群聊消息会映射到 groupId。": "WeCom intelligent-bot ID. Group messages map to groupId.",
  "可留空后改用 WECOM_BOT_SECRET": "Leave empty to use WECOM_BOT_SECRET",
  "保存到本地 route 配置；公开示例不要写真实密钥。": "Saved in the local Route configuration. Never put a real secret in public examples.",
  "留空使用 SDK 默认地址；私有部署或调试时填写": "Leave empty to use the SDK default URL; set this for private deployments or debugging",
  "企业微信智能机器人 WebSocket": "WeCom intelligent-bot WebSocket",
  "群聊变量": "Group-message variables",
  "WeCom 会作为独立消息端启动，本地 gateway 主动连接企业微信；Agent 回发仍经过 RabiRoute outbox 和 messageAdapterPolicies.wecom。": "WeCom starts as an independent message input and the local Gateway connects to WeCom. Agent replies still pass through the RabiRoute Outbox and messageAdapterPolicies.wecom.",
  "保存后可在运行日志里手动触发一次，用来验证 Agent 端是否能收到心跳。": "After saving, trigger one heartbeat from Runtime logs to verify that the Agent receives it.",

  "这里只复制": "This only copies the",
  "配置说明": "Setup guide",
  "已复制监听地址": "Listen URL copied",
  "已复制 curl 示例": "curl example copied",
  "DSH 会话是主角色投递目标：通过 DSH apiproxy": "The DSH session is the Primary Role delivery target. RabiRoute uses the DSH apiproxy",
  "（mode=queue）注入消息。DSH 会话在 DeepSeek Harness Web GUI 中创建和管理；RabiRoute 不创建、不重命名、不归档 DSH 会话。仍为实验性：尚未自动执行真实消息注入烟测。": "to inject messages with mode=queue. DSH sessions are created and managed in the DeepSeek Harness Web GUI; RabiRoute does not create, rename, or archive them. This remains experimental: no automated real-message injection smoke test has run yet.",
  "DSH 会话是主角色投递目标；通过 DSH apiproxy": "The DSH session is the Primary Role delivery target; RabiRoute uses the DSH apiproxy",

  "DSH 会话 ID": "DSH session ID",
  "在 DeepSeek Harness Web GUI 的会话页复制。格式固定：session-<uuid>": "Copy it from the session page in the DeepSeek Harness Web GUI. Format: session-<uuid>.",
  "DSH 会话名称": "DSH session name",
  "可选标识，只用于显示，不改变 Harness 的会话名": "Optional display label; it does not rename the Harness session.",
  "DSH 绑定需要明确工作目录；应与 DSH 会话的 cwd 一致": "A DSH binding needs an explicit working directory that matches the DSH session cwd.",
  "DSH API 基地址": "DSH API base URL",
  "本机 DeepSeek Harness 的 apiproxy 入口；默认 http://127.0.0.1:3080": "Local DeepSeek Harness apiproxy endpoint. Default: http://127.0.0.1:3080.",
  "Agent 模型（播放文字）": "Agent model (spoken text)",
  "留空使用默认": "Leave empty to use the default",
  "额度不足时可切到 gpt-5.3。可手动输入自定义模型名。": "Switch to gpt-5.3 if quota is limited. You can also enter a custom model name.",
  "模型": "Model",
  "实验支持，通过 session.prompt API 投递消息": "Experimental support; messages are delivered through the session.prompt API.",
  "DSH 会话": "DSH session",
  "未填写 DSH 会话 ID": "DSH session ID not provided",
  "DSH 需要填写完整的 session-<uuid> 会话 ID 和工作目录；会话请先在 DSH WebGUI 中创建。": "DSH requires a full session-<uuid> session ID and working directory. Create the session in DSH WebGUI first.",
  "· 默认模型": "· Default model",
  "快速配置只绑定一个 Agent；先确定处理端和项目目录，再选择会话。": "Quick setup binds one Agent. Choose the handler and project directory first, then select a task.",
  "所有已支持的 Agent 都在这里选择；高级字段会随处理端变化": "Choose from all supported Agents here. Advanced fields change with the selected handler",
  "Codex/ChatGPT Desktop 是真实消息的唯一 owner。RabiRoute 读取 Desktop 可见任务目录并通过 Desktop IPC 投递；Codex CLI 是独立 Runtime，不作为 Desktop 投递的备用路径。": "Codex/ChatGPT Desktop is the sole owner of real messages. RabiRoute reads Desktop-visible tasks and delivers through Desktop IPC. Codex CLI is a separate runtime and is not a fallback for Desktop delivery.",
  "Copilot CLI 仍是实验适配；同一会话重复注入还需要单独烟测确认。": "Copilot CLI remains experimental. Repeated delivery into the same session still requires a separate smoke test.",
  "AstrBot 必须绑定 ChatUI 项目和会话；消息只通过 /api/chat/send 投递。": "AstrBot requires a ChatUI project and session; messages are sent only through /api/chat/send.",

  "AstrBot 未选择 ChatUI 会话，无法通过 /api/chat/send 投递。": "AstrBot cannot send through /api/chat/send until a ChatUI session is selected.",
  "Marvis 当前是人工接力模式：RabiRoute 会打开应用并复制 prompt，不会绑定会话线程。": "Marvis currently uses manual handoff: RabiRoute opens the application and copies the prompt without binding a task.",
  "Marvis 应用 ID": "Marvis application ID",
  "留空使用默认 Tencent.Marvis": "Leave empty to use the default Tencent.Marvis",
  "先打开 Marvis 确认应用可用；路由触发时会把 prompt 放到剪贴板。": "Open Marvis first to confirm it is available. Route delivery places the prompt on the clipboard.",
  "AstrBot 地址": "AstrBot URL",
  "AstrBot Dashboard / API 地址": "AstrBot Dashboard / API URL",
  "AstrBot 用户名": "AstrBot username",
  "留空使用环境变量 ASTRBOT_USERNAME": "Leave empty to use ASTRBOT_USERNAME",
  "AstrBot 密码": "AstrBot password",
  "留空使用环境变量 ASTRBOT_PASSWORD": "Leave empty to use ASTRBOT_PASSWORD",
  "AstrBot 项目": "AstrBot project",
  "可选：先选项目再筛选会话": "Optional: select a project to filter sessions",
  "选择一个 ChatUI 会话": "Select a ChatUI session",
  "验证": "Verification",
  "验证登录": "Verify sign-in",
  "留空使用 PATH 中的 copilot": "Leave empty to use copilot from PATH",
  "会话列表会按这个目录过滤": "Tasks are filtered by this directory",
  "留空，使用 RabiRoute 根目录": "Leave empty to use the RabiRoute root",
  "用于同名任务的自动查找和新建；选择已有任务时会采用任务自己的目录": "Used to find or create a task with the same name. Selecting an existing task uses that task's own directory.",
  "选择已有会话，或输入新会话名": "Select an existing task or enter a new task name",

  "每次读取 200 个 Desktop 任务；可继续加载，输入名称后先自动查找，只有不存在时才创建": "Loads 200 Desktop tasks at a time. More pages can be loaded; a typed name is searched first and created only when it does not exist.",
  "没有扫到时也可以手动填写": "Enter a value manually when scanning finds nothing",
  "/3 已完成": "/3 complete",

  "WS：请在 NapCat WebSocket Client 里连接": "WebSocket: connect the NapCat WebSocket Client to",
  "进程：": "Process: ",
  "未响应": "Unreachable",
  "未读取到会话": "No tasks found",

  "启用": "Enable",

  "最长等待（秒）": "Maximum wait (seconds)",
  "消息处理 Agent 模式": "Message Agent mode",

  "推理强度": "Reasoning effort",
  "），由该任务以其自带的模型、工具和审批真实执行。 会话 ID 是投递路由键：向同一任务连续投递不会新建任务。使用前请在 WorkBuddy 中打开目标任务，并准备本地网关凭据文件。 仍为实验性：凭据需手工配置，桌面配对入口尚未提供。": "), and the task runs it for real with its own model, tools and approvals. The session ID is the delivery routing key: repeated deliveries to the same task never create a new task. Before use, open the target task in WorkBuddy and prepare the local gateway credential file. Still experimental: the credential is configured manually and no desktop pairing entry point exists yet.",
  "把消息投递到指定会话，由该会话以其自带的模型、工具真实执行。 会话 ID 是投递路由键：向同一会话连续投递不会新建会话。使用前请先打开 Antigravity 桌面。 仍为实验性：宿主版本升级可能改动 agentapi 子命令契约。": "interface into the named conversation, and that conversation runs them for real with its own model and tools. The conversation ID is the delivery routing key: repeated deliveries to the same conversation never create a new conversation. Open the Antigravity desktop before use. Still experimental: a host upgrade may change the agentapi subcommand contract.",
  "（mode=queue）注入消息。 DSH 会话在 DeepSeek Harness Web GUI 中创建和管理；RabiRoute 不创建、不重命名、不归档 DSH 会话。 仍为实验性：尚未自动执行真实消息注入烟测。": "to inject messages with mode=queue. DSH sessions are created and managed in the DeepSeek Harness Web GUI; RabiRoute does not create, rename, or archive them. This remains experimental: no automated real-message injection smoke test has run yet.",
};
const inlineEnglishCatalog: Record<string, string> = {
  "NapCat / OneBot": "NapCat / OneBot",
  "已禁用": "Disabled",
  "定时触发": "Heartbeat",
  "角色面板": "Role panel",
  "远端 Agent": "Remote Agent",
  "语音消息端": "Speech endpoint",
  "通用 Webhook": "Generic Webhook",
  "企业微信 / WeCom": "WeCom",
  "小米音箱 / 小爱": "Xiaomi speaker / XiaoAI",
  "FenneNote / 芬妮笔记": "FenneNote",
  "RabiLink / Relay 直连": "RabiLink / Relay",
  "眼镜端（经 RabiLink）": "Glasses (via RabiLink)",
  "智能手表/手环": "Smartwatch / band"
};
function translateInline(value: string): string {
  return Object.entries(inlineEnglishCatalog).reduce(
    (result, [source, target]) => result.replaceAll(source, target),
    value
  );
}
function translateKnownTerm(value: string): string {
  return englishCatalog[value] || pluginTranslation("en", value) || translateInline(value);
}
const adapterLabelPattern = "(?:NapCat / OneBot|定时触发|角色面板|远端 Agent|语音消息端|通用 Webhook|企业微信 / WeCom|小米音箱 / 小爱|米家 / Xiaomi Home|FenneNote / 芬妮笔记|RabiLink / Relay 直连|眼镜端（经 RabiLink）|智能手表/手环|已禁用)";
const adapterSummaryPattern = new RegExp(`^${adapterLabelPattern}(?: \\+ ${adapterLabelPattern})*$`);
const routeWithAdapterSummaryPattern = new RegExp(`^(.+) · (${adapterLabelPattern}(?: \\+ ${adapterLabelPattern})*)$`);
export const englishPatterns: Array<[RegExp, (...matches: string[]) => string]> = [
  [/^(\d+) 台 · 更新于 (.+)$/, (_value, count, updatedAt) => `${count} computers · Updated ${updatedAt}`],
  [/^远端智能体（(.+)）$/, (_value, address) => `Remote Agent (${translateKnownTerm(address)})`],
  [/^已复制完整提示词（含 30 分钟一次性票据），有效期至 (.+)。请粘贴给目标电脑上的智能体，成功兑换后票据立即失效。$/, (_value, expiry) => `Copied the complete prompt with a one-time ticket valid for 30 minutes, until ${expiry}. Paste it into an Agent on the target computer. The ticket expires immediately after successful redemption.`],
  [/^(.+)：路由与智能体设置$/, (_value, name) => `${name}: Route and Agent settings`],
  [/^QQ (\d+) 已登录。$/, (_value, id) => `QQ ${id} is signed in.`],
  [/^QQ (\d+) 已登录但当前离线。$/, (_value, id) => `QQ ${id} is signed in but currently offline.`],
  [/^QQ (\d+) 已离线，请重新登录。$/, (_value, id) => `QQ ${id} is offline. Sign in again.`],
  [/^当前账号 QQ (\d+)，与此 Route 绑定 QQ (\d+) 不一致。$/, (_value, actual, expected) => `Current account QQ ${actual} does not match QQ ${expected} bound to this Route.`],
  [/^此 Route 绑定 QQ (\d+)，但 OneBot HTTP 返回 QQ (\d+)(.*?)；请检查此实例的 HTTP 地址。$/, (_value, expected, actual, name) => `This Route is bound to QQ ${expected}, but OneBot HTTP returned QQ ${actual}${name}. Check this instance's HTTP URL.`],
  [/^NapCat 当前登录 QQ (\d+)，但此 Route 绑定 QQ (\d+)；请在当前登录卡片切换到正确账号。$/, (_value, actual, expected) => `NapCat is signed in as QQ ${actual}, but this Route is bound to QQ ${expected}. Switch to the correct account on this card.`],
  [/^NapCat 管理服务未响应（(.+)）；请启动此实例后刷新登录状态。$/, (_value, url) => `NapCat management did not respond (${url}). Start this instance and refresh sign-in status.`],
  [/^当前账号：QQ\s*(.*)$/, (_value, account) => `Current account: QQ ${account}`],
  [/^此 Route 绑定：QQ\s*(.*)$/, (_value, account) => `Account bound to this Route: QQ ${account}`],
  [/^复制失败：(.+)$/, (_value, error) => `Copy failed: ${translateKnownTerm(error)}`],
  [/^监听地址由 GATEWAY_MANAGER_HOST=(.+) 管理。$/, (_value, host) => `The listen address is managed by GATEWAY_MANAGER_HOST=${host}.`],
  [/^规则 (\d+)$/, (_value, index) => `Rule ${index}`],
  [/^查看全部 (\d+) 个步骤$/, (_value, count) => `View all ${count} steps`],
  [/^计划 (\d+)$/, (_value, index) => `Schedule ${index}`],
  [/^路由配置 (\d+)$/, (_value, index) => `Route ${index}`],
  [/^(\d+) 条规则$/, (_value, count) => `${count} rules`],
  [/^(\d+) 条任务$/, (_value, count) => `${count} tasks`],
  [/^每天 (.+)$/, (_value, time) => `Every day at ${time}`],
  [/^一次：(.+)$/, (_value, time) => `Once: ${time}`],
  [/^每 (\d+) 秒一个图表点$/, (_value, seconds) => `One chart point every ${seconds} seconds`],
  [/^(\d+) 个文件 · (\d+) 条内存记录$/, (_value, files, records) => `${files} files · ${records} in-memory records`],
  [/^每 (\d+) 秒(.*)$/, (_value, seconds, window) => `Every ${seconds} seconds${window ? window.replace(/^，/, ", ") : ""}`],
  [/^运行 (.+)$/, (_value, scriptPath) => `Run ${scriptPath}`],
  [/^(\d+) 条模板$/, (_value, count) => `${count} templates`],
  [/^(\d+) 个分段$/, (_value, count) => `${count} segments`],
  [/^(\d+) 个分段 ·$/, (_value, count) => `${count} segments ·`],
  [/^已找到 (\d+) 个本次候选$/, (_value, count) => `${count} candidates found for this attempt`],
  [/^(\d+) 个入口启用$/, (_value, count) => `${count} inputs enabled`],
  [/^常驻监听中 · (\d+) 个 Route 已订阅$/, (_value, count) => `Persistent listening · ${count} Routes subscribed`],
  [/^等待广播给 (\d+) 个 Route$/, (_value, count) => `Waiting to broadcast to ${count} Routes`],
  [/^(\d+) 个待检查项$/, (_value, count) => `${count} items to check`],
  [/^默认 (\d+) · 上限 (\d+)$/, (_value, fallback, maximum) => `Default ${fallback} · Maximum ${maximum}`],
  [/^0 表示不注入 (.+) 历史；未单独设置时使用 (\d+) 条。$/, (_value, endpoint, fallback) => `0 disables ${translateKnownTerm(endpoint)} history injection; unset values use ${fallback} messages.`],
  [/^已删除说话人资料，并解除 (\d+) 条绑定。$/, (_value, count) => `Speaker profile deleted and ${count} bindings removed.`],
  [/^已看到 (\d+) 句话 · 预览最近 (\d+) 句$/, (_value, total, preview) => `${total} utterances found · previewing the latest ${preview}`],
  [/^(\d+) 个会话 · (\d+) 句话 · 预览最近 (\d+) 句$/, (_value, sessions, total, preview) => `${sessions} sessions · ${total} utterances · previewing the latest ${preview}`],
  [/^这个分段说话人的最近 (\d+) 句话$/, (_value, count) => `Latest ${count} utterances from this diarization speaker`],
  [/^已选 (\d+)$/, (_value, count) => `${count} selected`],
  [/^(\d+)\/3 已完成$/, (_value, count) => `${count}/3 complete`],
  [/^角色 ID · (.+)$/, (_value, id) => `Role ID · ${id}`],
  [/^自动：(.+)$/, (_value, name) => `Automatic: ${name}`],
  [/^已复制 (.+) 回调地址$/, (_value, label) => `${translateKnownTerm(label)} callback URL copied`],
  [/^NapCat WebUI 未响应：(.+)$/, (_value, url) => `NapCat WebUI did not respond: ${url}`],
  [/^可用，(.+)$/, (_value, account) => `Available, ${account}`],
  [/^角色 (.+) · (.+)$/, (_value, role, adapters) => `Role ${role} · ${translateInline(adapters)}`],
  [routeWithAdapterSummaryPattern, (_value, route, adapters) => `${route} · ${translateInline(adapters)}`],
  [adapterSummaryPattern, (value) => translateInline(value)],
  [/^当前路由指向 (.+)。$/, (_value, role) => `Current Route uses ${role}.`],
  [/^(.+) · 匹配：(.+)$/, (_value, routeKind, regex) => `${translateKnownTerm(routeKind)} · Match: ${regex}`],
  [/^(.+) · 不限关键词$/, (_value, routeKind) => `${translateKnownTerm(routeKind)} · Any keyword`],
  [/^(定时触发|手动触发|角色面板消息|企业微信消息|群聊-直接 @|群聊-直接回复|群聊-间接回复|群聊-普通消息|私聊|语音转写) \/ (.+)$/, (_value, routeKind, id) => `${translateKnownTerm(routeKind)} / ${id}`],
  [/^最后成功 (.+)$/, (_value, time) => `Last success: ${time}`],
  [/^用时 (\d+) ms$/, (_value, duration) => `${duration} ms`],
  [/^缺少：(.+)$/, (_value, detail) => `Missing: ${translateInline(detail)}`],
  [/^当前类型：(.+)$/, (_value, type) => `Current type: ${translateInline(type)}`],
  [/^版本\/状态：(.+)$/, (_value, status) => `Version/status: ${status}`],
  [/^可选 (\d+) 个$/, (_value, count) => `${count} available`],
  [/^(.+)（未连接）$/, (_value, name) => `${name} (disconnected)`],
  [/^(.+) 监听地址$/, (_value, label) => `${translateKnownTerm(label)} listen address`],
  [/^(.+) 监听端口$/, (_value, label) => `${translateKnownTerm(label)} listen port`],
  [/^(.+) HTTP 地址$/, (_value, label) => `${translateKnownTerm(label)} HTTP URL`],
  [/^(.+) 端口$/, (_value, label) => `${translateKnownTerm(label)} port`],
  [/^(.+) 路径$/, (_value, label) => `${translateKnownTerm(label)} path`],
  [/^(.+) · (未响应|未扫描|可用)$/, (_value, target, status) => `${target} · ${status === "未响应" ? "unreachable" : status === "可用" ? "available" : "not scanned"}`],
  [/^(.+) 回调入口$/, (_value, label) => `${translateKnownTerm(label)} callback endpoint`],
  [/^(.+) 使用 HTTP 回调接收事件。$/, (_value, label) => `${translateKnownTerm(label)} receives events through an HTTP callback.`],
  [/^(.+) 适配器日志$/, (_value, label) => `${translateKnownTerm(label)} adapter log`],
  [/^暂无 (.+) 日志$/, (_value, label) => `No ${translateKnownTerm(label)} log`],
  [/^(.+) 消息文件$/, (_value, label) => `${translateKnownTerm(label)} message files`],
  [/^(.+) · 已禁用 · (.+)$/, (_value, name, adapters) => `${name} · Disabled · ${translateInline(adapters)}`],
  [/^RabiRoute 根目录 \/ (.+)$/, (_value, task) => `RabiRoute root / ${task}`],
  [/^Manager (已连接|未连接)$/, (_value, state) => `Manager ${state === "已连接" ? "connected" : "disconnected"}`],
  [/^RabiLink Relay 连接失败：(.+)$/, (_value, error) => `RabiLink Relay connection failed: ${error}`],
  [/^已触发「(.+)」，请在最近日志和通知数里确认投递结果。$/, (_value, rule) => `Triggered “${rule}”. Check Recent logs and Delivery count for the result.`],
  [/^已接受「(.+)」，正在后台投递；请在最近日志中确认最终结果。$/, (_value, rule) => `Accepted “${rule}”. Delivery continues in the background; check Recent logs for the final result.`],
  [/^「(.+)」已经在后台投递中，没有重复启动；请在最近日志中确认最终结果。$/, (_value, rule) => `“${rule}” is already being delivered in the background, so no duplicate was started. Check Recent logs for the final result.`],
  [/^删除路由配置「(.+)」？\n\n只会删除 adapterConfig\.json 并停止该路由，历史消息和日志会保留在路由目录里。$/, (_value, name) => `Delete Route configuration “${name}”?\n\nOnly adapterConfig.json is deleted and the Route is stopped. Historical messages and logs remain in the Route directory.`],
  [/^已为 (.+) 重新分配 (.+) 端口：(.+) -> (.+)。$/, (_value, route, adapter, previous, next) => `Reassigned the ${adapter} port for ${route}: ${previous} -> ${next}.`],
  [/^规则 (\d+) · (.+)$/, (_value, index, detail) => `Rule ${index} · ${detail}`],
  [/^当前 WebUI QQ：(.+)，输入验证码：(.+)$/, (_value, qq, code) => `Current WebUI QQ: ${qq}; verification code: ${code}`],
  [/^当前 WebUI 会话是 (.+)，但这个 Rabi 实例绑定的是 QQ (.+)。WebUI 会话只用于诊断和进入管理页，不会覆盖实例身份；修复 OneBot 前请先切到正确 QQ。$/,
    (_value, current, expected) => `The current WebUI session is ${current}, but this Rabi instance is bound to QQ ${expected}. The WebUI session is only used for diagnostics and management access; switch to the correct QQ before repairing OneBot.`]
];
