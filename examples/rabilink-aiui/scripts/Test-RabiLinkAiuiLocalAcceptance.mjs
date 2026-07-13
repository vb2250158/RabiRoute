import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");
const reportPath = path.join(projectRoot, "dist", "local-acceptance.json");
const aixPath = path.join(projectRoot, "dist", "rabilink-aiui.aix");
const realDeviceStatusEvidencePath = path.join(projectRoot, "dist", "real-glasses-device-status.json");
const aiuiDeviceStatusE2ePath = path.join(projectRoot, "dist", "device-status-e2e.json");

const checks = [
  {
    id: "static-contracts",
    requirement: "Dual-mode state machine, assistant HUD, Relay API and WebGUI coverage remain internally consistent.",
    command: process.execPath,
    args: [
      path.join(projectRoot, "scripts", "check-rabilink-aiui.mjs"),
      "--acceptance"
    ],
    cwd: projectRoot
  },
  {
    id: "webgui-coverage",
    requirement: "Every PC Rabi WebGUI endpoint and structured configuration action exposed by the project is covered.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Audit-WebguiCoverage.mjs")],
    cwd: projectRoot
  },
  {
    id: "webgui-actions",
    requirement: "Gateway fields and structured action groups retain complete assistant-callable implementations.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Audit-WebguiConfigSurface.mjs")],
    cwd: projectRoot
  },
  {
    id: "ar-hud-design",
    requirement: "Both modes use one bottom-up two-position rail, borderless secondary actions, lower-corner time/battery status, and no old manual dashboard.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Audit-AiuiDesign.mjs")],
    cwd: projectRoot
  },
  {
    id: "rokid-device-status-bridge",
    requirement: "Phone CXR status binding does not open a display session, Relay authenticates and persists status, and AIUI rejects stale values.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Audit-RokidDeviceStatusBridge.mjs")],
    cwd: projectRoot
  },
  {
    id: "api-contract",
    requirement: "Connection input uses event acknowledgement while one cursor stream carries normal and proactive messages without glasses-side task state.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkApiContract.mjs")],
    cwd: projectRoot
  },
  {
    id: "relay-mobile-proxy",
    requirement: "Relay authenticates, binds a PC worker, wakes a waiting stream with taskless proactive delivery, and proxies WebGUI requests.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkRelayMobileWebgui.mjs")],
    cwd: projectRoot
  },
  {
    id: "relay-device-status",
    requirement: "Relay device status covers auth, validation, charging=true, persistence and stale-state marking.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkRelayDeviceStatus.mjs")],
    cwd: projectRoot
  },
  {
    id: "page-runtime",
    requirement: "Touchpad rail switching, native-Agent configuration, ASR/TTS handoff, clock, battery adapters, 85 commands/283 phrases and 20 mode round trips work.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiRuntime.mjs")],
    cwd: projectRoot
  },
  {
    id: "delivery-ink",
    requirement: "The actual delivered AIX renders both compact and immersive HUDs and survives 20 same-page round trips.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiInkRuntime.mjs"), "--aix", aixPath],
    cwd: projectRoot
  },
  {
    id: "ink-battery-render",
    requirement: "Compact and immersive HUDs render a numeric battery value and charging mark in both rail modes.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiInkRuntime.mjs")],
    cwd: projectRoot,
    env: {
      RABILINK_AIUI_INK_BATTERY_LEVEL: "97",
      RABILINK_AIUI_INK_BATTERY_CHARGING: "true"
    }
  },
  ...["transcription", "configuration"].flatMap((mode) => ([
    {
      id: `ink-013-resize-${mode}`,
      requirement: `Ink 0.13 card-to-immersive resize and 20 mode round trips pass from ${mode}.`,
      command: process.execPath,
      args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiInteractiveResize.mjs"), "--mode", mode],
      cwd: projectRoot
    },
    {
      id: `ink-014-resize-${mode}`,
      requirement: `Ink 0.14 card-to-immersive resize and 20 mode round trips pass from ${mode}.`,
      command: process.execPath,
      args: [
        path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiInteractiveResize.mjs"),
        "--ink-package",
        "@yodaos-pkg/ink-daily",
        "--mode",
        mode
      ],
      cwd: projectRoot
    }
  ])),
  {
    id: "startup-soak",
    requirement: "Preview never seizes ASR and repeated recognition failures stop at the bounded retry limit without freezing.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Smoke-RabiLinkAiuiStartupSafety.mjs"), "--soak"],
    cwd: projectRoot
  },
  {
    id: "delivery-aix",
    requirement: "The delivered AIX is current, contains one dual-mode page and has no old manual dashboard or token editor.",
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "Audit-RabiLinkAiuiAix.mjs"), "--aix", aixPath],
    cwd: projectRoot
  },
  {
    id: "relay-shared-state",
    requirement: "Internal worker leases remain shared across Relay processes while the glasses consume only the application-level message stream.",
    command: "powershell",
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repoRoot, "scripts", "Test-RabiLinkRelaySharedState.ps1")
    ],
    cwd: repoRoot
  }
];

function runCheck(check) {
  const startedAt = Date.now();
  const result = spawnSync(check.command, check.args, {
    cwd: check.cwd,
    encoding: "utf8",
    env: { ...process.env, ...(check.env || {}) },
    timeout: 180000,
    windowsHide: true
  });
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    id: check.id,
    requirement: check.requirement,
    status: result.status === 0 && !result.error ? "passed" : "failed",
    duration_ms: Date.now() - startedAt,
    exit_code: result.status,
    error: result.error?.message || "",
    output: output.slice(-8000)
  };
}

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
const results = [];
for (const check of checks) {
  const result = runCheck(check);
  results.push(result);
  console.log(`[${result.status === "passed" ? "OK" : "FAIL"}] ${result.id} (${result.duration_ms}ms)`);
  if (result.status !== "passed") break;
}

const localComplete = results.length === checks.length && results.every((result) => result.status === "passed");
const realDeviceEvidence = fs.existsSync(realDeviceStatusEvidencePath)
  ? JSON.parse(fs.readFileSync(realDeviceStatusEvidencePath, "utf8"))
  : null;
const aiuiDeviceE2e = fs.existsSync(aiuiDeviceStatusE2ePath)
  ? JSON.parse(fs.readFileSync(aiuiDeviceStatusE2ePath, "utf8"))
  : null;
const realDeviceStatusComplete = realDeviceEvidence?.ok === true
  && realDeviceEvidence?.source === "rokid-cxr-phone"
  && aiuiDeviceE2e?.ok === true
  && aiuiDeviceE2e?.source === "relay-cxr";
const report = {
  generated_at: new Date().toISOString(),
  objective: "RabiLink AIUI provides Connection Conversation and Native-Agent Configuration modes, a continuous normal/proactive message stream, native TTS/ASR handoff, and truthful AR HUD status with all local functions tested.",
  local_acceptance_complete: localComplete,
  glasses_acceptance_complete: false,
  glasses_device_status_acceptance_complete: realDeviceStatusComplete,
  glasses_gap: "Real glasses battery/charging reached Relay and the compiled AIUI page, but the newly built AIX still needs a post-upload launch on the glasses.",
  aix_path: aixPath,
  real_device_status_evidence_path: realDeviceStatusEvidencePath,
  aiui_device_status_e2e_path: aiuiDeviceStatusE2ePath,
  checks: results
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (!localComplete) {
  const failed = results.find((result) => result.status === "failed");
  throw new Error(`Local acceptance failed at ${failed?.id || "unknown"}: ${failed?.error || failed?.output || "unknown error"}`);
}

console.log(`RabiLink AIUI local acceptance passed (${results.length} requirement checks).`);
console.log(`Report: ${reportPath}`);
