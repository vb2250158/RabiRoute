import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const selfFile = "scripts/check-rabilink-legacy.mjs";

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
    required: [
      [/const accountLogDir = path\.join\(dataDir, "account-logs"\)/, "relay server should keep control-console logs in the per-account log directory."],
      [/function accountLogPath\(accountId\)[\s\S]*?return path\.join\(accountLogDir, `\$\{id\}\.jsonl`\);/, "relay server should derive log files from the current account id."],
      [/const apps = account\s*\? store\.apps\.filter\(\(app\) => app\.ownerAccountId === account\.id\)\s*: \[\];/, "control-console state must only expose apps owned by the current account."],
      [/const workers = store\.workers\.filter\(\(worker\) => appsById\.has\(worker\.appId\)\);/, "control-console state must only expose workers attached to the current account's apps."],
      [/logs: account \? readAccountLogs\(account, options\.logLimit \|\| 80\) : \[\]/, "control-console state must only include logs for the current account."],
      [/ownerAccountId: account\.id/, "new RabiLink apps must be owned by the current account."],
      [/store\.apps\.find\(\(item\) => item\.id === appId && item\.ownerAccountId === account\.id\)/, "patching an app must require current-account ownership."],
      [/store\.apps\.findIndex\(\(item\) => item\.id === appId && item\.ownerAccountId === account\.id\)/, "deleting an app must require current-account ownership."],
      [/const ownedApps = store\.apps\.filter\(\(app\) => app\.ownerAccountId === account\.id && app\.enabled !== false\);/, "remote PC WebGUI target resolution must only use apps owned by the current account."],
      [/logs: readAccountLogs\(auth\.account, url\.searchParams\.get\("limit"\) \|\| 120\)/, "logs API must read only the authenticated account's log file."],
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
  {
    file: "docs/rabilink-relay-server.md",
    required: [
      [/服务器会按应用隔离 task、worker 领取、WebGUI 请求和下行消息队列/, "Relay docs should state that runtime queues are isolated by app token."],
      [/日志按账号分离，落在：[\s\S]*data\/rabilink-relay\/account-logs\/<accountId>\.jsonl/, "Relay docs should document per-account control-console logs."],
      [/控制台只读取当前登录账号自己的日志，不混看其他账号/, "Relay docs should explicitly state that console logs are account-isolated."],
      [/账号拥有应用，应用拥有应用 token，PC Rabi worker、任务队列、远程 WebGUI 请求和控制台日志都只能通过所属应用归到这个账号/, "Relay docs should define the account -> app -> token/worker/task/log ownership boundary."],
    ],
  },
  {
    file: "docs/mobile-app-webhook-integration.md",
    required: [
      [/手机 App 远程接入 RabiRoute 历史方案/, "old mobile webhook document should be clearly marked historical."],
      [/当前真源：Rokid\/灵珠公网主链路和手机端 RabiLink 绑定流程见 `docs\/rabilink-relay-server\.md`/, "old mobile webhook document should point to the current Relay source of truth."],
      [/不要把这里的 `rabi\.example\.com`、`\/webhook`、`\/api\/mobile\/\*` 或手机桥 outbox 当作当前 RabiLink 主链路/, "old mobile webhook document should explicitly reject the old path as current RabiLink."],
    ],
  },
  {
    file: "docs/README.md",
    required: [
      [/\[RabiLink Relay 公网中继\]\(rabilink-relay-server\.md\).*当前 Rokid\/灵珠和手机端 RabiLink 主链路/s, "docs index should put the current RabiLink Relay document in front."],
      [/\[手机 App 远程接入历史方案\]\(mobile-app-webhook-integration\.md\).*仅作历史参考/s, "docs index should mark the old mobile document as historical."],
    ],
  },
  {
    file: "docs/project-function-map.md",
    forbidden: [
      [/\| RabiLink 直连 \|/, "project function map should not present the local /rabilink endpoint as the current public direct path."],
      [/RabiLink \/ Relay \/ Rokid：看 RabiLink 直连/, "project function map search guide should not point to the old direct name."],
    ],
    required: [
      [/\| RabiLink 本地兼容入口 \|/, "project function map should name /rabilink as a local compatibility endpoint."],
      [/公网主链路走 Relay worker/, "project function map should state that the public RabiLink path goes through the Relay worker."],
    ],
  },
  {
    file: "ribiwebgui/src/components/QuickSetupDialog.vue",
    forbidden: [
      [/docs\/mobile-app-webhook-integration\.md/, "RabiLink quick setup help must not send users to the old mobile webhook document."],
    ],
    required: [
      [/docs\/rabilink-relay-server\.md/, "RabiLink quick setup help should point to the current Relay document."],
      [/全局 RabiLink 配置里填写公网 Relay 地址和应用 token/, "RabiLink quick setup copy should refer to global config and app token."],
    ],
  },
  {
    file: "ribiwebgui/src/pages/ProjectDocsPage.vue",
    forbidden: [
      [/docs: \["docs\/mobile-app-webhook-integration\.md", "docs\/rabilink-relay-server\.md"\]/, "RabiLink docs page should not prioritize the old mobile webhook document."],
    ],
    required: [
      [/docs: \["docs\/rabilink-relay-server\.md", "docs\/rabilink-relay-cloudflare-worker\.md", "docs\/mobile-app-webhook-integration\.md"\]/, "RabiLink docs page should prioritize current Relay docs, with old mobile docs last."],
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

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function collectFiles(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) return [];
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) return [normalizePath(relativePath)];
  const result = [];
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const childPath = normalizePath(path.join(relativePath, entry.name));
    if (entry.isDirectory()) {
      result.push(...collectFiles(childPath));
    } else if (entry.isFile() && !entry.name.endsWith(".jsonl")) {
      result.push(childPath);
    }
  }
  return result;
}

function isAllowed(file, allowList = []) {
  return allowList.some((item) => {
    if (typeof item === "string") return item === file;
    return item.test(file);
  });
}

function firstMatchLine(text, pattern) {
  const match = pattern.exec(text);
  if (!match) return 0;
  return text.slice(0, match.index).split(/\r?\n/).length;
}

const globalScanFiles = [
  "README.md",
  ...collectFiles("src"),
  ...collectFiles("scripts"),
  ...collectFiles("docs"),
  ...collectFiles("ribiwebgui/src"),
  ...collectFiles("examples/rabilink-relay"),
].filter((file, index, files) => files.indexOf(file) === index);

const globalForbidden = [
  {
    pattern: /process\.env\.RABILINK_RELAY_TOKEN/,
    message: "runtime code must not read the legacy public Relay token env var.",
    allow: [selfFile],
  },
  {
    pattern: /\bRABILINK_RELAY_TOKEN\b/,
    message: "current code/docs must not reintroduce the legacy public Relay token except as explicit cleanup or deprecated docs.",
    allow: [
      selfFile,
      "scripts/deploy-rabilink-relay-windows.ps1",
      "docs/rabilink-relay-server.md",
      "docs/rabilink-rokid-handoff-20260706.md",
    ],
  },
  {
    pattern: /\brabiLinkRelayToken\b/,
    message: "route-level rabiLinkRelayToken should only remain in migration compatibility code and docs.",
    allow: [
      selfFile,
      "docs/configuration.md",
      "src/manager/controlPlaneRoutes.ts",
      "src/manager/configRepository.ts",
      "src/shared/gatewayConfigModel.ts",
    ],
  },
  {
    pattern: /\/api\/mobile\//,
    message: "old mobile bridge API paths must not be current RabiLink implementation paths.",
    allow: [selfFile, "docs/mobile-app-webhook-integration.md"],
  },
  {
    pattern: /\/admin\b|\/admin\*/,
    message: "old Relay admin route must not return as a current route or deploy target.",
    allow: [selfFile, "docs/rabilink-rokid-handoff-20260706.md"],
  },
  {
    pattern: /phone\/tasks/,
    message: "old phone task bridge path must not return.",
    allow: [selfFile],
  },
  {
    pattern: /RabiLink 直连/,
    message: "current docs should not name the local compatibility endpoint as RabiLink direct connection.",
    allow: [selfFile],
  },
  {
    pattern: /自动选择可用 Rabi PC|自动选择（暂无已绑定 PC）/,
    message: "control surfaces must not offer automatic first-PC selection.",
    allow: [selfFile],
  },
  {
    pattern: /workers\.find\(\(worker\)\s*=>\s*worker\.online\)\s*\|\|\s*workers\[0\]/,
    message: "target selection must not fall back to the first online worker.",
    allow: [selfFile],
  },
  {
    pattern: /firstLegacyRabiLinkRelayConfig/,
    message: "migration fallback must not use legacy naming.",
    allow: [selfFile],
  },
  {
    pattern: /["']legacy-route["']/,
    message: "runtime status should not use legacy-route naming.",
    allow: [selfFile],
  },
  {
    pattern: /const\s+legacyToken\b/,
    message: "Relay server must not configure a legacy public token.",
    allow: [selfFile],
  },
];

for (const file of globalScanFiles) {
  const text = readText(file);
  for (const rule of globalForbidden) {
    rule.pattern.lastIndex = 0;
    if (!rule.pattern.test(text) || isAllowed(file, rule.allow)) continue;
    failures.push(`${file}:${firstMatchLine(text, rule.pattern)}: global forbidden pattern ${rule.pattern}: ${rule.message}`);
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
console.log(`[ok] global RabiLink legacy scan (${globalScanFiles.length} files)`);
