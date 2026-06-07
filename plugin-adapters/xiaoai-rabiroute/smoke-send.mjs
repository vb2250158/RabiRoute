const bridgeUrl = process.env.XIAOAI_BRIDGE_URL || "http://127.0.0.1:8798";

const response = await fetch(`${bridgeUrl}/v1/xiaoai/decision`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    deviceId: "dev_xiaoai",
    deviceName: "开发小爱",
    area: "lab",
    sessionId: "smoke-session",
    text: "问 Rabi 这是一条小爱刷机桥接测试",
    messageId: `smoke-${Date.now()}`
  })
});

console.log(response.status, await response.text());
