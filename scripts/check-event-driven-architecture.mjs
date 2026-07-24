import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const runtimeRoots = [
  "src",
  "ribiwebgui/src",
  "apps/rabilink-android/app/src/main",
  "apps/rabilink-aiui/pages",
  "apps/rabilink-aiui/utils",
  "desktop/rabi-voice-client",
  "desktop/tray-task-window",
  "plugin-adapters/rabi-speech/rabispeech",
  "plugin-adapters/remote-agent-rabiroute",
  "scripts/rabilink-event-hub.mjs",
  "scripts/rabilink-proxy-request-queue.mjs",
  "scripts/rabilink-relay-server.mjs"
];
const protocolKeepaliveMarkers = [
  "event-driven-allow: SSE protocol keepalive",
  "event-driven-allow: transport heartbeat keepalive",
  "event-driven-allow: known-offline connectivity callback safety check"
];
const checks = [
  {
    files: ["ribiwebgui/src"],
    pattern: /\bsetInterval\s*\(/,
    message: "WebGUI business state must use owner events, not interval polling."
  },
  {
    files: ["src/rabilinkConversationReviewer.ts"],
    pattern: /\bsetInterval\s*\(|checkInBackground\(["']interval["']\)/,
    message: "Active-intelligence review must wake from ledger/timer events, not scan on an interval."
  },
  {
    files: ["src/adapters/rabilinkRelayWorker.ts"],
    pattern: /rememberAcceptedRelayTask\(taskId\);\s*startDefaultRabiLinkConversationReviewer\(\)\?\.wake\(\)/,
    message: "Direct RabiLink messages already enter the Agent delivery path and must not trigger a redundant ledger review read."
  },
  {
    files: ["src/adapters/rabilinkRelayWorker.ts", "src/manager/rabiLinkRelayRuntime.ts"],
    pattern: /claim(?:RelayTask|WebguiRequests|SpeechRequests)\([^)]*(?:claimWaitMs|60000)|恢复轮询|long.?poll/i,
    message: "Relay consumers must subscribe to /api/rabilink/events and claim immediately."
  },
  {
    files: ["apps/rabilink-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java"],
    pattern: /pollLoop|scheduleWithFixedDelay\s*\(/,
    message: "Android downlink and reliable queues must be event/retry driven, not periodically polled."
  },
  {
    files: ["apps/rabilink-android/app/src/main/java/com/rabi/link/modules/wearable"],
    pattern: /pollInterval|delay\s*\([^)]*60_000|while\s*\(\s*isActive\s*\)/,
    message: "Wearable health reads must be triggered by explicit platform/user/startup events."
  },
  {
    files: ["plugin-adapters/rabi-speech/rabispeech/app.py"],
    pattern: /_watch_rabilink_audio_streams|RABILINK_AUDIO_WATCHDOG_INTERVAL/,
    message: "RabiLink PCM expiry must rearm from start/chunk events instead of polling stream age."
  },
  {
    files: ["src/personaSync.ts"],
    pattern: /function\s+walkFiles\s*\(/,
    message: "Persona sync manifest queries must read the event-maintained index instead of rescanning and rehashing the persona tree."
  }
];

function filesUnder(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [absolute];
  const result = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^(?:node_modules|\.deps|\.pytest_cache|\.venv.*|__pycache__|build|dist|out)$/.test(entry.name)) continue;
        visit(target);
      }
      else if (/\.(?:ts|vue|java|kt|mjs|py|ink)$/.test(entry.name)) result.push(target);
    }
  };
  visit(absolute);
  return result;
}

function isRuntimeSource(file) {
  const relative = path.relative(root, file).replace(/\\/g, "/");
  return !/(?:^|\/)(?:tests?|__pycache__|\.deps|\.pytest_cache|\.venv[^/]*|node_modules|build|dist|out)(?:\/|$)/.test(relative)
    && !/\.test\.[^.]+$/.test(relative);
}

const failures = [];
for (const check of checks) {
  for (const file of check.files.flatMap(filesUnder)) {
    const text = fs.readFileSync(file, "utf8");
    if (check.pattern.test(text)) failures.push(`${path.relative(root, file)}: ${check.message}`);
  }
}

const personaSyncSource = fs.readFileSync(path.join(root, "src/personaSync.ts"), "utf8");
if (!/new\s+PersonaSyncManifestIndex\s*\(/.test(personaSyncSource)) {
  failures.push("src/personaSync.ts: Persona sync manifest queries must be owned by PersonaSyncManifestIndex.");
}

for (const file of runtimeRoots.flatMap(filesUnder).filter(isRuntimeSource)) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bsetInterval\s*\(/g)) {
    const prefix = source.slice(Math.max(0, (match.index || 0) - 180), match.index || 0);
    if (!protocolKeepaliveMarkers.some(marker => prefix.includes(marker))) {
      failures.push(`${path.relative(root, file)}: Periodic timers require a documented protocol-keepalive exception; business work must use events or one-shot deadlines.`);
    }
  }
  if (/\bscheduleWithFixedDelay\s*\(|\bscheduleAtFixedRate\s*\(|\bfixedRateTimer\s*\(/.test(source)) {
    failures.push(`${path.relative(root, file)}: Fixed-delay/fixed-rate application scheduling is not allowed; rearm a one-shot deadline from owner events.`);
  }
  if (/while\s+True\s*:\s*(?:#[^\n]*\n|\s)*await\s+asyncio\.sleep\s*\(/.test(source)) {
    failures.push(`${path.relative(root, file)}: Perpetual sleep loops are polling; wait on a queue/event or rearm a one-shot deadline.`);
  }
}

const controlledPollingExceptions = [
  {
    file: "apps/rabilink-android/app/src/main/java/com/rabi/link/RabiConversationService.java",
    pattern: /NETWORK_EVENT_FALLBACK_CHECK_MS = 5L \* 60L \* 1000L[\s\S]*postDelayed\(networkEventFallbackCheck, NETWORK_EVENT_FALLBACK_CHECK_MS\)/,
    reason: "Some Android vendors may miss a registered default-network callback. Only while already known offline, the foreground service checks OS connectivity every five minutes; it never queries Relay or business state and stops immediately after recovery."
  },
  {
    file: "plugin-adapters/rabi-speech/rabispeech/providers/dashscope.py",
    pattern: /DashScope meeting ASR poll[\s\S]*await asyncio\.sleep\(2\.0\)/,
    reason: "DashScope meeting transcription exposes a remote asynchronous job without a callback/webhook in this provider contract; polling is bounded by the request deadline."
  },
  {
    file: "apps/rabilink-android/scripts/Start-RabiLinkWearableCompanion.ps1",
    pattern: /while \(\$true\)[\s\S]*Start-Sleep -Seconds \$nextDelaySeconds/,
    reason: "The explicitly enabled Xiaomi Health ADB provider has no push/event API; its interval is user-configured and never below 60 seconds during normal collection."
  },
  {
    file: "apps/rabilink-aiui/pages/home/index.ink",
    pattern: /getRabiLinkMessageStream\(this\.config\(\), this\.data\.agentCursor, 25000\)/,
    reason: "Rokid AIUI QuickJS exposes whole-response HTTP only, without SSE, WebSocket, or streaming callbacks; the 25-second foreground wait stops when the page is hidden or leaves conversation mode."
  },
  {
    file: "apps/rabilink-aiui/pages/home/index.ink",
    pattern: /DEVICE_BATTERY_REFRESH_MS = 60000[\s\S]*refreshBatteryStatus\(\)/,
    reason: "Rokid AIUI has no verified glasses-battery change event; fresh phone-side CXR state is refreshed only while visible at a 60-second minimum interval."
  }
];

const activeExceptions = [];
for (const exception of controlledPollingExceptions) {
  const absolute = path.join(root, exception.file);
  if (!fs.existsSync(absolute)) continue;
  if (exception.pattern.test(fs.readFileSync(absolute, "utf8"))) {
    activeExceptions.push(`${exception.file}: ${exception.reason}`);
  }
}

if (failures.length) {
  console.error(["Event-driven architecture check failed:", ...failures.map(item => `- ${item}`)].join("\n"));
  process.exit(1);
}

console.log("Event-driven architecture check OK: runtime application paths use events, blocking queues, or one-shot deadlines.");
if (activeExceptions.length) {
  console.log(["Controlled polling exceptions:", ...activeExceptions.map(item => `- ${item}`)].join("\n"));
}
