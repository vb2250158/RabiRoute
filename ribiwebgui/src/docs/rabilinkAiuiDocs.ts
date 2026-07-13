export type DocFlowNodeKind = "input" | "mode" | "agent" | "service" | "decision" | "result" | "warning";

export type DocFlowNode = {
  title: string;
  detail: string;
  icon: string;
  kind: DocFlowNodeKind;
};

export type DocFlowLane = {
  label: string;
  steps: DocFlowNode[];
};

export type DocFlowDiagram = {
  title: string;
  caption: string;
  lanes: DocFlowLane[];
};

export type RabiLinkQuickStartStep = {
  title: string;
  instruction: string;
  completeWhen: string;
  icon: string;
  action?: {
    label: string;
    href: string;
    external?: boolean;
  };
};

export type RabiLinkQuickStartPhase = {
  title: string;
  note: string;
  steps: RabiLinkQuickStartStep[];
};

export type RabiLinkQuickStartGuide = {
  phases: RabiLinkQuickStartPhase[];
  voiceCommands: string[];
  securityNotes: string[];
};

export type RabiLinkAiuiDocPage = {
  id: string;
  title: string;
  section: "RabiLink AIUI";
  subtitle: string;
  summary: string;
  bullets: string[];
  diagram: DocFlowDiagram;
  quickStart?: RabiLinkQuickStartGuide;
};

export const rabiLinkAiuiDocPages: RabiLinkAiuiDocPage[] = [
  {
    id: "rabilink-quick-start",
    title: "快速开始",
    section: "RabiLink AIUI",
    subtitle: "创建者完成 Relay、变量、AIUI 页面与发布绑定，最终用户打开后即可连接 Agent 对话或使用原生配置助手。",
    summary: "RabiLink AIUI 由同一个 Rokid RabiLink 智能体和挂载在它下面的 rabilink-aiui.aix 界面包组成，不是需要再连接另一个助手的独立应用。创建者把同一枚 RabiLink 应用 token 配到 PC，并保存为该智能体的记忆变量 rabilinkToken，再把 AIUI 页面工具的 token 参数绑定到这个变量。最终用户在眼镜上不会看到或填写 token。",
    bullets: [
      "RabiLink 是智能体实体，负责提示词和记忆变量；rabilink-aiui.aix 提供可由 Agent 调起的界面工具。",
      "应用 token 在 Relay 管理页创建，不是 Rokid 账号密码，也不是随便填写的名称。",
      "token 通常以 rbl_ 开头；PC 配置与智能体变量 rabilinkToken 使用同一枚完整 token。",
      "pages/home/index 页面工具的 token 参数必须引用 rabilinkToken，不能交给模型生成或向用户追问。",
      "不需要额外导入 RabiLinkMessage MCP/插件；AIX 已包含输入事件、持续下行流和配置接口。",
      "PC worker 在线后，还要在 Relay 应用卡片的“通讯 Rabi PC”里选择这台电脑。",
      "首次接入由智能体创建者完成；眼镜用户打开 RabiLink 后直接进入默认连接对话模式。"
    ],
    quickStart: {
      phases: [
        {
          title: "创建者首次接入",
          note: "这些步骤只由智能体创建者完成一次。已经有应用 token 时，不要重复创建应用，直接复制现有 token。",
          steps: [
            {
              title: "打开 Relay 管理页",
              instruction: "打开 RabiLink Relay 的 /manage 页面。首次使用选择“注册账号”或“创建第一个账号”；以后直接登录。",
              completeWhen: "页面顶部显示当前账号，并出现“创建应用”和“应用列表”。",
              icon: "mdi-web",
              action: {
                label: "打开 Relay 管理页",
                href: "https://your-relay.example.com/manage",
                external: true
              }
            },
            {
              title: "创建应用并复制 token",
              instruction: "在“创建应用”中把应用名称填写为 RabiLink AIUI，点击“创建应用”。然后在应用列表找到它，点击“复制 token”。",
              completeWhen: "剪贴板中得到一枚以 rbl_ 开头的完整 token。页面上的短预览不能代替完整 token。",
              icon: "mdi-key-variant"
            },
            {
              title: "把 Relay 和 token 配到 PC",
              instruction: "打开本机 RibiWebGUI 的“控制台”，找到“Rabi 实例 > RabiLink Relay”，填写 Relay 服务器地址和刚复制的“Relay 应用 token”，然后点击卡片右上角“保存”。",
              completeWhen: "页面提示“已保存 Rabi 实例配置”，Relay 管理页随后能看到这台 PC Rabi 在线。",
              icon: "mdi-desktop-tower-monitor",
              action: {
                label: "打开本机控制台",
                href: "/#/overview"
              }
            },
            {
              title: "为应用选择通讯 PC",
              instruction: "回到 Relay 管理页，在 RabiLink AIUI 应用卡片中打开“通讯 Rabi PC”，选择刚刚上线的这台电脑。",
              completeWhen: "应用卡片不再显示“未选择 Rabi PC”，而是显示目标电脑名称或 GUID。",
              icon: "mdi-lan-connect"
            },
            {
              title: "创建智能体记忆变量",
              instruction: "打开 RabiLink 智能体的编辑页，在“记忆 > 变量”中创建 rabilinkToken，并把完整 token 保存为变量值。不要把 token 写进人设提示词、AGENTS.md、AIX 文件或公开知识库。",
              completeWhen: "变量列表显示 rabilinkToken；聊天内容和智能体提示词中不出现完整 token。",
              icon: "mdi-variable"
            },
            {
              title: "绑定 AIUI 页面参数",
              instruction: "打开 pages/home/index（RabiLink AIUI）页面工具设置，把 token 默认值从“输入”改为“引用变量/记忆变量”，选择 rabilinkToken，然后保存。mode 和 intent 由 Agent 根据用户需求填写。",
              completeWhen: "页面工具的 token 参数显示引用 rabilinkToken；预览中询问 Relay 状态时，智能体会打开对应 UI，且不会询问用户 token。",
              icon: "mdi-link-variant"
            }
          ]
        },
        {
          title: "最终用户开始使用",
          note: "智能体发布并同步后，用户不需要获取 token，也没有首次连接表单。",
          steps: [
            {
              title: "直接开始连接对话",
              instruction: "打开 RabiLink 后直接说话。连接对话是默认模式，页面会显示最新识别文本，并持续接收、播报 Agent 回复和主动消息。",
              completeWhen: "讲话内容同步到 PC，Agent 回复回到眼镜并由原生 TTS 播报。",
              icon: "mdi-microphone-outline"
            },
            {
              title: "切到配置助手",
              instruction: "在连接对话页面向后滑动，或直接向眼镜原生助手提出配置需求。同一个 InkView 会停止连接 ASR 并切换到配置助手，不退出页面。",
              completeWhen: "滑轨选中“配置助手”，页面仍处于同一个沉浸界面。",
              icon: "mdi-account-voice"
            },
            {
              title: "由原生 Agent 理解并调用",
              instruction: "向眼镜原生助手描述目标，例如“读取当前配置”。原生 Agent 会把需求归一化为明确 intent，再调用 AIUI 对应配置接口。页面不会自行启动第二轮 ASR 或创建任务。",
              completeWhen: "配置助手显示 PC 接口的真实结果；需要写入时仍按 PC Action Gate 的确认规则执行。",
              icon: "mdi-message-cog-outline"
            },
            {
              title: "回到连接对话",
              instruction: "在配置助手页面向前滑动，或让原生 Agent 发送“切到连接对话”。同一页面会恢复前台 ASR 和持续消息流。",
              completeWhen: "滑轨选中“连接对话”，最新消息仍然保留。",
              icon: "mdi-swap-horizontal"
            }
          ]
        }
      ],
      voiceCommands: [
        "打开 RabiLink",
        "切到配置助手",
        "切到连接对话",
        "重新连接",
        "确认修改",
        "取消修改"
      ],
      securityNotes: [
        "不要把完整 token 发到聊天、截图、公开文档或 GitHub；它相当于这个 RabiLink 应用的访问凭据。",
        "如果 token 已经泄露，在 Relay 应用卡片点击“重新生成 token”，然后同步更新 PC 配置和智能体变量 rabilinkToken。",
        "AIUI 页面工具的 token 参数必须使用变量引用，不能保持为模型“输入”；最终用户也不需要知道这枚 token。",
        "应用卡片上的 token 预览不是完整 token；创建者接入时必须使用“复制 token”得到的完整值。"
      ]
    },
    diagram: {
      title: "用户首次接入与开始使用",
      caption: "同一枚应用 token 只连接 Relay、PC 和 AIUI 页面工具；眼镜用户直接使用已经发布的 RabiLink AIUI。",
      lanes: [
        {
          label: "创建者接入，只做一次",
          steps: [
            { title: "登录 /manage", detail: "注册或登录账号", icon: "mdi-account-key-outline", kind: "input" },
            { title: "创建 RabiLink AIUI", detail: "复制完整 rbl_ token", icon: "mdi-key-variant", kind: "service" },
            { title: "配置 PC", detail: "填写 Relay 地址和 token", icon: "mdi-desktop-tower-monitor", kind: "service" },
            { title: "选择通讯 PC", detail: "在应用卡片完成绑定", icon: "mdi-lan-connect", kind: "decision" },
            { title: "配置智能体变量", detail: "保存为 rabilinkToken", icon: "mdi-variable", kind: "agent" },
            { title: "绑定页面并发布", detail: "UI Tool 引用变量", icon: "mdi-link-variant", kind: "result" }
          ]
        },
        {
          label: "最终用户每次使用",
          steps: [
            { title: "打开 RabiLink AIUI", detail: "原生助手调起智能体", icon: "mdi-glasses", kind: "input" },
            { title: "连接对话", detail: "ASR + 持续消息流 + TTS", icon: "mdi-microphone-outline", kind: "mode" },
            { title: "向后滑动", detail: "同页切换模式", icon: "mdi-gesture-swipe-horizontal", kind: "input" },
            { title: "原生 Agent", detail: "理解并传入明确配置指令", icon: "mdi-account-voice", kind: "agent" },
            { title: "确认并完成", detail: "需要时切回连接对话", icon: "mdi-check-circle-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-install-release",
    title: "安装与发布",
    section: "RabiLink AIUI",
    subtitle: "AIX 上传、云端绑定、提审、手机添加和眼镜同步是五个不同阶段。",
    summary: "Rokid AI App 没有公开的 .aix 文件安装入口，ADB 也不能直接打开内部智能体管理页。正确链路是：在 Craft 上传 AIX 到 RabiLink，切换到云端 RabiLink 工程，提交审核；审核通过后在手机智能体商店添加，最后由 Rokid AI App 同步到已连接眼镜。",
    bullets: [
      "Craft 显示“上传成功”只证明版本已经进入账号的云端工程，不代表已经提审、上架、安装或同步到眼镜。",
      "上传接口是 SSE：HTTP 200 不等于业务成功，必须看到 done 且没有 error。当前上传器会从 AIX 页面定义生成 metadata.tools，并校验 index、448×150 layout 和完整参数 schema。",
      "导入本地 .aix 后，顶部项目名通常是文件名；此时“提审”会提示“请先绑定灵珠智能体”。从项目菜单的“云端项目”选择 RabiLink 版本后才恢复绑定。",
      "云端项目的权威标志是顶部项目名为 RabiLink，提审按钮可用，提审面板显示当前绑定智能体、版本和 ID。",
      "提审是外部发布动作。提交前检查版本、权限和版本说明；审核通过前，手机商店按完整名称搜索不到属于正常状态。",
      "把 rabilink-aiui.aix 推到手机 Download 目录只用于交付和哈希核对，不能替代 Craft、提审或商店安装。",
      "手机端公开路径是“主页 > 智能体商店 > 搜索/添加 > 智能体管理”；智能体管理列表出现 RabiLink 后，才进入眼镜同步与运行验收。"
    ],
    quickStart: {
      phases: [
        {
          title: "生成并核对交付包",
          note: "始终从源码重新生成，不要手改 dist 或复用来源不明的 AIX。",
          steps: [
            {
              title: "运行本地验收",
              instruction: "在 examples/rabilink-aiui 运行 npm run check、npm run delivery:verify 和 npm run acceptance:local。",
              completeWhen: "检查、最终 AIX 比对和本地验收矩阵全部通过。",
              icon: "mdi-test-tube"
            },
            {
              title: "确认唯一 AIX",
              instruction: "使用 dist/rabilink-aiui.aix；记录大小和 SHA256。不要把开发目录、utils、node_modules 或真实 token 放进上传包。",
              completeWhen: "AIX 审计通过，包内只有运行所需页面、配置和版本文件。",
              icon: "mdi-package-variant-closed-check"
            }
          ]
        },
        {
          title: "上传并绑定云端工程",
          note: "本地工程用于导入和预览，云端工程才带有灵珠智能体绑定。",
          steps: [
            {
              title: "上传到 RabiLink",
              instruction: "在 Craft 导入 dist/rabilink-aiui.aix，打包后选择目标智能体 RabiLink，核对版本和权限再上传。只需要麦克风、语音识别和网络权限；tools 应由工程解析为 index、448×150 和完整参数 schema。",
              completeWhen: "上传 SSE 返回 done 且没有 error，账号接口和云端项目列表都出现 RabiLink 新版本。",
              icon: "mdi-cloud-upload-outline",
              action: {
                label: "打开 Craft",
                href: "https://js.rokid.com/craft?region=cn&lang=zh-CN",
                external: true
              }
            },
            {
              title: "切换到云端 RabiLink",
              instruction: "点击左上项目名，展开工程菜单；在“云端项目”选择 RabiLink 对应版本。不要停留在“本地项目 > rabilink-aiui.aix”。",
              completeWhen: "顶部项目名显示 RabiLink，并且“提审”不再显示“请先绑定灵珠智能体”。",
              icon: "mdi-cloud-check-outline"
            },
            {
              title: "核对提审目标",
              instruction: "打开提审面板，确认绑定智能体为 RabiLink、版本正确、页面说明正确。用户协议默认关闭，版本说明可选。",
              completeWhen: "提审第 1 步显示正确智能体和版本，第 2 步只等待最后的“提交提审”。",
              icon: "mdi-clipboard-check-outline"
            }
          ]
        },
        {
          title: "审核、手机添加与眼镜同步",
          note: "提交提审会把版本发送到灵珠后台；这是外部发布动作，应由账号所有者明确确认。",
          steps: [
            {
              title: "提交提审并等待审核",
              instruction: "经账号所有者确认后点击“提交提审”。等待后台状态变为审核通过；审核中或未提审时，手机商店可能完全搜不到。",
              completeWhen: "Craft 或灵珠后台显示该版本审核通过/可发布。",
              icon: "mdi-file-send-outline"
            },
            {
              title: "在手机添加智能体",
              instruction: "打开 Rokid AI App，进入“主页 > 智能体商店”，搜索 RabiLink，点击加号添加；右上角进入“智能体管理”复核。",
              completeWhen: "智能体管理列表中出现 RabiLink，不再显示“还没有添加任何智能体”。",
              icon: "mdi-cellphone-check"
            },
            {
              title: "同步并在眼镜启动",
              instruction: "保持手机与眼镜蓝牙连接，在手机端触发同步；随后从眼镜原生助手打开 RabiLink。",
              completeWhen: "眼镜显示 RabiLink 下沿 HUD，默认选中连接对话，滑动可切到配置助手。",
              icon: "mdi-glasses"
            },
            {
              title: "保存真机证据",
              instruction: "验证滑轨、语音切换、连续 ASR、配置回复、时钟、电量和充电标记；再运行 npm run runtime:proof 与 npm run goal:evidence。",
              completeWhen: "runtime-proof-status.json 标记 proved=true，goal-evidence.json 不再有缺失项。",
              icon: "mdi-shield-check-outline"
            }
          ]
        }
      ],
      voiceCommands: [
        "打开 RabiLink",
        "切到配置助手",
        "切到连接对话"
      ],
      securityNotes: [
        "提审、发布和商店添加属于外部状态变化；自动化操作前必须得到账号所有者明确授权。",
        "AIX、截图、日志和文档都不得包含完整 rabilinkToken、Craft token、Cookie 或账号私密信息。",
        "不要为了绕过审核而侧载未知 APK、调用未导出的内部 Activity，或把 .aix 当 Android APK 安装。"
      ]
    },
    diagram: {
      title: "从源码到眼镜的正式链路",
      caption: "每一阶段都有独立完成标志；前一阶段成功不能代替后一阶段。",
      lanes: [
        {
          label: "开发与云端",
          steps: [
            { title: "本地验收", detail: "check + delivery verify", icon: "mdi-test-tube", kind: "service" },
            { title: "上传 AIX", detail: "进入账号云端工程", icon: "mdi-cloud-upload-outline", kind: "service" },
            { title: "选择云端 RabiLink", detail: "恢复灵珠绑定", icon: "mdi-link-variant", kind: "decision" },
            { title: "提交提审", detail: "等待后台审核", icon: "mdi-file-send-outline", kind: "warning" }
          ]
        },
        {
          label: "手机与眼镜",
          steps: [
            { title: "商店可见", detail: "审核通过", icon: "mdi-store-check-outline", kind: "service" },
            { title: "手机添加", detail: "智能体管理出现 RabiLink", icon: "mdi-cellphone-check", kind: "input" },
            { title: "同步眼镜", detail: "手机与眼镜已连接", icon: "mdi-sync", kind: "service" },
            { title: "真机验收", detail: "HUD、ASR、Relay、电量", icon: "mdi-glasses", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-troubleshooting",
    title: "安装与运行排障",
    section: "RabiLink AIUI",
    subtitle: "先按症状判断所处阶段，再处理绑定、审核、宿主或 Relay 问题。",
    summary: "RabiLink AIUI 的常见故障大多来自把本地预览、云端上传、提审、手机安装和眼镜运行混为一谈。下面记录已经在真实 Craft、手机 Rokid AI App、ADB 与 Ink 运行时中复现过的症状和确定处理方式。",
    bullets: [
      "“请先绑定灵珠智能体”：当前打开的是本地 AIX；从工程菜单切换到“云端项目 > RabiLink <版本>”。",
      "“上传成功”但手机搜索不到：尚未提审、正在审核或未通过；上传并不会自动上架。",
      "手机 Download 里有 .aix 但点击无反应：Rokid AI App 没有公开 .aix 文件处理器，这是预期行为。",
      "ADB 启动 AgentManageActivity 报 Permission Denial：该 Activity 未导出，只能从 Rokid AI App 内部导航进入。",
      "Craft 选择文件报 Not allowed：为 ChatGPT Chrome Extension 开启文件 URL 访问，或使用内嵌 AIX 上传助手。",
      "浏览器预览不开真实麦克风：Craft ASR 是文字注入模拟器；先进入 Interactive InkView，再用调试输入框提交识别文本。",
      "顶部“运行智能体”直接验证当前 AIX；/debug 还依赖 Rokid 智能体调试上游。后者 DNS/fetch 失败时，不能把上游故障写成 AIX 初始化失败。",
      "初始化或进入沉浸界面卡死：检查是否重新引入 scroll-view、大型条件节点树、onLoad 同步网络或并发 ASR；当前共享卡片与共享 HUD 已有启动安全、resize 和像素完整度回归测试。",
      "连续 ASR 更新后出现半截 HUD：解除重绘遮罩时必须重放全部 HUD 可见字段。在线验收连续采样 3 秒，并要求 partial_frames 为 0。",
      "不要只凭 Playwright 元素截图判断 Canvas 是否残缺：Craft 持续渲染时截图可能撕裂；应从一次 getImageData 冻结缓冲同时生成像素统计和证据 PNG。",
      "电量显示 --：真实来源不可用或状态超过 3 分钟。生产 Relay 的 device-status 路由返回 404 表示服务端版本过旧；更新后未授权请求应返回 401，而不是 404。",
      "AIUI 不能像 FenneNote 那样后台常驻：SpeechRecognition 只能承诺页面前台续轮；页面隐藏、退出、锁屏或被宿主回收后会停止。"
    ],
    quickStart: {
      phases: [
        {
          title: "Craft 绑定与发布",
          note: "先看顶部项目名和提审按钮，不要只看文件树内容。",
          steps: [
            {
              title: "提审按钮灰色",
              instruction: "点击项目名，在“云端项目”选择 RabiLink 新版本。若只看到本地项目，先完成上传并刷新账号智能体列表。",
              completeWhen: "顶部显示 RabiLink，提审按钮可用。",
              icon: "mdi-link-off"
            },
            {
              title: "手机商店无结果",
              instruction: "回到云端工程查看是否已经提交提审，以及后台状态是否审核通过。不要反复把同一个 AIX 推到手机 Download。",
              completeWhen: "后台明确显示可发布，手机商店能搜索到同名智能体。",
              icon: "mdi-store-search-outline"
            }
          ]
        },
        {
          title: "手机与眼镜入口",
          note: "只走 App 内公开路径，不依赖未导出的 Activity 或文件关联。",
          steps: [
            {
              title: "进入智能体管理",
              instruction: "在 Rokid AI App 主页点击“智能体商店”，再点右上角管理图标。ADB 深链和显式 Activity 只用于确认不可用边界。",
              completeWhen: "页面标题为“智能体管理”，可看到已添加列表。",
              icon: "mdi-view-grid-plus-outline"
            },
            {
              title: "确认眼镜连接",
              instruction: "回到手机主页确认设备名、蓝牙“已连接”和真实眼镜电量。没有连接时不要把手机端操作误当成眼镜已同步。",
              completeWhen: "主页显示目标眼镜已连接，设备状态持续更新。",
              icon: "mdi-bluetooth-connect"
            }
          ]
        },
        {
          title: "运行时与电量",
          note: "区分 Craft 模拟器、真实眼镜宿主和生产 Relay 三种环境。",
          steps: [
            {
              title: "Craft 页面级调试",
              instruction: "优先用顶部“运行智能体”打开当前 AIX，进入 Interactive InkView 后触发麦克风控件，再在调试输入框注入识别文本。用冻结 ImageData 连续检查 3 秒；/debug 上游失败时单独记录服务错误。",
              completeWhen: "448×150 卡片、480×352 HUD、同页模式切换和模拟 speech.result 回写都正常，partial_frames 为 0。",
              icon: "mdi-monitor-eye"
            },
            {
              title: "页面卡死或无法进入",
              instruction: "先运行 npm run startup:safety、npm run startup:soak、npm run interactive:resize 和 npm run craft:headless；检查日志中是否出现 apply_ops 或 child_sync_parents 自旋。",
              completeWhen: "安全、浸泡、resize 和真实 Ink/Craft 运行测试全部通过。",
              icon: "mdi-progress-wrench"
            },
            {
              title: "电量或充电状态缺失",
              instruction: "确认手机 CXR 状态服务正在上报，再运行 npm run device-status:e2e。若生产 /api/rabilink/mobile/device-status 返回 404，先部署包含该路由的新 Relay。",
              completeWhen: "报告显示 0-100 电量、charging 布尔值、来源和未过期时间；HUD 同步显示百分比与充电标记。",
              icon: "mdi-battery-sync-outline"
            },
            {
              title: "最终真机证明",
              instruction: "在眼镜启动云端已审核版本并触发 Relay 行为，然后运行 npm run runtime:proof 和 npm run goal:evidence。",
              completeWhen: "真实 app 行为事件齐全，goal evidence 为 complete。",
              icon: "mdi-check-decagram-outline"
            }
          ]
        }
      ],
      voiceCommands: [],
      securityNotes: [
        "排障截图和 JSON 证据只保存状态、版本、哈希和匿名设备信息，不保存完整 token、Cookie 或聊天内容。",
        "遇到内部 Activity 未导出时不要尝试提权、修改系统包或绕过平台审核。",
        "生产 Relay 部署需要有效 SSH/平台凭据；凭据缺失时应记录为外部阻塞，不得猜测或泄露密钥。"
      ]
    },
    diagram: {
      title: "按阶段定位故障",
      caption: "先找到最后一个已完成阶段；问题通常就在它与下一个阶段之间。",
      lanes: [
        {
          label: "发布链",
          steps: [
            { title: "本地 AIX", detail: "只能预览和上传", icon: "mdi-file-code-outline", kind: "input" },
            { title: "云端工程", detail: "恢复智能体绑定", icon: "mdi-cloud-check-outline", kind: "decision" },
            { title: "审核通过", detail: "商店才可见", icon: "mdi-clipboard-check-outline", kind: "warning" },
            { title: "手机已添加", detail: "进入管理列表", icon: "mdi-cellphone-check", kind: "result" }
          ]
        },
        {
          label: "运行链",
          steps: [
            { title: "眼镜已连接", detail: "蓝牙与设备状态", icon: "mdi-bluetooth-connect", kind: "input" },
            { title: "AIUI 已启动", detail: "同页双模式 HUD", icon: "mdi-glasses", kind: "mode" },
            { title: "Relay 已连接", detail: "认证与 PC 绑定", icon: "mdi-router-network", kind: "service" },
            { title: "真机证据", detail: "runtime proof", icon: "mdi-shield-check-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-modes",
    title: "双模式总览",
    section: "RabiLink AIUI",
    subtitle: "主页就是当前运行模式，不再设置需要二次确认的模式选择页。",
    summary: "RabiLink 只有连接对话和配置助手两种产品状态。原生 Agent 调用页面工具时默认进入连接对话；触摸板前后滑动会在同一个 InkView 中直接切换模式，不退出页面、不重新进入，也不创建第二个助手。",
    bullets: [
      "两种模式属于同一个 RabiLink 智能体；rabilink-aiui.aix 只是它挂载的界面包，不是第二个智能体。",
      "连接对话是默认模式，负责页面前台 ASR 续接、断线缓存、输入事件发布、持续下行流和原生 TTS。",
      "配置助手不创建页面 ASR 或 Relay task；眼镜原生 Agent 先理解需求，再把明确 intent 交给 AIUI 配置接口。",
      "AIX 页面内没有调用原生 Agent Loop 的公开 API，因此语义理解必须由页面外的原生 Agent 发起。",
      "模式切换只改变当前页面状态：进入配置助手先停止连接 ASR，回到连接对话再恢复 ASR 与消息流。"
    ],
    diagram: {
      title: "双模式主流程",
      caption: "智能体配置与 AIX 页面属于同一个 RabiLink，但运行职责分层；两种模式共享身份和绑定，不共享麦克风会话。",
      lanes: [
        {
          label: "同一个智能体的组成",
          steps: [
            { title: "RabiLink Agent", detail: "Rokid 智能体实体", icon: "mdi-account-voice", kind: "agent" },
            { title: "智能体配置", detail: "提示词、记忆变量、UI Tool", icon: "mdi-cog-outline", kind: "service" },
            { title: "rabilink-aiui.aix", detail: "挂载的 AIUI 界面包", icon: "mdi-package-variant-closed", kind: "service" },
            { title: "RabiLink AIUI 首页", detail: "承载双模式界面", icon: "mdi-monitor-dashboard", kind: "result" }
          ]
        },
        {
          label: "默认路径",
          steps: [
            { title: "打开 RabiLink", detail: "应用启动", icon: "mdi-glasses", kind: "input" },
            { title: "连接对话", detail: "默认立即激活", icon: "mdi-microphone-outline", kind: "mode" },
            { title: "输入事件", detail: "ASR 分段与排序", icon: "mdi-text-box-outline", kind: "service" },
            { title: "持续消息流", detail: "回复与主动消息统一 TTS", icon: "mdi-router-network", kind: "result" }
          ]
        },
        {
          label: "配置路径",
          steps: [
            { title: "向后滑动", detail: "或语音切换", icon: "mdi-gesture-swipe-horizontal", kind: "input" },
            { title: "停止 ASR", detail: "页面释放麦克风", icon: "mdi-stop-circle-outline", kind: "decision" },
            { title: "原生 Agent", detail: "理解并归一化 intent", icon: "mdi-account-voice", kind: "agent" },
            { title: "配置助手", detail: "直接调用 PC 接口", icon: "mdi-check-decagram-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-mode-switch",
    title: "模式切换",
    section: "RabiLink AIUI",
    subtitle: "下滑进入配置助手；配置 UI 仍显示时，上滑立即回到连接对话。",
    summary: "主页没有选择态和二次进入按钮。Craft 将上滑、下滑分别注入 ArrowUp、ArrowDown；转向配置时，页面先停止当前连接 ASR，再在同一个 InkView 切换 HUD。返回连接对话时恢复连续 ASR 和下行消息流。",
    bullets: [
      "连接对话向后滑动，直接切到配置助手；配置助手向前滑动，直接切回连接对话。",
      "连接对话 ASR 能识别“切到配置助手”；配置页不另启 ASR，返回语义由触摸板或页面外原生 Agent 调用。",
      "Craft 当前把上滑、下滑映射为 ArrowUp、ArrowDown；页面同时兼容浏览器和 Android DPAD 数值 keyCode。",
      "识别出的模式控制语句不会进入正式转写记录，也不会作为配置需求提交。"
    ],
    diagram: {
      title: "统一切换事务",
      caption: "触控和语音只负责表达意图；资源释放、状态提交和目标模式启动由同一个控制器串行完成。",
      lanes: [
        {
          label: "输入归一化",
          steps: [
            { title: "前后滑动", detail: "触控板事件", icon: "mdi-gesture-swipe-horizontal", kind: "input" },
            { title: "语音指令", detail: "控制语句", icon: "mdi-account-voice", kind: "input" },
            { title: "模式请求", detail: "页面内去重", icon: "mdi-call-merge", kind: "decision" }
          ]
        },
        {
          label: "执行顺序",
          steps: [
            { title: "退出当前模式", detail: "停止接收新输入", icon: "mdi-exit-run", kind: "warning" },
            { title: "提交并释放", detail: "保存片段、释放麦克风", icon: "mdi-lock-open-variant-outline", kind: "service" },
            { title: "移动滑轨", detail: "同页更新模式状态", icon: "mdi-swap-horizontal", kind: "mode" },
            { title: "目标状态生效", detail: "无需额外插件", icon: "mdi-monitor-dashboard", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-compact-card",
    title: "非沉浸式入口卡",
    section: "RabiLink AIUI",
    subtitle: "聊天流中先给出可扫描的运行摘要，进入后再展开完整眼镜 HUD。",
    summary: "Craft 的非沉浸式 InkView 固定为 448×150，并在底部叠加宿主自己的初始化状态、进入按钮和尺寸信息。RabiLink 在剩余上方区域使用一张共享紧凑卡，模式切换只替换状态文字；进入交互模式后，同一页面扩展为一棵共享的 480×352 HUD 节点树。",
    bullets: [
      "连接对话状态显示 RabiLink、模式滑轨、LIVE/TTS/PAUSE、ASR 状态、持续队列状态、最新一句和时长。",
      "配置助手状态在同一张卡中显示 RabiLink、模式滑轨、助手状态、Relay 状态和最近回复，不挂载第二张卡。",
      "每次 setData 先遮罩并触发 1px 有界重排；解除遮罩时重放全部可见字段，避免 Ink 只重画最后变化的局部节点。",
      "卡片发光内容只占第 10 至 83 行，底部至少保留 50px 给 Craft 宿主栏，二者不会重叠。",
      "紧凑卡不重复绘制“进入”按钮；该命令属于 Craft 宿主，AIX 只呈现应用状态。",
      "真实 Ink 烟测同时渲染 448×150 与 480×352，避免修复入口卡时破坏眼镜 HUD。"
    ],
    diagram: {
      title: "同页双尺寸渲染",
      caption: "业务状态只有一份，承载布局按宿主高度自动切换；紧凑卡负责预览，完整 HUD 负责持续交互。",
      lanes: [
        {
          label: "非沉浸式 448×150",
          steps: [
            { title: "模式摘要", detail: "转写或配置", icon: "mdi-card-text-outline", kind: "mode" },
            { title: "运行状态", detail: "ASR、Relay、队列", icon: "mdi-list-status", kind: "service" },
            { title: "宿主进入栏", detail: "Craft 固定绘制", icon: "mdi-login-variant", kind: "input" }
          ]
        },
        {
          label: "沉浸式 480×352",
          steps: [
            { title: "进入交互", detail: "InkView 扩展", icon: "mdi-arrow-expand", kind: "input" },
            { title: "下沿 HUD", detail: "中央视野留空", icon: "mdi-glasses", kind: "mode" },
            { title: "完整操作", detail: "转写或配置", icon: "mdi-monitor-dashboard", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-config-assistant",
    title: "配置助手",
    section: "RabiLink AIUI",
    subtitle: "眼镜原生 Agent 负责理解，AIUI 负责执行明确配置指令，PC Rabi 保留真源和安全门。",
    summary: "用户不需要在眼镜里寻找配置页面或记忆字段名。眼镜原生 Agent 先把需求归一化为明确 intent，再以 mode=configuration 调用同一个 AIUI 页面。配置助手严格匹配命令并直接调用已有 mobile/WebGUI 接口；它不自行录音、不创建 Relay task，也不轮询 Agent 回复。",
    bullets: [
      "原生 Agent 从页面外以 mode=configuration 和明确 intent 调起配置助手；AIX 页面没有递归调用原生 Agent Loop 的公开 API。",
      "配置助手不导入 RabiLinkMessage MCP；AIUI 页面只调用既有 Relay mobile/WebGUI HTTP 接口。",
      "模糊自然语言不会做子串猜测，也不会回退到任务接口；原生 Agent 必须先明确要读取或修改的项目。",
      "只读查询可以直接返回；配置修改和高风险控制仍必须经过 PC RabiRoute 的草稿、确认、Action Gate 和审计。"
    ],
    diagram: {
      title: "自然语言配置流程",
      caption: "理解与执行分离：原生 Agent 选择 UI，AIX 页面调用已有接口，PC RabiRoute 保有配置字段和安全边界的最终解释权。",
      lanes: [
        {
          label: "理解",
          steps: [
            { title: "用户需求", detail: "自然语言描述", icon: "mdi-message-text-outline", kind: "input" },
            { title: "原生 Agent", detail: "归一化明确 intent", icon: "mdi-account-voice", kind: "agent" },
            { title: "AIUI 配置助手", detail: "严格命令分发", icon: "mdi-monitor-dashboard", kind: "service" },
            { title: "PC Rabi", detail: "接口执行与校验", icon: "mdi-cloud-sync-outline", kind: "result" }
          ]
        },
        {
          label: "提交",
          steps: [
            { title: "变更草稿", detail: "修改前后 Diff", icon: "mdi-file-compare", kind: "decision" },
            { title: "用户确认", detail: "确认 draftId", icon: "mdi-account-check-outline", kind: "input" },
            { title: "Action Gate", detail: "风险与权限检查", icon: "mdi-shield-check-outline", kind: "warning" },
            { title: "写回并反馈", detail: "PC 真源生效", icon: "mdi-check-circle-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-asr-runtime",
    title: "连接对话",
    section: "RabiLink AIUI",
    subtitle: "默认模式专注页面前台录音与 ASR，不把普通谈话误当成配置命令。",
    summary: "进入连接对话后，页面使用 AIUI 原生 SpeechRecognition 获取输入，并持续消费应用级下行消息流。每轮结果附带会话、顺序号和时间戳后进入本地队列，再由 AIX 发布到 Relay 输入事件端点；普通 Agent 回复与主动消息都进入同一原生 TTS 队列。",
    bullets: [
      "官方语义是 start() 开始一轮识别；本项目在 onend 后自动创建下一轮，不依赖未公开承诺的永久 continuous 会话。",
      "当前实现只使用每轮最终文本，不把 interimResults 当成宿主必定支持的能力。",
      "Craft 浏览器不读取电脑麦克风：无设备序列号时，切换模式不会自动 start；进入 Interactive InkView、触发麦克风控件并提交文字后，宿主才注入 speech.result。",
      "HUD 从下沿向上生长；真实 Ink 像素测试要求首个发光像素位于第 120 行以后，避免遮挡中央视野。",
      "断网时最终文本最多保留最近 100 段，恢复连接后按顺序补传。",
      "下行流不依赖 taskId 或完成态；即使没有刚刚提交的语音，也能收到 proactive=true 的主动消息。",
      "每次 TTS 前先释放 ASR，播报结束后再恢复下一轮，避免声音回流。"
    ],
    diagram: {
      title: "录音到文本同步",
      caption: "界面即时反馈与可靠上传使用两条路径，避免网络波动阻塞麦克风和 ASR。",
      lanes: [
        {
          label: "即时显示",
          steps: [
            { title: "麦克风", detail: "当前模式独占", icon: "mdi-microphone-outline", kind: "input" },
            { title: "SpeechRecognition", detail: "单轮识别", icon: "mdi-waveform", kind: "service" },
            { title: "onend 续轮", detail: "仅页面前台", icon: "mdi-message-processing-outline", kind: "service" },
            { title: "单页 HUD", detail: "显示最新一句", icon: "mdi-glasses", kind: "result" }
          ]
        },
        {
          label: "可靠同步",
          steps: [
            { title: "最终文本段", detail: "final result", icon: "mdi-text-box-check-outline", kind: "service" },
            { title: "会话封装", detail: "序号与时间戳", icon: "mdi-timeline-clock-outline", kind: "service" },
            { title: "待同步队列", detail: "断网可恢复", icon: "mdi-tray-full", kind: "warning" },
            { title: "Relay 输入事件", detail: "PC Agent 接收处理", icon: "mdi-router-network", kind: "result" }
          ]
        },
        {
          label: "持续下行",
          steps: [
            { title: "应用级 cursor", detail: "空闲时仍长轮询", icon: "mdi-timeline-clock-outline", kind: "service" },
            { title: "普通回复", detail: "Codex / 其他 Agent", icon: "mdi-message-reply-text-outline", kind: "agent" },
            { title: "主动消息", detail: "无需前置任务", icon: "mdi-bell-outline", kind: "service" },
            { title: "原生 TTS", detail: "按序播报后恢复 ASR", icon: "mdi-volume-high", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-active-stream",
    title: "队列流与主动投递",
    section: "RabiLink AIUI",
    subtitle: "眼镜常驻消费应用级消息队列，主动智能不需要先伪造一轮用户任务。",
    summary: "连接对话把上行和下行拆成两个稳定契约：ASR 只向 /rokid/rabilink/input 发布输入事件；眼镜始终按 cursor 消费 /rokid/rabilink/messages?stream=1。普通 Agent 回复和 proactive=true 主动消息共享顺序、显示和原生 TTS 队列，任何一条内部 worker task 的完成都不会关闭眼镜消息流。",
    bullets: [
      "首次连接先用 tail=1 获取当前队尾，之后保存每批 nextCursor；重连从保存位置继续，避免重播旧历史。",
      "stream=1 空闲超时返回 idle 与 shouldContinue=true，它表示当前没有新消息，不是任务失败。",
      "PC Agent、定时器或规划器通过 /api/agent/replies 指定 routeProfileId、targetType=rabilink 和 proactive=true，继续经过现有输出策略与审计门。",
      "Relay 的 /worker/messages 是队列追加原语；主动消息没有 taskId，但仍携带全局 seq、message id、source 和 proactive 标记。",
      "页面按 seq 到达顺序显示和播报。TTS 前释放 ASR，播报结束后再恢复，防止眼镜听见自己的声音。"
    ],
    diagram: {
      title: "普通回复与主动消息汇流",
      caption: "上行事件只触发 Agent 工作；下行队列独立常驻，因此主动智能可以在用户沉默时到达眼镜。",
      lanes: [
        {
          label: "用户对话",
          steps: [
            { title: "眼镜原生 ASR", detail: "最终文本片段", icon: "mdi-microphone-outline", kind: "input" },
            { title: "输入事件", detail: "202 accepted，无 taskId", icon: "mdi-arrow-up-circle-outline", kind: "service" },
            { title: "当前 Agent", detail: "Codex 或其他 Agent", icon: "mdi-account-voice", kind: "agent" },
            { title: "普通回复", detail: "写入应用下行队列", icon: "mdi-message-reply-text-outline", kind: "result" }
          ]
        },
        {
          label: "主动智能",
          steps: [
            { title: "定时器 / 规划器", detail: "没有前置语音", icon: "mdi-clock-outline", kind: "input" },
            { title: "RabiRoute 输出门", detail: "策略、风险与审计", icon: "mdi-shield-check-outline", kind: "decision" },
            { title: "持续消息流", detail: "普通与主动统一排序", icon: "mdi-format-list-numbered", kind: "service" },
            { title: "眼镜原生 TTS", detail: "播报后恢复 ASR", icon: "mdi-volume-high", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-audio-lifecycle",
    title: "麦克风交接",
    section: "RabiLink AIUI",
    subtitle: "连接 ASR、原生 TTS 与页面外的原生 Agent 必须明确交接麦克风。",
    summary: "页面只保留一个连接对话 recognition 引用。转向配置时立即停止 ASR；收到下行消息时，TTS 先释放 recognition，播报结束后再恢复。配置助手不创建自己的 SpeechRecognition，因此不会和原生 Agent 抢占麦克风。",
    bullets: [
      "连接对话退出时，先停止识别并结算已有 final 结果。",
      "配置助手进入前必须确认连接 ASR 已释放麦克风。",
      "配置助手不创建页面 ASR；自然语言由 Rokid 原生 Agent 在页面外理解。",
      "下行 TTS 播报完成后，只有页面仍在连接对话、前台且未暂停时才恢复 ASR。",
      "重复滑动、键盘和语音事件按当前 mode 幂等处理；模式提交使用 generation 令牌，过期回调不会启动错误模式。"
    ],
    diagram: {
      title: "双向音频所有权交接",
      caption: "页面 recognition 引用是 AIUI 内的麦克风所有权记录；原生 Agent 的麦克风由 Rokid 宿主接管。",
      lanes: [
        {
          label: "转向配置",
          steps: [
            { title: "ASR 持有麦克风", detail: "正在转写", icon: "mdi-microphone", kind: "mode" },
            { title: "停止并结算", detail: "等待 final 片段", icon: "mdi-stop-circle-outline", kind: "warning" },
            { title: "recognition 清空", detail: "页面不再持有", icon: "mdi-lock-open-variant-outline", kind: "service" },
            { title: "配置助手", detail: "等待原生 Agent intent", icon: "mdi-account-voice", kind: "agent" }
          ]
        },
        {
          label: "转向连接对话",
          steps: [
            { title: "原生 Agent 完成", detail: "页面没有助手 ASR", icon: "mdi-account-off-outline", kind: "warning" },
            { title: "同页切换", detail: "mode=transcription", icon: "mdi-lock-open-variant-outline", kind: "service" },
            { title: "创建 ASR session", detail: "取得唯一所有权", icon: "mdi-play-circle-outline", kind: "service" },
            { title: "恢复连接对话", detail: "新片段继续排序", icon: "mdi-microphone-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-data-safety",
    title: "数据与安全边界",
    section: "RabiLink AIUI",
    subtitle: "眼镜保存最小运行状态，PC 始终拥有配置和完整转写数据。",
    summary: "两种模式共享同一个 RabiLink 智能体身份、PC 绑定、Relay 连接和重试能力，但业务数据保持分离。完整 token 由智能体平台保存在记忆变量 rabilinkToken 中，并在调起时临时注入 AIUI 页面工具；AIX 包、模型对话和眼镜界面都不展示它。所有配置写入仍由 PC RabiRoute 校验和审计。",
    bullets: [
      "眼镜设备只保存绑定状态、当前模式和未同步文本段，不要求用户在设备上保存完整应用 token。",
      "rabilinkToken 属于智能体私有变量；AIUI 页面参数引用它，但模型不能读取、复述或向用户索取它。",
      "Route、Agent、Persona、Pipeline 等配置以 PC Manager/WebGUI 配置为唯一真源。",
      "配置修改必须经过 draft、确认、Action Gate 和审计记录。",
      "默认只保存最终转写文本与时间戳，不在 AIUI 包或仓库中保存真实录音、token 和私有配置。"
    ],
    diagram: {
      title: "数据所有权与写入边界",
      caption: "Relay 只做认证和中转；它不成为第二份配置事实源，也不替代 PC 上的 Action Gate。",
      lanes: [
        {
          label: "共享连接",
          steps: [
            { title: "智能体私有变量", detail: "rabilinkToken", icon: "mdi-variable", kind: "agent" },
            { title: "页面参数注入", detail: "仅运行期、模型不可见", icon: "mdi-shield-key-outline", kind: "warning" },
            { title: "RabiLink Relay", detail: "认证与目标中转", icon: "mdi-cloud-sync-outline", kind: "service" },
            { title: "PC Worker", detail: "已绑定设备在线", icon: "mdi-desktop-tower-monitor", kind: "service" },
            { title: "RabiRoute", detail: "领域事实归口", icon: "mdi-router-network", kind: "result" }
          ]
        },
        {
          label: "受控写入",
          steps: [
            { title: "配置意图", detail: "不携带文件路径", icon: "mdi-message-cog-outline", kind: "agent" },
            { title: "草稿与确认", detail: "展示实际 Diff", icon: "mdi-file-compare", kind: "decision" },
            { title: "Action Gate", detail: "校验、审批、审计", icon: "mdi-shield-check-outline", kind: "warning" },
            { title: "PC 配置真源", detail: "唯一写入位置", icon: "mdi-database-check-outline", kind: "result" }
          ]
        }
      ]
    }
  },
  {
    id: "rabilink-acceptance-status",
    title: "验收状态",
    section: "RabiLink AIUI",
    subtitle: "本地与 Craft 验收已经通过；提审、手机添加和最终眼镜运行仍按真实外部状态单独验收。",
    summary: "当前源码已完成连接对话、持续消息流、主动投递、原生 TTS/ASR 交接、原生 Agent 配置助手、双模式滑轨、时钟、电量/充电、非沉浸式卡片和卡死回归。新 AIX 仍需重新生成并在设备回来后完成真机验收；此前云端 1.0.4 证据不能代替本次队列流版本。",
    bullets: [
      "界面验收：左侧连接对话、右侧配置助手；选中框沿双段滑轨移动，触摸板在同一 InkView 切换。",
      "层级验收：暂停、继续和重试位于滑轨下方，无按钮边框或填充；配置助手没有伪说话按钮。",
      "状态验收：左下时钟图标与 HH:mm；右下电池图标、百分比和充电标记；过期或不可用时诚实显示 --。",
      "运行验收：85 条明确命令、283 种说法、严格 Agent intent、普通/主动消息同流、TTS/ASR 交接、20 次模式往返和 Relay/WebGUI 集成均通过。",
      "发布验收：本地待发布版本是 1.0.5；云端 1.0.4 只保留为历史链路证据，上传和提审必须等待账号所有者明确授权。",
      "真机缺口：1.0.5 上传/审核、手机更新、眼镜触摸板、真实麦克风、主动播报和 runtime proof 尚未完成。"
    ],
    diagram: {
      title: "分层验收状态",
      caption: "模拟、Craft 和真机证据分别记录；任何一层通过都不能替代下一层。",
      lanes: [
        {
          label: "已通过",
          steps: [
            { title: "源码审计", detail: "滑轨、层级、状态角标", icon: "mdi-code-braces-check", kind: "service" },
            { title: "Ink 验收", detail: "18/18 + resize", icon: "mdi-test-tube", kind: "service" },
            { title: "Craft 验收", detail: "partial frames = 0", icon: "mdi-monitor-eye", kind: "result" }
          ]
        },
        {
          label: "等待外部状态",
          steps: [
            { title: "提交提审", detail: "需要明确授权", icon: "mdi-file-send-outline", kind: "warning" },
            { title: "手机添加", detail: "等待审核通过", icon: "mdi-cellphone-check", kind: "input" },
            { title: "眼镜运行", detail: "ASR、触摸板、电量", icon: "mdi-glasses", kind: "mode" },
            { title: "最终证明", detail: "runtime proof", icon: "mdi-shield-check-outline", kind: "result" }
          ]
        }
      ]
    }
  }
];
