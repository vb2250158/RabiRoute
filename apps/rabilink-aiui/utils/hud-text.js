// Only display copies are bounded. Raw model/context/tool data remain unchanged.
export function hudText(value, columns, lines = 1) {
  if (!Number.isInteger(columns) || columns < 2 || !Number.isInteger(lines) || lines < 1) throw new Error("HUD_BUDGET_INVALID");
  const chars = Array.from(String(value || "").replace(/\s+/g, " "));
  let output = "", width = 0, line = 1;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i], cost = /[\x20-\x7e]/.test(c) ? 1 : 2;
    if (width + cost > columns) { if (line >= lines) { const kept = Array.from(output); while (width + 2 > columns && kept.length) { const removed = kept.pop(); width -= /[\x20-\x7e]/.test(removed) ? 1 : 2; } return kept.join("") + "…"; } output += "\n"; width = 0; line++; }
    output += c; width += cost;
  }
  return output;
}

const toolProgressLabels = {
  rabi_api_help: "正在查找接口",
  rabi_api_call: "正在调用接口",
  rabi_task_follow: "正在跟进任务",
  assistant_canvas: "正在更新画布",
  close_app: "正在关闭应用"
};

export function toolProgressLabel(tool) {
  if (tool?.name === "rabi_api_call" && String(tool.arguments?.path || "").split(/[?#]/, 1)[0] === "/api/search") {
    return "正在检索资料";
  }
  return Object.hasOwn(toolProgressLabels, tool?.name) ? toolProgressLabels[tool.name] : "正在调用工具";
}

export function hudDisplayFields(data) {
  const captureStatus = ['正在收音', '正在转写', '正在识别'].includes(data.transcriptionState)
    ? data.transcriptionState : '';
  return {
    hudDisplayName: hudText(data.modelProbe ? "Rabi 宿主模型测试" : data.lingzhuAgentName || "拉比小助手", 14),
    hudDisplayStatus: hudText(data.voiceErrorText || (data.visualCanvasVisible && data.activeToolStatus) || captureStatus || (data.agentSpeaking ? "播报中" : data.assistantModelBusy ? (data.agentReplyText ? "正在回复" : "思考中") : (data.transcriptionListening || data.assistantListening) ? "正在聆听" : data.agentPolling ? "连接中" : data.agentStatus || "就绪"), 12),
    hudDisplayReply: hudText(data.agentReplyText || data.assistantReplyText, 26, 2),
    hudDisplayUser: hudText(data.transcriptionText || data.assistantUserText, 32),
    hudDisplayCue: hudText(data.agentSpeakingCue, 24)
  };
}
export function installHudDisplay(page) {
  if (page.hudDisplayInstalled) return;
  page.hudDisplayInstalled = true;
  const original = page.setData;
  page.setData = function (patch, ...args) {
    return original.call(this, { ...patch, ...hudDisplayFields({ ...this.data, ...patch }) }, ...args);
  };
  page.setData({});
}
