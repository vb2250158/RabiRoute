#!/usr/bin/env node

const endpoint = process.argv[2] || process.env.RABIROUTE_WEBHOOK_URL || "http://127.0.0.1:8791/webhook";
const text = process.argv[3] || "Hello from RabiRoute Node.js webhook demo";

const payload = {
  type: "webhook.text",
  source: "nodejs-demo",
  sourceDeviceName: "Node.js demo sender",
  sessionId: `demo-${Date.now()}`,
  text
};

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify(payload)
});

if (!response.ok && response.status !== 204) {
  const body = await response.text().catch(() => "");
  throw new Error(`Webhook request failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
}

console.log(`Sent webhook demo message to ${endpoint}`);
console.log(JSON.stringify(payload, null, 2));
