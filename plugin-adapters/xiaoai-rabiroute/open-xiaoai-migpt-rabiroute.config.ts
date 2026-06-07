import { OpenXiaoAIConfig } from "./migpt/xiaoai.js";

const bridgeUrl = process.env.RABIROUTE_XIAOAI_BRIDGE_URL || "http://host.docker.internal:8798";

type XiaoAIDecision = {
  ok: boolean;
  action: "ignore" | "intercept";
  speakText?: string;
  reason?: string;
};

async function postDecision(text: string): Promise<XiaoAIDecision> {
  const response = await fetch(`${bridgeUrl}/v1/xiaoai/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: process.env.XIAOAI_DEVICE_ID || "xiaoai_lx06",
      deviceName: process.env.XIAOAI_DEVICE_NAME || "小爱音箱 Pro",
      area: process.env.XIAOAI_AREA || "home",
      sessionId: `open-xiaoai-${Date.now()}`,
      text,
      messageId: `open-xiaoai-${Date.now()}`
    })
  });

  if (!response.ok) {
    throw new Error(`RabiRoute bridge returned ${response.status}: ${await response.text()}`);
  }

  return await response.json() as XiaoAIDecision;
}

export const kOpenXiaoAIConfig: OpenXiaoAIConfig = {
  openai: {
    baseURL: "http://127.0.0.1/v1",
    apiKey: "not-used",
    model: "not-used"
  },
  prompt: {
    system: ""
  },
  context: {
    historyMaxLength: 0
  },
  callAIKeywords: [],
  async onMessage(engine, { text }) {
    let decision: XiaoAIDecision;
    try {
      decision = await postDecision(text);
    } catch (error) {
      console.warn("[RabiRoute XiaoAI] failed to send transcript:", error);
      return { handled: true };
    }

    if (decision.action !== "intercept") {
      return { handled: true };
    }

    await engine.speaker.abortXiaoAI();
    if (decision.speakText) {
      await engine.speaker.play({
        text: decision.speakText,
        blocking: true
      });
    }
    return { handled: true };
  }
};
