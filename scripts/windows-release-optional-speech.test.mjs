import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const releaseScript = fs.readFileSync(
  new URL("./build-windows-release.ps1", import.meta.url),
  "utf8"
);
const releaseWorkflow = fs.readFileSync(
  new URL("../.github/workflows/release-windows.yml", import.meta.url),
  "utf8"
);

test("Windows workflow shares the explicit local artifact root and builds before isolated test gates", () => {
  assert.match(releaseWorkflow, /RABIROUTE_RELEASE_OUTPUT: \$\{\{ runner\.temp \}\}\/rabiroute-windows-release/);
  assert.match(releaseWorkflow, /build-windows-release\.ps1[^\r\n]*-OutputRoot \$env:RABIROUTE_RELEASE_OUTPUT/);
  for (const file of ["*.exe", "*.zip", "SHA256SUMS.txt"]) {
    assert.ok(releaseWorkflow.includes("${{ env.RABIROUTE_RELEASE_OUTPUT }}/" + file));
  }
  assert.match(releaseWorkflow, /Get-ChildItem -LiteralPath \$env:RABIROUTE_RELEASE_OUTPUT -File/);
  assert.doesNotMatch(releaseWorkflow, /output\/windows/);
  const commands = [...releaseWorkflow.matchAll(/^\s+run: (npm[^\r\n]+)$/gm)].map(match => match[1]);
  assert.deepEqual(commands, ["npm ci", "npm run build", "npm test", "npm run check:config"]);
});

test("Windows release excludes the RabiSpeech runtime unless explicitly requested", () => {
  assert.match(releaseScript, /\[switch\]\$IncludeSpeech/);
  assert.match(releaseScript, /if \(\$IncludeSpeech -and -not \$SkipBuild\)/);
  assert.match(releaseScript, /if \(\$IncludeSpeech\) \{ \$required \+= \$speechHostRelative \}/);
  assert.match(releaseScript, /if \(\$IncludeSpeech\) \{\s*\$speechHostDestination/s);
  assert.doesNotMatch(
    releaseWorkflow,
    /build-windows-release\.ps1[^\r\n]*-IncludeSpeech/,
    "the public release workflow should keep speech opt-in"
  );
});

test("Windows release explicitly includes required discovery and Agent transport modules", () => {
  const allowlist = releaseScript.match(
    /\$requiredPortableRuntimeFiles\s*=\s*@\(([\s\S]*?)\r?\n\)/
  );
  assert.ok(allowlist, "required portable runtime allowlist must exist");
  assert.deepEqual(
    [...allowlist[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [
      "scripts/Resolve-RabiRouteManagerUrl.ps1",
      "scripts/lib/discover-manager-url.mjs",
      "apps/rabi-agent/lib/manager-client.mjs",
      "apps/rabi-agent/lib/manager-cli.mjs",
      "packages/rabi-knowledge-contract/schema.mjs",
      "packages/rabi-knowledge-contract/tools.mjs",
      "packages/rabi-knowledge-contract/receipt.mjs",
      "apps/rabi-mcp/lib/knowledge-tools.mjs",
      "apps/rabi-mcp/lib/knowledge-receipt.mjs",
      "scripts/lib/release-tracked-manifest.ps1",
      "scripts/rabilink-relay-runtime-files.json",
      "docs/aiui-agent-profile-http.md",
      "docs/aiui-agent-profile-http_en.md",
      "docs/rabilink-knowledge-operation-receipts.md",
      "docs/rabilink-knowledge-operation-receipts_en.md",
      "docs/knowledge-grant-phone-ui.md",
      "docs/knowledge-grant-phone-ui_en.md",
    ]
  );
  assert.match(
    releaseScript,
    /function Copy-RequiredPortableRuntimeFiles[\s\S]*Required portable runtime file is missing:[\s\S]*Copy-Item[\s\S]*Required portable runtime file was not copied:/
  );
  assert.match(
    releaseScript,
    /Copy-RequiredPortableRuntimeFiles\s*\r?\n\s*foreach \(\$relative in @\("apps\\rabi-agent\\runtime", "apps\\rabi-agent\\dist\\agent-hooks"\)\)[\s\S]*?if \(\$IncludeSpeech\)/
  );
});

test("Windows PowerShell 5.1 can parse every release path without a source-code code page", () => {
  assert.doesNotMatch(
    releaseScript,
    /[^\x00-\x7f]/,
    "the release script must remain ASCII-only because Windows PowerShell 5.1 does not assume UTF-8 without a BOM"
  );
  assert.match(releaseScript, /\[char\]0x7248/);
  assert.match(releaseScript, /\$versionLogBaseName \+ "_en\.md"/);
});

test("tracked release manifests accept only the stable knowledge runtime files", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-knowledge-manifest-"));
  const helper = fileURLToPath(new URL("./lib/release-tracked-manifest.ps1", import.meta.url));
  const manifestFile = path.join(root, "tracked.json");
  const known = [
    "packages/rabi-knowledge-contract/schema.mjs",
    "packages/rabi-knowledge-contract/tools.mjs",
    "packages/rabi-knowledge-contract/receipt.mjs",
    "apps/rabi-mcp/lib/knowledge-tools.mjs",
    "apps/rabi-mcp/lib/knowledge-receipt.mjs"
  ];
  const entry = relative => {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "export const fixture = true;\n");
    return { path: relative, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  };
  const run = entries => {
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, files: entries }));
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference='Stop'; . ${quote(helper)}; $manifestEntries = Read-ReleaseTrackedManifest ${quote(manifestFile)} ${quote(root)}; if ($manifestEntries.Count -ne ${entries.length}) { throw 'Unexpected entry count' }`], { encoding: "utf8" });
  };
  try {
    const accepted = known.map(entry);
    const result = run(accepted);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const denied of ["packages/unknown-owner/schema.mjs", "packages/rabi-knowledge-contract/private.mjs", "apps/rabi-mcp/lib/knowledge-http-client.mjs"]) {
      const rejected = run([entry(denied)]);
      assert.notEqual(rejected.status, 0, denied);
      assert.match(rejected.stderr + rejected.stdout, /Unsafe or duplicate tracked path/);
    }
    const mismatch = run([{ ...accepted[0], sha256: "0".repeat(64) }]);
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr + mismatch.stdout, /Tracked hash mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows PowerShell 5.1 removes a payload junction without deleting its target", {
  skip: process.platform !== "win32",
}, () => {
  assert.match(
    releaseScript,
    /function Remove-PayloadEntry[\s\S]*Refusing to remove a path outside the release payload:[\s\S]*\$item\.Delete\(\)[\s\S]*Release payload entry was not removed:/
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-payload-junction-test-"));
  const target = path.join(root, "target");
  const sentinel = path.join(target, "sentinel");
  const link = path.join(root, "link");
  try {
    fs.mkdirSync(sentinel, { recursive: true });
    fs.symlinkSync(target, link, "junction");
    const escapedLink = link.replaceAll("'", "''");
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$item=Get-Item -LiteralPath '${escapedLink}' -Force; $item.Delete()`,
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(sentinel), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
