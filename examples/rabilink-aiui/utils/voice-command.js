export const VOICE_COMMANDS = {
  SWITCH_TO_CONFIGURATION: "switchToConfiguration",
  SWITCH_TO_TRANSCRIPTION: "switchToTranscription",
  PAUSE_TRANSCRIPTION: "pauseTranscription",
  RESUME_TRANSCRIPTION: "resumeTranscription",
  RETRY_TRANSCRIPTS: "retryTranscripts",
  CONNECT_RELAY: "connectRelay",
  BIND_WORKER: "bindWorker",
  READ_ROUTES: "readRoutes",
  READ_AGENT: "readAgent",
  SAVE_BINDING: "saveBinding",
  LOAD_CONFIG: "loadConfig",
  SAVE_CONFIG: "saveConfig",
  TOGGLE_ROUTE: "toggleRoute",
  TOGGLE_MESSAGE_INPUT: "toggleMessageInput",
  READ_NETWORK: "readNetwork",
  SCAN_AGENT: "scanAgent",
  SCAN_MESSAGE: "scanMessage",
  CHECK_NAPCAT: "checkNapcat",
  CONFIGURE_NAPCAT: "configureNapcat",
  REPAIR_NAPCAT: "repairNapcat",
  CHECK_ASTRBOT: "checkAstrbot",
  START_MANAGER: "startManager",
  START_ROUTE: "startRoute",
  STOP_ROUTE: "stopRoute",
  RESTART_ROUTE: "restartRoute",
  MANUAL_TRIGGER: "manualTrigger",
  ADD_ROUTE: "addRoute",
  DUPLICATE_ROUTE: "duplicateRoute",
  REMOVE_ROUTE: "removeRoute",
  MOVE_ROUTE_UP: "moveRouteUp",
  MOVE_ROUTE_DOWN: "moveRouteDown",
  ADD_VARIABLE: "addVariable",
  APPLY_VARIABLE: "applyVariable",
  REMOVE_VARIABLE: "removeVariable",
  NEXT_VARIABLE: "nextVariable",
  PREV_VARIABLE: "prevVariable",
  ADD_RULE: "addRule",
  APPLY_RULE: "applyRule",
  REMOVE_RULE: "removeRule",
  TOGGLE_RULE: "toggleRule",
  NEXT_RULE: "nextRule",
  PREV_RULE: "prevRule",
  ADD_SCHEDULE: "addSchedule",
  APPLY_SCHEDULE: "applySchedule",
  REMOVE_SCHEDULE: "removeSchedule",
  TOGGLE_SCHEDULE: "toggleSchedule",
  NEXT_SCHEDULE: "nextSchedule",
  PREV_SCHEDULE: "prevSchedule",
  APPLY_POLICY: "applyPolicy",
  TOGGLE_POLICY_INPUT: "togglePolicyInput",
  TOGGLE_POLICY_OUTPUT: "togglePolicyOutput",
  NEXT_POLICY: "nextPolicy",
  PREV_POLICY: "prevPolicy",
  APPLY_PIPELINE: "applyPipeline",
  CLEAR_PIPELINE: "clearPipeline",
  TOGGLE_PIPELINE_TTS: "togglePipelineTts",
  TOGGLE_PIPELINE_GUARD: "togglePipelineGuard",
  TOGGLE_PIPELINE_REPLY: "togglePipelineReply",
  NEXT_PIPELINE_OUTPUT: "nextPipelineOutput",
  PREV_PIPELINE_OUTPUT: "prevPipelineOutput",
  NEXT_PIPELINE_PROMPT: "nextPipelinePrompt",
  PREV_PIPELINE_PROMPT: "prevPipelinePrompt",
  ADD_NAPCAT: "addNapcat",
  APPLY_NAPCAT: "applyNapcat",
  REMOVE_NAPCAT: "removeNapcat",
  TOGGLE_NAPCAT: "toggleNapcat",
  NEXT_NAPCAT: "nextNapcat",
  PREV_NAPCAT: "prevNapcat",
  ADD_PROFILE: "addProfile",
  APPLY_PROFILE: "applyProfile",
  REMOVE_PROFILE: "removeProfile",
  TOGGLE_PROFILE: "toggleProfile",
  NEXT_PROFILE: "nextProfile",
  PREV_PROFILE: "prevProfile",
  APPLY_TEMPLATE: "applyTemplate",
  CLEAR_TEMPLATE: "clearTemplate",
  NEXT_TEMPLATE: "nextTemplate",
  PREV_TEMPLATE: "prevTemplate",
  APPLY_INTEGRATIONS: "applyIntegrations",
  NEXT_PANEL: "nextPanel",
  PREV_PANEL: "prevPanel",
  NEXT_ROUTE: "nextRoute",
  PREV_ROUTE: "prevRoute",
  NEXT_WORKER: "nextWorker",
  PREV_WORKER: "prevWorker",
  UNKNOWN: "unknown"
};

const commandPatterns = [
  { command: VOICE_COMMANDS.SWITCH_TO_CONFIGURATION, patterns: ["切到配置助手", "进入配置助手", "打开配置助手", "配置助手模式"] },
  { command: VOICE_COMMANDS.SWITCH_TO_TRANSCRIPTION, patterns: ["切到连接对话", "回到连接对话", "进入连接对话", "连接对话模式", "切到Agent对话", "回到Agent对话", "进入Agent对话", "Agent对话模式", "切到Rabi对话", "回到Rabi对话", "切到实时转写", "回到实时转写", "进入实时转写", "实时转写模式", "切到录音转写", "回到录音转写", "进入录音转写", "转写模式", "应用运行模式"] },
  { command: VOICE_COMMANDS.PAUSE_TRANSCRIPTION, patterns: ["暂停对话", "停止聆听", "暂停转写", "停止转写", "暂停录音"] },
  { command: VOICE_COMMANDS.RESUME_TRANSCRIPTION, patterns: ["继续对话", "继续聆听", "继续转写", "恢复转写", "继续录音"] },
  { command: VOICE_COMMANDS.RETRY_TRANSCRIPTS, patterns: ["重试回复", "继续等待Agent", "重试同步", "重新同步", "补传转写"] },
  { command: VOICE_COMMANDS.CONNECT_RELAY, patterns: ["连接", "连服务器", "连接服务器", "连接 relay"] },
  { command: VOICE_COMMANDS.BIND_WORKER, patterns: ["绑定", "这台", "选这台", "绑定电脑", "绑定 pc"] },
  { command: VOICE_COMMANDS.READ_ROUTES, patterns: ["路由", "route", "读取 route", "读取路由"] },
  { command: VOICE_COMMANDS.READ_AGENT, patterns: ["代理", "agent", "读取 agent", "读取代理"] },
  { command: VOICE_COMMANDS.SAVE_BINDING, patterns: ["保存", "保存绑定", "确认绑定"] },
  { command: VOICE_COMMANDS.LOAD_CONFIG, patterns: ["读取配置", "配置", "webgui", "读取 webgui"] },
  { command: VOICE_COMMANDS.SAVE_CONFIG, patterns: ["保存配置", "写入配置", "保存 webgui"] },
  { command: VOICE_COMMANDS.TOGGLE_ROUTE, patterns: ["启用路由", "禁用路由", "切换路由"] },
  { command: VOICE_COMMANDS.TOGGLE_MESSAGE_INPUT, patterns: ["启用消息", "禁用消息", "切换消息"] },
  { command: VOICE_COMMANDS.READ_NETWORK, patterns: ["读取网络", "网络选项", "网络"] },
  { command: VOICE_COMMANDS.SCAN_AGENT, patterns: ["扫描agent", "扫描代理", "agent扫描", "代理扫描"] },
  { command: VOICE_COMMANDS.SCAN_MESSAGE, patterns: ["扫描消息", "消息扫描", "扫描消息端"] },
  { command: VOICE_COMMANDS.CHECK_NAPCAT, patterns: ["检查napcat", "napcat健康", "检查qq", "qq健康"] },
  { command: VOICE_COMMANDS.CONFIGURE_NAPCAT, patterns: ["配置napcat", "配置onebot", "修复onebot", "写入onebot"] },
  { command: VOICE_COMMANDS.REPAIR_NAPCAT, patterns: ["修复napcat", "一键修复napcat", "修复qq", "一键修复qq"] },
  { command: VOICE_COMMANDS.CHECK_ASTRBOT, patterns: ["验证astrbot", "检查astrbot", "astrbot登录"] },
  { command: VOICE_COMMANDS.START_MANAGER, patterns: ["启动manager", "启动管理器", "启动rabi"] },
  { command: VOICE_COMMANDS.START_ROUTE, patterns: ["启动route", "启动路由", "开始路由"] },
  { command: VOICE_COMMANDS.STOP_ROUTE, patterns: ["停止route", "停止路由", "关闭路由"] },
  { command: VOICE_COMMANDS.RESTART_ROUTE, patterns: ["重启route", "重启路由"] },
  { command: VOICE_COMMANDS.MANUAL_TRIGGER, patterns: ["手动触发", "触发路由", "触发route"] },
  { command: VOICE_COMMANDS.ADD_ROUTE, patterns: ["新增route", "新增路由", "新建route", "新建路由"] },
  { command: VOICE_COMMANDS.DUPLICATE_ROUTE, patterns: ["复制route", "复制路由", "克隆route", "克隆路由"] },
  { command: VOICE_COMMANDS.REMOVE_ROUTE, patterns: ["移除route", "移除路由", "删除route", "删除路由"] },
  { command: VOICE_COMMANDS.MOVE_ROUTE_UP, patterns: ["上移route", "上移路由", "路由上移"] },
  { command: VOICE_COMMANDS.MOVE_ROUTE_DOWN, patterns: ["下移route", "下移路由", "路由下移"] },
  { command: VOICE_COMMANDS.ADD_VARIABLE, patterns: ["添加变量", "新增变量", "新建变量"] },
  { command: VOICE_COMMANDS.APPLY_VARIABLE, patterns: ["应用变量", "保存变量"] },
  { command: VOICE_COMMANDS.REMOVE_VARIABLE, patterns: ["移除变量", "删除变量"] },
  { command: VOICE_COMMANDS.NEXT_VARIABLE, patterns: ["下一个变量", "下一条变量"] },
  { command: VOICE_COMMANDS.PREV_VARIABLE, patterns: ["上一个变量", "上一条变量"] },
  { command: VOICE_COMMANDS.ADD_RULE, patterns: ["添加规则", "新增规则", "新建规则"] },
  { command: VOICE_COMMANDS.APPLY_RULE, patterns: ["应用规则", "保存规则"] },
  { command: VOICE_COMMANDS.REMOVE_RULE, patterns: ["移除规则", "删除规则"] },
  { command: VOICE_COMMANDS.TOGGLE_RULE, patterns: ["启用规则", "停用规则", "禁用规则", "切换规则"] },
  { command: VOICE_COMMANDS.NEXT_RULE, patterns: ["下一个规则", "下一条规则"] },
  { command: VOICE_COMMANDS.PREV_RULE, patterns: ["上一个规则", "上一条规则"] },
  { command: VOICE_COMMANDS.ADD_SCHEDULE, patterns: ["添加计划", "新增计划", "新建计划"] },
  { command: VOICE_COMMANDS.APPLY_SCHEDULE, patterns: ["应用计划", "保存计划"] },
  { command: VOICE_COMMANDS.REMOVE_SCHEDULE, patterns: ["移除计划", "删除计划"] },
  { command: VOICE_COMMANDS.TOGGLE_SCHEDULE, patterns: ["启用计划", "停用计划", "禁用计划", "切换计划"] },
  { command: VOICE_COMMANDS.NEXT_SCHEDULE, patterns: ["下一个计划", "下一条计划"] },
  { command: VOICE_COMMANDS.PREV_SCHEDULE, patterns: ["上一个计划", "上一条计划"] },
  { command: VOICE_COMMANDS.APPLY_POLICY, patterns: ["应用策略", "保存策略"] },
  { command: VOICE_COMMANDS.TOGGLE_POLICY_INPUT, patterns: ["切换输入策略", "启用输入策略", "禁用输入策略", "输入策略"] },
  { command: VOICE_COMMANDS.TOGGLE_POLICY_OUTPUT, patterns: ["切换输出策略", "启用输出策略", "禁用输出策略", "输出策略"] },
  { command: VOICE_COMMANDS.NEXT_POLICY, patterns: ["下一个策略", "下一条策略"] },
  { command: VOICE_COMMANDS.PREV_POLICY, patterns: ["上一个策略", "上一条策略"] },
  { command: VOICE_COMMANDS.APPLY_PIPELINE, patterns: ["应用管道", "保存管道", "应用pipeline", "保存pipeline"] },
  { command: VOICE_COMMANDS.CLEAR_PIPELINE, patterns: ["清空管道", "移除管道", "删除管道", "清空pipeline"] },
  { command: VOICE_COMMANDS.TOGGLE_PIPELINE_TTS, patterns: ["切换tts播放", "开启tts播放", "关闭tts播放", "tts播放"] },
  { command: VOICE_COMMANDS.TOGGLE_PIPELINE_GUARD, patterns: ["切换防回流", "开启防回流", "关闭防回流", "防回流"] },
  { command: VOICE_COMMANDS.TOGGLE_PIPELINE_REPLY, patterns: ["切换回复来源", "回到来源", "回复来源"] },
  { command: VOICE_COMMANDS.NEXT_PIPELINE_OUTPUT, patterns: ["下一个输出管道", "下一个输出端", "下一个pipeline输出"] },
  { command: VOICE_COMMANDS.PREV_PIPELINE_OUTPUT, patterns: ["上一个输出管道", "上一个输出端", "上一个pipeline输出"] },
  { command: VOICE_COMMANDS.NEXT_PIPELINE_PROMPT, patterns: ["下一个输出模式", "下一个提示模式", "下一个prompt模式"] },
  { command: VOICE_COMMANDS.PREV_PIPELINE_PROMPT, patterns: ["上一个输出模式", "上一个提示模式", "上一个prompt模式"] },
  { command: VOICE_COMMANDS.ADD_NAPCAT, patterns: ["添加napcat", "新增napcat", "新建napcat", "添加qq实例"] },
  { command: VOICE_COMMANDS.APPLY_NAPCAT, patterns: ["应用napcat", "保存napcat", "应用qq实例", "保存qq实例"] },
  { command: VOICE_COMMANDS.REMOVE_NAPCAT, patterns: ["移除napcat", "删除napcat", "移除qq实例", "删除qq实例"] },
  { command: VOICE_COMMANDS.TOGGLE_NAPCAT, patterns: ["启用napcat", "禁用napcat", "切换napcat", "启用qq实例", "禁用qq实例"] },
  { command: VOICE_COMMANDS.NEXT_NAPCAT, patterns: ["下一个napcat", "下一个qq实例"] },
  { command: VOICE_COMMANDS.PREV_NAPCAT, patterns: ["上一个napcat", "上一个qq实例"] },
  { command: VOICE_COMMANDS.ADD_PROFILE, patterns: ["添加profile", "新增profile", "新建profile", "添加路由profile"] },
  { command: VOICE_COMMANDS.APPLY_PROFILE, patterns: ["应用profile", "保存profile", "应用路由profile"] },
  { command: VOICE_COMMANDS.REMOVE_PROFILE, patterns: ["移除profile", "删除profile", "移除路由profile"] },
  { command: VOICE_COMMANDS.TOGGLE_PROFILE, patterns: ["启用profile", "禁用profile", "切换profile"] },
  { command: VOICE_COMMANDS.NEXT_PROFILE, patterns: ["下一个profile", "下一个路由profile"] },
  { command: VOICE_COMMANDS.PREV_PROFILE, patterns: ["上一个profile", "上一个路由profile"] },
  { command: VOICE_COMMANDS.APPLY_TEMPLATE, patterns: ["应用模板", "保存模板"] },
  { command: VOICE_COMMANDS.CLEAR_TEMPLATE, patterns: ["清空模板", "删除模板", "恢复默认模板"] },
  { command: VOICE_COMMANDS.NEXT_TEMPLATE, patterns: ["下一个模板", "下一条模板"] },
  { command: VOICE_COMMANDS.PREV_TEMPLATE, patterns: ["上一个模板", "上一条模板"] },
  { command: VOICE_COMMANDS.APPLY_INTEGRATIONS, patterns: ["应用集成", "保存集成", "应用消息端配置", "保存消息端配置"] },
  { command: VOICE_COMMANDS.NEXT_PANEL, patterns: ["下一个面板", "下一页", "下一个配置"] },
  { command: VOICE_COMMANDS.PREV_PANEL, patterns: ["上一个面板", "上一页", "上一个配置"] },
  { command: VOICE_COMMANDS.NEXT_ROUTE, patterns: ["下一个路由", "下一个 route", "下一条路由"] },
  { command: VOICE_COMMANDS.PREV_ROUTE, patterns: ["上一个路由", "上一个 route", "上一条路由"] },
  { command: VOICE_COMMANDS.NEXT_WORKER, patterns: ["下一台", "下一个电脑", "下一个 pc"] },
  { command: VOICE_COMMANDS.PREV_WORKER, patterns: ["上一台", "上一个电脑", "上一个 pc"] }
];

export function voiceCommandSamples() {
  return commandPatterns.map((item) => ({
    command: item.command,
    text: item.patterns[0]
  }));
}

export function voiceCommandCases() {
  return commandPatterns.flatMap((item) => item.patterns.map((text) => ({
    command: item.command,
    text
  })));
}

export function parseVoiceCommand(input) {
  const text = normalizeVoiceText(input);
  if (!text) return { command: VOICE_COMMANDS.UNKNOWN, text };
  let matched = null;
  let matchedLength = -1;
  commandPatterns.forEach((item) => {
    item.patterns.forEach((pattern) => {
      const normalizedPattern = normalizeVoiceText(pattern);
      if (!normalizedPattern || !text.includes(normalizedPattern) || normalizedPattern.length <= matchedLength) return;
      matched = item;
      matchedLength = normalizedPattern.length;
    });
  });
  return {
    command: matched ? matched.command : VOICE_COMMANDS.UNKNOWN,
    text
  };
}

export function parseConfigurationIntent(input) {
  const text = normalizeVoiceText(input);
  if (!text) return { command: VOICE_COMMANDS.UNKNOWN, text };
  const directCommand = Object.values(VOICE_COMMANDS).find((command) => {
    return command !== VOICE_COMMANDS.UNKNOWN && normalizeVoiceText(command) === text;
  });
  if (directCommand) return { command: directCommand, text };
  for (const item of commandPatterns) {
    if (item.patterns.some((pattern) => normalizeVoiceText(pattern) === text)) {
      return { command: item.command, text };
    }
  }
  return { command: VOICE_COMMANDS.UNKNOWN, text };
}

export function voiceCommandHint() {
  return "可说：切到配置助手、切到连接对话、暂停对话、继续对话、连接服务器、读取配置或保存配置。";
}

function normalizeVoiceText(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}
