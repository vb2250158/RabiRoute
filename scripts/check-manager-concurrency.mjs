const baseUrl = String(process.argv[2] || "http://127.0.0.1:8790").replace(/\/+$/, "");
const roleId = String(process.argv[3] || "XinghaiBuilder").trim();
const metaProbeCount = 50;

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

async function timedRequest(pathname, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`deadline ${timeoutMs} ms`)), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    await response.arrayBuffer();
    return {
      pathname,
      status: response.status,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10
    };
  } catch (error) {
    return {
      pathname,
      status: 0,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const encodedRoleId = encodeURIComponent(roleId);
  const from = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const heavyPaths = [
    `/api/roles/${encodedRoleId}/voice-transcripts?includeArchives=true&includeDetails=false&from=${from}`,
    `/api/roles/${encodedRoleId}/voice-transcripts?includeArchives=true&includeDetails=false&from=${from}&limit=100`,
    `/api/roles/${encodedRoleId}/voice-transcripts?includeArchives=true&includeDetails=false&from=${from}&limit=50`,
    `/api/persona-sync/conflicts?roleId=${encodedRoleId}`,
    "/gateways",
    `/api/roles/${encodedRoleId}/plans?limit=50&detail=summary`
  ];
  const heavy = heavyPaths.map(pathname => timedRequest(pathname, 30_000));
  await new Promise(resolve => setTimeout(resolve, 100));
  const meta = [];
  for (let round = 0; round < metaProbeCount / 5; round += 1) {
    meta.push(...await Promise.all(Array.from({ length: 5 }, () => timedRequest("/meta", 1_000))));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const heavyResults = await Promise.all(heavy);
  const metaDurations = meta.map(item => item.durationMs);
  const metaP95Ms = percentile(metaDurations, 0.95);
  const metaMaxMs = Math.max(0, ...metaDurations);
  const acceptedHeavyStatuses = new Set([200, 202, 503, 504]);
  const failures = [
    ...meta.filter(item => item.status !== 200).map(item => `meta ${item.status} ${item.durationMs}ms`),
    ...heavyResults.filter(item => !acceptedHeavyStatuses.has(item.status)).map(item => `${item.pathname} ${item.status} ${item.durationMs}ms`),
    ...(metaP95Ms > 500 ? [`meta p95 ${metaP95Ms}ms exceeded 500ms`] : []),
    ...(metaMaxMs > 1_000 ? [`meta max ${metaMaxMs}ms exceeded 1000ms`] : [])
  ];
  const summary = {
    baseUrl,
    roleId,
    meta: {
      requested: meta.length,
      passed: meta.filter(item => item.status === 200).length,
      p95Ms: metaP95Ms,
      maxMs: metaMaxMs
    },
    heavy: heavyResults,
    thresholds: {
      metaP95Ms: 500,
      metaMaxMs: 1_000,
      heavyDeadlineMs: 30_000
    },
    passed: failures.length === 0,
    failures
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) process.exitCode = 1;
}

await main();
