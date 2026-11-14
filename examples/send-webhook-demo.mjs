#!/usr/bin/env node

const endpoint = (process.argv[2] || process.env.RABIROUTE_WEBHOOK_URL || "").trim();
if (!endpoint) {
  console.error("Webhook URL is required: pass the current Route endpoint as the first argument or set RABIROUTE_WEBHOOK_URL.");
  process.exit(1);
}
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
