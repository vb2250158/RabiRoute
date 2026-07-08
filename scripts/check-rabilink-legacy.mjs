import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const checks = [
  {
    file: "src/config.ts",
    forbidden: [
      [/process\.env\.RABILINK_RELAY_TOKEN/, "runtime config must read RABILINK_RELAY_APP_TOKEN, not the legacy relay token name."],
      [/rabiLinkRelayToken:/, "runtime config property should be named rabiLinkRelayAppToken."],
    ],
    required: [
      [/process\.env\.RABILINK_RELAY_APP_TOKEN/, "runtime config should read RABILINK_RELAY_APP_TOKEN."],
      [/rabiLinkRelayAppToken:/, "runtime config should expose the application token as rabiLinkRelayAppToken."],
    ],
  },
  {
    file: "src/manager/controlPlaneRoutes.ts",
    forbidden: [
      [/RABILINK_RELAY_TOKEN/, "gateway child env must not emit the legacy relay token variable."],
      [/legacy-route/, "runtime status should call route-level migration fallback route-fallback, not legacy-route."],
      [/firstLegacyRabiLinkRelayConfig/, "route-level migration fallback should not be named legacy."],
      [/url\.pathname\.startsWith\(["']\/admin\/api\//, "server control APIs should only live under /manage/api."],
      [/url\.pathname\s*===\s*["']\/admin["']/, "server control UI should only live under /manage."],
    ],
    required: [
      [/RABILINK_RELAY_APP_TOKEN/, "gateway child env should emit RABILINK_RELAY_APP_TOKEN."],
    ],
  },
  {
    file: "scripts/rabilink-relay-server.mjs",
    forbidden: [
      [/const\s+legacyToken\b/, "relay server must not configure a legacy public token."],
      [/RABILINK_RELAY_TOKEN/, "relay server must not read the legacy public token environment variable."],
      [/url\.pathname\.startsWith\(["']\/admin\/api\//, "relay server APIs should only live under /manage/api."],
      [/url\.pathname\s*===\s*["']\/admin["']/, "relay server UI should only live under /manage."],
      [/自动选择可用 Rabi PC/, "control console should not offer automatic PC selection."],
      [/自动选择（暂无已绑定 PC）/, "control console should not offer automatic PC selection when no PC is bound."],
      [/workers\.find\(\(worker\)\s*=>\s*worker\.online\)\s*\|\|\s*workers\[0\]/, "mobile/WebGUI target selection must not fall back to the first PC."],
    ],
  },
  {
    file: "scripts/deploy-rabilink-relay-windows.ps1",
    forbidden: [
      [/\[string\]\$Token\b/, "deploy script must not accept a legacy server token parameter."],
      [/\$legacyTokenBootstrap\b/, "deploy script must not bootstrap a legacy server token."],
      [/handle \/admin\*/, "deployed Caddyfile should not expose the old /admin route."],
    ],
    required: [
      [/Remove-Item Env:RABILINK_RELAY_TOKEN/, "deploy script should clear stale legacy token env from the remote session."],
    ],
  },
  {
    file: "scripts/Test-RabiLinkRelayPublic.ps1",
    forbidden: [
      [/\$env:RABILINK_RELAY_TOKEN/, "public smoke test must not fall back to the legacy token env var."],
    ],
    required: [
      [/\$env:RABILINK_RELAY_APP_TOKEN/, "public smoke test should use the app token env var."],
    ],
  },
  {
    file: "scripts/Test-RabiLinkRelayWorker.ps1",
    forbidden: [
      [/\$env:RABILINK_RELAY_TOKEN/, "worker smoke test must not fall back to the legacy token env var."],
    ],
    required: [
      [/\$env:RABILINK_RELAY_APP_TOKEN/, "worker smoke test should use the app token env var."],
    ],
  },
];

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const failures = [];

for (const check of checks) {
  const text = readText(check.file);
  for (const [pattern, message] of check.forbidden || []) {
    if (pattern.test(text)) {
      failures.push(`${check.file}: forbidden pattern ${pattern}: ${message}`);
    }
  }
  for (const [pattern, message] of check.required || []) {
    if (!pattern.test(text)) {
      failures.push(`${check.file}: missing pattern ${pattern}: ${message}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[fail] ${failure}`);
  }
  process.exit(1);
}

for (const check of checks) {
  console.log(`[ok] ${check.file}`);
}
