<script setup lang="ts">
import { computed, ref } from "vue";

type DocFeature = {
  name: string;
  status: string;
  owner: string;
  truth: string;
  consumes: string;
  effect: string;
  sideEffects: string;
  entry: string;
  code: string[];
  docs: string[];
  keywords: string;
};

type DocTableRow = {
  name: string;
  path: string;
  writer: string;
  usage: string;
};

type DocPage = {
  id: string;
  title: string;
  section: string;
  subtitle: string;
  summary: string;
  bullets: string[];
  featureNames?: string[];
  table?: "boundaries" | "runtimeData" | "editEntrypoints";
};

const query = ref("");
const activePageId = ref("overview");

const boundaryRules = [
  "没有智能命中人格。route 通过 agentRoleId 固定绑定人格；createRouteDecision 只在当前 route profile 的 notificationRules 内匹配规则。",
  "真实投递会遍历 gateway 子进程里的 active routeProfiles；单 route 预览只能称为单 route profile 试算。",
  "消息端和 Agent 端配置归 route，真源是 data/route/<configName>/adapterConfig.json。",
  "人格正文、模板规则、计划、记忆和技能归 role，真源是 data/roles/<RoleId>/。",
  "WebGUI 不是配置事实源；配置不变量应落在 shared model 或 manager 后端。",
  "预览能力是拟新增设计，应走后端 dry-run，不能调用 forwardMessageAndWait。",
  "真实外发必须经过 Outbox / Action Gate。",
  "运行期 data、日志、token、真实账号、真实 QQ 群号和 Cookie 不进仓库。"
];

const features: DocFeature[] = [
  {
    name: "route 配置",
    status: "已有",
    owner: "配置",
    truth: "data/route/<configName>/adapterConfig.json",
    consumes: "manager 启动 gateway、config.ts 环境变量",
    effect: "保存配置并重启 / 同步 runtime 后",
    sideEffects: "写配置文件，可能启停子进程",
    entry: "WebGUI 路由页、POST /gateways",
    code: ["src/manager/configRepository.ts", "src/shared/gatewayConfigModel.ts"],
    docs: ["docs/routing-configuration.md", "docs/configuration.md"],
    keywords: "gateway route adapterConfig messageAdapters agentAdapters pipeline"
  },
  {
    name: "配置归一化",
    status: "已有",
    owner: "配置",
    truth: "GatewayDefinition、RouteProfileDefinition、NotificationRuleDefinition",
    consumes: "manager 读写配置、WebGUI 保存、gateway 子进程环境变量",
    effect: "读写配置时",
    sideEffects: "可能自动补默认值、分配端口、清理旧兼容字段",
    entry: "manager API、WebGUI store",
    code: ["src/shared/gatewayConfigModel.ts", "src/manager/configRepository.ts"],
    docs: ["docs/code-architecture.md"],
    keywords: "normalizeGatewayDefinition validateGatewayPortConflicts routeProfiles"
  },
  {
    name: "Pipeline presets",
    status: "已有",
    owner: "配置",
    truth: "route pipelinePreset / pipeline",
    consumes: "AgentPacket、Outbox / Reply",
    effect: "route 配置生效后",
    sideEffects: "影响输出模式、自动回复策略和回传行为",
    entry: "WebGUI 路由页",
    code: ["src/pipelines.ts"],
    docs: ["docs/pipeline-presets.md"],
    keywords: "pipeline preset output auto reply draft approval"
  },
  {
    name: "人格绑定",
    status: "已有，route 固定绑定",
    owner: "配置",
    truth: "adapterConfig.json.agentRoleId、agentRoleFile",
    consumes: "rolePathsForRoute(route)、AgentPacket",
    effect: "下一次 gateway 配置生效后",
    sideEffects: "影响 AgentPacket 的人格路径和角色数据目录",
    entry: "WebGUI 人格页 / 路由页",
    code: ["src/config.ts", "src/shared/routePaths.ts"],
    docs: ["docs/routing-and-personas.md"],
    keywords: "persona role agentRoleId persona.md 锁死 不智能命中"
  },
  {
    name: "消息模板规则",
    status: "已有",
    owner: "配置",
    truth: "data/roles/<RoleId>/personaConfig.json.notificationRules",
    consumes: "createRouteDecision、heartbeat schedules、AgentPacket template",
    effect: "下一次消息 / heartbeat / manual trigger",
    sideEffects: "可能导致投递 Agent",
    entry: "WebGUI 人格页",
    code: ["src/manager/configRepository.ts", "src/routing/routeDecision.ts"],
    docs: ["docs/persona-route-workbench-plan.md"],
    keywords: "notificationRules routeKinds regex targetGroupId allowedSpeakerNames"
  },
  {
    name: "QQ / NapCat 消息端",
    status: "已有",
    owner: "消息端",
    truth: "NapCat WS / HTTP、route config、group/private JSONL",
    consumes: "forwarding、Outbox QQ 发送",
    effect: "收到 QQ 事件时",
    sideEffects: "写消息日志，可能投递 Agent；/ping 可能直接回复",
    entry: "route 消息端、NapCat 管理 API",
    code: ["src/adapters/napcatAdapter.ts", "src/napcat.ts", "src/messageEndpoints/napcatManager.ts"],
    docs: ["docs/napcat-unattended.md", "docs/troubleshooting.md"],
    keywords: "QQ OneBot direct_at direct_reply indirect_reply private group_message"
  },
  {
    name: "RabiLink / Relay",
    status: "已有",
    owner: "消息端",
    truth: "HTTP payload、relay tasks、rabilink-replies.jsonl",
    consumes: "forwarding、RabiLink 下行回复、WebGUI 远程代理",
    effect: "RabiLink 请求到达、relay 轮询或拉取回复时",
    sideEffects: "写消息 / 回复日志，可能投递 Agent；relay worker 会轮询云端",
    entry: "/rabilink、/rabilink/replies、relay scripts",
    code: ["src/adapters/rabilinkAdapter.ts", "src/adapters/rabilinkRelayWorker.ts", "src/adapters/rabilinkReplies.ts"],
    docs: ["docs/rabilink-relay-server.md", "docs/rabilink-relay-cloudflare-worker.md", "docs/mobile-app-webhook-integration.md"],
    keywords: "RabiLink Rokid relay replies worker webgui"
  },
  {
    name: "Webhook / FenneNote / XiaoAi",
    status: "已有",
    owner: "消息端",
    truth: "HTTP payload、voice-transcripts.jsonl",
    consumes: "forwarding、语音工作站",
    effect: "HTTP callback 到达时",
    sideEffects: "写转写日志，可能投递 Agent",
    entry: "webhook 端口 / 路径",
    code: ["src/adapters/webhookAdapter.ts", "src/messageEndpoints/webhookLikeScans.ts"],
    docs: ["docs/voice-interaction-workstation.md"],
    keywords: "webhook voice_transcript fennenote xiaoai"
  },
  {
    name: "企业微信消息端",
    status: "已有",
    owner: "消息端",
    truth: "WeCom SDK frame、route config、wecom-messages.jsonl",
    consumes: "forwarding、Outbox WeCom 回复",
    effect: "WebSocket 收到消息时",
    sideEffects: "写消息日志，可能投递 Agent",
    entry: "route 消息端",
    code: ["src/adapters/wecomAdapter.ts", "src/wecom.ts", "src/messageEndpoints/wecomManager.ts"],
    docs: ["docs/wecom-integration.md"],
    keywords: "WeCom 企业微信 wecom_message"
  },
  {
    name: "Heartbeat / Manual / Role Panel",
    status: "已有，真实投递",
    owner: "消息端",
    truth: "notificationRules[].schedules、manual-trigger-events.jsonl、role-panel/messages.jsonl",
    consumes: "forwarding、AgentPacket",
    effect: "定时器、用户手动触发或角色面板发送时",
    sideEffects: "写事件日志、router 日志、replay ledger，可能投递 Agent",
    entry: "POST /gateways/:id/manual-trigger、POST /api/role-panel/messages",
    code: ["src/adapters/heartbeatAdapter.ts", "src/manualTrigger.ts", "src/rolePanelTimeline.ts"],
    docs: ["docs/routing-and-personas.md", "docs/rabi-agent-interfaces.md"],
    keywords: "heartbeat manual_trigger role_panel_message schedules"
  },
  {
    name: "RouteDecision",
    status: "已有",
    owner: "路由",
    truth: "route profile、event record、extra values",
    consumes: "forwarding、未来 preview",
    effect: "每次投递时",
    sideEffects: "本身无写入；调用方可能写日志",
    entry: "代码内部",
    code: ["src/routing/routeDecision.ts"],
    docs: ["docs/persona-route-workbench-plan.md"],
    keywords: "createRouteDecision matchedRules regex routeKinds"
  },
  {
    name: "Forwarding",
    status: "已有",
    owner: "路由",
    truth: "active routeProfiles、record、extra values",
    consumes: "Agent adapter、history、delivery replay",
    effect: "每次真实消息进入时",
    sideEffects: "写 router log、role record、codex notification、replay ledger，可能投递 Agent",
    entry: "forwardMessage / forwardMessageAndWait",
    code: ["src/forwarding.ts"],
    docs: ["docs/code-architecture.md"],
    keywords: "forwardMessageAndWait activeRouteProfiles delivery"
  },
  {
    name: "AgentPacket",
    status: "已有",
    owner: "路由",
    truth: "RouteDecision、role paths、logs、role knowledge",
    consumes: "Agent adapter",
    effect: "命中规则后",
    sideEffects: "会触发 roleKnowledgeSnapshot，可能刷新记忆 viewedAt 或创建待整理记忆",
    entry: "代码内部；拟新增 preview",
    code: ["src/routing/agentPacket.ts", "src/roleKnowledge.ts"],
    docs: ["docs/agent-context-injection.md"],
    keywords: "AgentPacket replyContext viewedAt requiredReadItems"
  },
  {
    name: "Agent adapter",
    status: "已有",
    owner: "处理端",
    truth: "route agent config、handler state",
    consumes: "Codex / Copilot / AstrBot / Marvis",
    effect: "AgentPacket 投递时",
    sideEffects: "向处理端发送消息",
    entry: "route Agent 端",
    code: ["src/agentAdapters/agentAdapter.ts", "src/codexDesktopIpc.ts", "src/copilotCli.ts", "src/marvis.ts", "src/agentAdapters/astrbotAdapter.ts"],
    docs: ["docs/code-architecture.md"],
    keywords: "codex copilot astrbot marvis"
  },
  {
    name: "Outbox / Reply",
    status: "已有",
    owner: "回传",
    truth: "Agent reply request、replyContext、pipeline",
    consumes: "QQ / WeCom / RabiLink / role panel 等回传",
    effect: "Agent 调用 /api/agent/replies 时",
    sideEffects: "可能写 draft、阻止、外发、写回复日志",
    entry: "POST /api/agent/replies",
    code: ["src/outbox.ts", "src/pipelines.ts"],
    docs: ["docs/rabi-agent-interfaces.md", "docs/pipeline-presets.md"],
    keywords: "reply draft approval send outbox pipeline"
  },
  {
    name: "计划 / 记忆 / 技能",
    status: "已有",
    owner: "角色上下文",
    truth: "data/roles/<RoleId>/plans、memory、skills",
    consumes: "roleKnowledgeSnapshot、Agent 接口",
    effect: "AgentPacket 构造或 API 调用时",
    sideEffects: "命中记忆可能刷新 viewedAt；整理会创建 consolidation run",
    entry: "/api/roles/:roleId/...",
    code: ["src/roleKnowledge.ts", "src/manager/roleKnowledgeRoutes.ts"],
    docs: ["docs/plan-and-memory-model.md"],
    keywords: "plans memory skills viewedAt consolidation"
  },
  {
    name: "运行日志 / Delivery replay",
    status: "已有",
    owner: "运行维护",
    truth: "adapter logs、runtime logs、delivery-replay-ledger.jsonl",
    consumes: "日志页、replay API / manager child process",
    effect: "运行时持续产生；用户触发 replay 时重放",
    sideEffects: "replay 会再次进入真实投递链路",
    entry: "日志诊断页、/gateways/:id/delivery-replay",
    code: ["src/history.ts", "src/deliveryReplay.ts", "src/deliveryReplayLedger.ts"],
    docs: ["docs/troubleshooting.md"],
    keywords: "logs replay ledger delivery runtime"
  },
  {
    name: "Remote Agent / 多实例 / 托盘",
    status: "已有",
    owner: "运行维护",
    truth: "remote-agent devices / tasks、manager identity、manager HTTP API",
    consumes: "远端设备、多实例控制面、Windows 桌面入口",
    effect: "设备连接、任务创建、API 调用或托盘启动时",
    sideEffects: "创建任务、代理请求、启动 / 退出 manager",
    entry: "/api/remote-agent/*、/api/rabi/*、Start-RabiRoute-Tray.bat",
    code: ["src/messageEndpoints/remoteAgentManager.ts", "src/manager/rabiApi.ts", "desktop/tray-task-window/"],
    docs: ["docs/rabi-agent-interfaces.md", "docs/windows-launcher-and-packaging.md"],
    keywords: "remote agent rabi instances tray windows"
  },
  {
    name: "人格路由工作台预览",
    status: "拟新增",
    owner: "拟新增",
    truth: "route profile + simulated record",
    consumes: "dry-run RouteDecision / AgentPacket / roleKnowledge",
    effect: "用户点击生成预览时",
    sideEffects: "必须无副作用：不投递 Agent、不写日志、不刷新 viewedAt",
    entry: "未来人格页",
    code: ["docs/persona-route-workbench-plan.md"],
    docs: ["docs/persona-route-workbench-plan.md"],
    keywords: "preview dry-run 生成预览 试算消息"
  }
];

const runtimeData: DocTableRow[] = [
  { name: "route 配置", path: "data/route/<configName>/adapterConfig.json", writer: "manager 配置保存", usage: "Gateway 启动和运行配置" },
  { name: "人格配置", path: "data/roles/<RoleId>/personaConfig.json", writer: "manager / WebGUI", usage: "notification rules、recent message limit" },
  { name: "群消息 / 私聊", path: "group-messages.jsonl、private-messages.jsonl", writer: "NapCat adapter、forwarding role dir copy", usage: "最近消息、审计、AgentPacket" },
  { name: "RabiLink 回复", path: "rabilink-replies.jsonl", writer: "Outbox / RabiLink reply path", usage: "RabiLink 下行查询和 relay worker" },
  { name: "投递通知", path: "codex-notifications.jsonl", writer: "forwarding", usage: "AgentPacket 投递审计" },
  { name: "replay ledger", path: "delivery-replay-ledger.jsonl", writer: "forwarding", usage: "失败回放、投递复盘" },
  { name: "role panel timeline", path: "data/roles/<RoleId>/role-panel/messages.jsonl", writer: "role panel API / outbox", usage: "WebGUI 角色面板会话" }
];

const editEntrypoints = [
  { need: "新增消息入口", files: "src/adapters/<name>Adapter.ts、src/index.ts、src/shared/gatewayConfigModel.ts", note: "不要塞进 NapCat adapter；route kind 和配置 normalize 要补齐" },
  { need: "新增处理端", files: "src/agentAdapters/types.ts、src/agentAdapters/agentAdapter.ts、src/agentAdapters/managerApi.ts", note: "Agent adapter 只投递 AgentPacket，不定义路由语义" },
  { need: "改规则匹配", files: "src/routing/routeDecision.ts、src/shared/gatewayConfigModel.ts", note: "不要在 adapter 或前端复制匹配逻辑" },
  { need: "改 Agent 收到的消息", files: "src/routing/agentPacket.ts、docs/agent-context-injection.md", note: "不要在消息端拼 prompt" },
  { need: "改人格规则 GUI", files: "ribiwebgui/src/pages/PersonaTemplatePage.vue、src/manager/configRepository.ts", note: "人格规则写回 personaConfig.json，route 字段仍归 adapterConfig.json" },
  { need: "改 Outbox / 回传", files: "src/outbox.ts、src/pipelines.ts", note: "外部写入必须保留 action gate" },
  { need: "改计划 / 记忆 / 技能", files: "src/roleKnowledge.ts、src/manager/roleKnowledgeRoutes.ts", note: "注意 viewedAt / consolidation run 的副作用" }
];

const docPages: DocPage[] = [
  {
    id: "overview",
    title: "项目总览",
    section: "开始",
    subtitle: "RabiRoute 是消息网关、消息分诊台和策略调度层。",
    summary: "这页用于建立项目全局地图：消息进入后先记录事件，再做 route decision，随后生成 AgentPacket，最后交给处理端或 Outbox。",
    bullets: [
      "RabiRoute 负责消息进入、事件记录、路由判断、上下文包装、处理端投递、回传审批和状态观测。",
      "处理端负责真正回答、执行、调用工具和维护自己的会话。",
      "WebGUI 是配置和观测界面，不是配置事实源。"
    ],
    featureNames: ["route 配置", "Forwarding", "AgentPacket", "Outbox / Reply"]
  },
  {
    id: "boundaries",
    title: "边界规则",
    section: "开始",
    subtitle: "设计 UI 或新增字段前先看这一页。",
    summary: "这里记录项目级红线，避免把 route、人格式、运行状态、处理端能力混成一团。",
    bullets: [],
    table: "boundaries"
  },
  {
    id: "route-config",
    title: "Route 配置",
    section: "配置",
    subtitle: "消息端、Agent 端、pipeline、端口和绑定人格都归 route。",
    summary: "route 配置的唯一真源是 adapterConfig.json。manager 读写配置时会通过 shared model 做 normalize、端口校验和默认值处理。",
    bullets: [
      "消息端和 Agent 端字段不要写入人格配置。",
      "route 通过 agentRoleId 固定绑定人格，不存在消息智能选择人格。",
      "保存配置后需要让 manager 同步 runtime，gateway 子进程才会按新配置运行。"
    ],
    featureNames: ["route 配置", "配置归一化", "Pipeline presets"]
  },
  {
    id: "persona-config",
    title: "人格与规则",
    section: "配置",
    subtitle: "人格正文、消息模板规则、计划、记忆和技能归 role。",
    summary: "人格页应围绕 role 数据解释和调试 route 绑定后的规则，不应复制路由配置页。",
    bullets: [
      "persona.md 是人格正文；personaConfig.json 放 notificationRules 和 recentMessageLimit。",
      "notificationRules 被 merge 到 route profile 后，由 createRouteDecision 在单 route profile 内判断。",
      "计划、记忆和技能属于 Agent 上下文，不参与 route 是否命中。"
    ],
    featureNames: ["人格绑定", "消息模板规则", "计划 / 记忆 / 技能", "人格路由工作台预览"]
  },
  {
    id: "message-adapters",
    title: "消息端",
    section: "入口",
    subtitle: "QQ、Webhook、RabiLink、WeCom、Heartbeat、Role Panel 都只是入口适配。",
    summary: "消息端负责协议翻译和轻量入口判断，应该把事件转成内部 record 后交给 forwarding。",
    bullets: [
      "不要在消息端拼 Agent prompt。",
      "QQ route kind 由 NapCat adapter 根据 @、回复链和私聊判断。",
      "RabiLink Relay worker 随 gateway 启动后轮询云端任务，并可代理远程 WebGUI 请求。"
    ],
    featureNames: ["QQ / NapCat 消息端", "RabiLink / Relay", "Webhook / FenneNote / XiaoAi", "企业微信消息端", "Heartbeat / Manual / Role Panel"]
  },
  {
    id: "routing",
    title: "路由与投递",
    section: "主链路",
    subtitle: "RouteDecision 只判断规则，Forwarding 编排真实投递。",
    summary: "生产链路会遍历 gateway 子进程里的 active routeProfiles。单 route 预览不能宣称等同于真实投递。",
    bullets: [
      "createRouteDecision 的输入是单个 route profile、route kind、record 和 extra values。",
      "forwardMessageAndWait 会写 router log、role record、codex notification 和 replay ledger。",
      "预览功能必须是 dry-run，不能直接调用 forwardMessageAndWait。"
    ],
    featureNames: ["RouteDecision", "Forwarding", "AgentPacket", "人格路由工作台预览"]
  },
  {
    id: "agent-adapters",
    title: "处理端",
    section: "主链路",
    subtitle: "Agent adapter 只接收 AgentPacket，不反向定义路由语义。",
    summary: "Codex、Copilot、AstrBot 和 Marvis 都是处理端适配器。它们负责把 packet 送到对应处理端。",
    bullets: [
      "新增处理端优先改 src/agentAdapters/types.ts、agentAdapter.ts 和 managerApi.ts。",
      "处理端失败应通过 delivery result 和日志暴露，不应修改 route decision 语义。",
      "AgentPacket 内包含 replyContext，处理端需要回传时走 /api/agent/replies。"
    ],
    featureNames: ["Agent adapter", "AgentPacket"]
  },
  {
    id: "outbox",
    title: "Outbox 与回传",
    section: "主链路",
    subtitle: "所有外部写入都应经过 Action Gate。",
    summary: "Outbox 接收 Agent 的回传请求，按 pipeline 和 replyContext 决定草稿、阻止、审批或真正外发。",
    bullets: [
      "真实外发必须经过 Outbox / Action Gate。",
      "QQ、WeCom、RabiLink、role panel 的回传目标来自 AgentPacket 的 replyContext。",
      "失败时应保留可诊断状态，不要让处理端绕过 RabiRoute 直接写平台。"
    ],
    featureNames: ["Outbox / Reply", "Pipeline presets"]
  },
  {
    id: "role-knowledge",
    title: "计划、记忆与技能",
    section: "角色上下文",
    subtitle: "这些是 Agent 上下文，不是路由匹配依据。",
    summary: "roleKnowledgeSnapshot 会检索计划、近期记忆、沉淀记忆和角色技能，并生成处理前必读项。",
    bullets: [
      "命中记忆时可能刷新 viewedAt。",
      "记忆整理会创建 consolidation run，并可能归档近期记忆、写沉淀记忆。",
      "预览模式如果要展示召回结果，需要新增无副作用选项。"
    ],
    featureNames: ["计划 / 记忆 / 技能", "AgentPacket"]
  },
  {
    id: "runtime-data",
    title: "运行数据与日志",
    section: "维护",
    subtitle: "查副作用、排障和 replay 时先看这里。",
    summary: "RabiRoute 当前使用 JSONL 作为轻量事件记录和审计来源。真实投递、消息入口、Outbox 和 replay 都会留下对应文件。",
    bullets: [],
    table: "runtimeData",
    featureNames: ["运行日志 / Delivery replay"]
  },
  {
    id: "editing",
    title: "常见修改入口",
    section: "维护",
    subtitle: "按需求定位模块，减少跨层误改。",
    summary: "新增能力时优先找到归口模块，再决定是否需要 shared model、manager API、WebGUI 页面和测试一起改。",
    bullets: [],
    table: "editEntrypoints"
  }
];

const docSections = computed(() => {
  const result = new Map<string, DocPage[]>();
  for (const page of docPages) {
    if (!result.has(page.section)) result.set(page.section, []);
    result.get(page.section)?.push(page);
  }
  return [...result.entries()].map(([title, pages]) => ({ title, pages }));
});

function featureMatches(item: DocFeature, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    item.name,
    item.status,
    item.owner,
    item.truth,
    item.consumes,
    item.effect,
    item.sideEffects,
    item.entry,
    item.code.join(" "),
    item.docs.join(" "),
    item.keywords
  ].join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function pageMatches(page: DocPage, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const pageFeatureText = features
    .filter((item) => page.featureNames?.includes(item.name))
    .map((item) => [item.name, item.truth, item.consumes, item.entry, item.keywords].join(" "))
    .join(" ");
  const haystack = [
    page.title,
    page.section,
    page.subtitle,
    page.summary,
    page.bullets.join(" "),
    pageFeatureText
  ].join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

const searchTokens = computed(() => query.value.trim().toLowerCase().split(/\s+/).filter(Boolean));

const visibleDocSections = computed(() => {
  const tokens = searchTokens.value;
  return docSections.value
    .map((section) => ({
      ...section,
      pages: section.pages.filter((page) => pageMatches(page, tokens))
    }))
    .filter((section) => section.pages.length > 0);
});

const selectedPage = computed(() => {
  return docPages.find((page) => page.id === activePageId.value) ?? docPages[0];
});

const selectedPageFeatures = computed(() => {
  const tokens = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const names = new Set(selectedPage.value.featureNames ?? []);
  return features.filter((item) => names.has(item.name) && featureMatches(item, tokens));
});

const matchingPageCount = computed(() => visibleDocSections.value.reduce((sum, section) => sum + section.pages.length, 0));

function selectPage(pageId: string): void {
  activePageId.value = pageId;
}
</script>

<template>
  <div class="page-shell docs-page">
    <v-card class="app-card glass-card docs-hero">
      <div>
        <div class="eyebrow">RabiRoute Project Manual</div>
        <h1 class="docs-hero-title">项目功能文档</h1>
        <div class="docs-hero-copy">
          面向产品设计、GUI 改造、代码维护和排障的通用功能手册。这个页面随 RibiWebGUI 一起部署，RabiLink 远程 WebGUI 也能访问。
        </div>
      </div>
      <div class="docs-hero-tools">
        <v-text-field
          v-model="query"
          density="comfortable"
          prepend-inner-icon="mdi-magnify"
          label="搜索功能、代码路径、API 或关键词"
          placeholder="例如：agentRoleId、RabiLink、Outbox、viewedAt、manual-trigger"
          hide-details
          clearable
        />
        <div class="docs-count">{{ matchingPageCount }} / {{ docPages.length }} 页</div>
      </div>
    </v-card>

    <v-card class="app-card glass-card section-card">
      <div class="docs-flow">
        <span>Message Adapter</span>
        <v-icon size="18">mdi-chevron-right</v-icon>
        <span>Event Store</span>
        <v-icon size="18">mdi-chevron-right</v-icon>
        <span>RouteDecision</span>
        <v-icon size="18">mdi-chevron-right</v-icon>
        <span>AgentPacket</span>
        <v-icon size="18">mdi-chevron-right</v-icon>
        <span>Agent Adapter</span>
        <v-icon size="18">mdi-chevron-right</v-icon>
        <span>Outbox / Reply</span>
      </div>
    </v-card>

    <div class="docs-layout">
      <aside class="docs-rail">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row compact-row">
            <div>
              <div class="section-title">目录</div>
              <div class="section-note">点击切换文档页</div>
            </div>
          </div>
          <div v-if="visibleDocSections.length === 0" class="empty-state compact-empty">
            <div>
              <strong>没有匹配页面</strong>
              <span>换一个搜索词。</span>
            </div>
          </div>
          <div v-else class="docs-tree">
            <section v-for="section in visibleDocSections" :key="section.title" class="docs-tree-section">
              <div class="docs-tree-title">{{ section.title }}</div>
              <button
                v-for="page in section.pages"
                :key="page.id"
                class="docs-page-button"
                :class="{ active: selectedPage.id === page.id }"
                type="button"
                @click="selectPage(page.id)"
              >
                <span>{{ page.title }}</span>
                <small>{{ page.subtitle }}</small>
              </button>
            </section>
          </div>
        </v-card>
      </aside>

      <div class="docs-main">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">{{ selectedPage.title }}</div>
              <div class="section-note">{{ selectedPage.subtitle }}</div>
            </div>
            <v-chip color="secondary" variant="tonal">{{ selectedPage.section }}</v-chip>
          </div>
          <div class="docs-page-copy">{{ selectedPage.summary }}</div>
          <div v-if="selectedPage.bullets.length" class="docs-rule-grid mt-4">
            <div v-for="rule in selectedPage.bullets" :key="rule" class="docs-rule-card">
              <v-icon color="secondary" size="18">mdi-bookmark-check-outline</v-icon>
              <span>{{ rule }}</span>
            </div>
          </div>
        </v-card>

        <v-card v-if="selectedPage.table === 'boundaries'" class="app-card glass-card section-card">
          <div class="section-title-row compact-row">
            <div>
              <div class="section-title">项目边界</div>
              <div class="section-note">这些规则是功能设计和实现的红线。</div>
            </div>
          </div>
          <div class="docs-rule-grid">
            <div v-for="rule in boundaryRules" :key="rule" class="docs-rule-card">
              <v-icon color="secondary" size="18">mdi-check-decagram-outline</v-icon>
              <span>{{ rule }}</span>
            </div>
          </div>
        </v-card>

        <v-card v-if="selectedPageFeatures.length > 0 || selectedPage.featureNames?.length" class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">相关功能</div>
              <div class="section-note">当前页面涉及的真源、消费点、生效时机和副作用。</div>
            </div>
          </div>

          <div v-if="selectedPageFeatures.length === 0" class="empty-state compact-empty">
            <div>
              <strong>当前搜索词没有匹配功能项</strong>
              <span>左侧目录仍可切换页面，清空搜索可查看全部相关功能。</span>
            </div>
          </div>

          <div v-else class="docs-feature-list">
            <article v-for="item in selectedPageFeatures" :key="item.name" class="docs-feature-card">
              <div class="docs-feature-head">
                <div class="min-w-0">
                  <div class="docs-feature-title">{{ item.name }}</div>
                  <div class="section-note">{{ item.entry }}</div>
                </div>
                <div class="docs-feature-tags">
                  <v-chip size="small" color="secondary" variant="tonal">{{ item.owner }}</v-chip>
                  <v-chip size="small" :color="item.status.includes('拟') ? 'warning' : 'success'" variant="tonal">{{ item.status }}</v-chip>
                </div>
              </div>

              <div class="docs-fact-grid">
                <div><span>真源</span><b>{{ item.truth }}</b></div>
                <div><span>消费点</span><b>{{ item.consumes }}</b></div>
                <div><span>生效时机</span><b>{{ item.effect }}</b></div>
                <div><span>副作用</span><b>{{ item.sideEffects }}</b></div>
              </div>

              <div class="docs-code-row">
                <code v-for="path in item.code" :key="path">{{ path }}</code>
              </div>
              <div class="docs-link-row">
                <v-chip
                  v-for="path in item.docs"
                  :key="path"
                  size="small"
                  color="secondary"
                  variant="tonal"
                >
                  {{ path.replace("docs/", "") }}
                </v-chip>
              </div>
            </article>
          </div>
        </v-card>

        <div
          v-if="selectedPage.id === 'overview' || selectedPage.table === 'runtimeData' || selectedPage.table === 'editEntrypoints'"
          class="docs-two-column"
        >
          <v-card v-if="selectedPage.id === 'overview' || selectedPage.table === 'runtimeData'" class="app-card glass-card section-card">
            <div class="section-title-row compact-row">
              <div>
                <div class="section-title">运行数据</div>
                <div class="section-note">查日志和副作用时先看。</div>
              </div>
            </div>
            <div class="docs-table-list">
              <div v-for="row in runtimeData" :key="row.name" class="docs-table-card">
                <strong>{{ row.name }}</strong>
                <code>{{ row.path }}</code>
                <span>{{ row.writer }} · {{ row.usage }}</span>
              </div>
            </div>
          </v-card>

          <v-card v-if="selectedPage.id === 'overview' || selectedPage.table === 'editEntrypoints'" class="app-card glass-card section-card">
            <div class="section-title-row compact-row">
              <div>
                <div class="section-title">常见修改入口</div>
                <div class="section-note">改代码前先定位模块。</div>
              </div>
            </div>
            <div class="docs-table-list">
              <div v-for="row in editEntrypoints" :key="row.need" class="docs-table-card">
                <strong>{{ row.need }}</strong>
                <code>{{ row.files }}</code>
                <span>{{ row.note }}</span>
              </div>
            </div>
          </v-card>
        </div>
      </div>
    </div>
  </div>
</template>
