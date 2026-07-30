const MANAGER = "http://127.0.0.1:8790";
const STORAGE_TOKEN = "rabirouteBilibiliBridgeToken";
const POLL_ALARM = "rabiroute-bilibili-history-poll";
let running = false;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function manager(path, options = {}) {
  const response = await fetch(`${MANAGER}${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Manager HTTP ${response.status}`);
  return body;
}

async function token() {
  const stored = await chrome.storage.local.get(STORAGE_TOKEN);
  if (stored[STORAGE_TOKEN]) return stored[STORAGE_TOKEN];
  const paired = await manager("/api/bilibili-history/bridge/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id })
  });
  await chrome.storage.local.set({ [STORAGE_TOKEN]: paired.token });
  return paired.token;
}

async function nextJob(bridgeToken) {
  const result = await manager("/api/bilibili-history/bridge/next", {
    headers: { authorization: `Bearer ${bridgeToken}` }
  });
  return result.job || null;
}

async function submitPage(bridgeToken, payload) {
  return manager("/api/bilibili-history/bridge/page", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function fetchPage(job) {
  const query = new URLSearchParams({
    max: String(job.cursor.max || 0),
    view_at: String(job.cursor.view_at || 0),
    business: job.cursor.business || "",
    ps: String(job.pageSize || 30),
    type: "all"
  });
  const response = await fetch(`${job.endpoint}?${query}`, {
    credentials: "include",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
  const body = await response.json();
  return {
    jobId: job.id,
    pageKey: `${job.cursor.max || 0}:${job.cursor.view_at || 0}:${job.cursor.business || ""}`,
    code: Number(body.code),
    message: body.message || "",
    items: Array.isArray(body.data?.list) ? body.data.list : [],
    nextCursor: body.data?.cursor || {}
  };
}

async function run() {
  if (running) return;
  running = true;
  try {
    const bridgeToken = await token();
    let job = await nextJob(bridgeToken);
    while (job) {
      let payload;
      try {
        payload = await fetchPage(job);
      } catch (error) {
        payload = {
          jobId: job.id,
          pageKey: `${job.cursor.max || 0}:${job.cursor.view_at || 0}:${job.cursor.business || ""}`,
          code: -1,
          message: String(error?.message || error),
          items: [],
          nextCursor: job.cursor
        };
      }
      const accepted = await submitPage(bridgeToken, payload);
      if (accepted.done) break;
      await delay(Number(accepted.waitMs) || 650);
      job = { ...job, cursor: accepted.nextCursor };
    }
  } catch {
    // Manager offline and login/risk-control states are expected stop conditions.
    // The alarm will retry Manager connectivity later; paused jobs are not returned.
  } finally {
    running = false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { delayInMinutes: 0.05, periodInMinutes: 1 });
  void run();
});
chrome.runtime.onStartup.addListener(() => void run());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === POLL_ALARM) void run();
});
chrome.action.onClicked.addListener(() => void run());
