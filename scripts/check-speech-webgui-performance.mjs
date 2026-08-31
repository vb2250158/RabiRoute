#!/usr/bin/env node

import { performance } from "node:perf_hooks";

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = String(argument("--base-url", process.env.GATEWAY_MANAGER_URL || "")).replace(/\/+$/, "");
if (!baseUrl) throw new Error("Pass --base-url with the current Host-published Manager URL.");
const samples = Math.max(1, Number(argument("--samples", "3")) || 3);
const timeoutMs = Math.max(100, Number(argument("--timeout-ms", "20000")) || 20_000);

const endpoints = [
  "/meta",
  "/network-options",
  "/gateways",
  "/api/speech/status",
  "/api/speech/models",
  "/api/speech/personas",
  "/api/speech/microphone/devices",
  "/api/speech/audio-streams",
  "/api/speech/microphone/status",
  "/api/speech/playback/status"
];

async function measure(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    const body = await response.arrayBuffer();
    return {
      pathname,
      status: response.status,
      ok: response.ok,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      bytes: body.byteLength
    };
  } catch (error) {
    return {
      pathname,
      status: 0,
      ok: false,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      bytes: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

const rows = [];
for (let sample = 1; sample <= samples; sample += 1) {
  for (const endpoint of endpoints) {
    rows.push({ sample, ...(await measure(endpoint)) });
  }
}

const summary = endpoints.map(pathname => {
  const matching = rows.filter(row => row.pathname === pathname);
  const durations = matching.map(row => row.durationMs);
  return {
    pathname,
    statuses: [...new Set(matching.map(row => row.status))],
    bytes: Math.max(...matching.map(row => row.bytes)),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95)
  };
});

const report = {
  baseUrl,
  samples,
  measuredAt: new Date().toISOString(),
  summary,
  failures: rows
    .filter(row => !row.ok)
    .map(({ sample, pathname, status, error }) => ({ sample, pathname, status, error }))
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.failures.length ? 1 : 0;
