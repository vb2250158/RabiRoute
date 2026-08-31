#!/usr/bin/env node

import { discoverManagerBaseUrl } from "./lib/discover-manager-url.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const has = (name) => args.includes(name);

if (has("--help") || !value("--role-id") || !value("--since")) {
  console.log(`Usage:
  node scripts/request-bilibili-history.mjs --role-id <persona> --since <date> [--until <date>] [--wait]

Examples:
  node scripts/request-bilibili-history.mjs --role-id YeYu --since 2026-06-29 --wait
  node scripts/request-bilibili-history.mjs --role-id YeYu --since 2025-01-01 --until 2025-02-01 --wait`);
  process.exit(has("--help") ? 0 : 2);
}

const manager = discoverManagerBaseUrl({
  explicit: process.env.RABI_MANAGER_URL,
  environmentNames: ["RABIROUTE_MANAGER_URL", "GATEWAY_MANAGER_URL"]
});
const request = async (pathname, options) => {
  const response = await fetch(`${manager}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `HTTP ${response.status}`);
  return body;
};

const localDateTime = (text) => {
  if (!text) return "";
  if (/^\d+$/.test(text)) return Number(text);
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`Invalid date: ${text}`);
  return parsed.toISOString();
};

const created = await request("/api/bilibili-history/jobs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    roleId: value("--role-id"),
    since: localDateTime(value("--since")),
    until: value("--until") ? localDateTime(value("--until")) : new Date().toISOString(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset()
  })
});

console.log(JSON.stringify(created, null, 2));
if (!has("--wait")) process.exit(0);

const jobId = created.job.id;
let lastStatus = "";
for (;;) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const current = await request(`/api/bilibili-history/jobs/${encodeURIComponent(jobId)}`);
  if (current.job.status !== lastStatus) {
    console.error(`bilibili-history: ${current.job.status} pages=${current.job.pagesProcessed}`);
    lastStatus = current.job.status;
  }
  if (["completed", "failed", "paused"].includes(current.job.status)) {
    console.log(JSON.stringify(current, null, 2));
    process.exit(current.job.status === "completed" ? 0 : 1);
  }
}
