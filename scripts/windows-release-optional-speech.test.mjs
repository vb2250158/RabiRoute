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
  assert.doesNotMatch(
    releaseWorkflow,
    /\n {4}env:\n {6}RABIROUTE_RELEASE_OUTPUT:\s*\$\{\{\s*runner\./,
    "runner context is invalid in job-level env and rejects the workflow before any job starts"
  );
  const outputAssignment = releaseWorkflow.indexOf(
    '"RABIROUTE_RELEASE_OUTPUT=${{ runner.temp }}/rabiroute-windows-release" >> $env:GITHUB_ENV'
  );
  const packageStep = releaseWorkflow.indexOf("-OutputRoot $env:RABIROUTE_RELEASE_OUTPUT");
  assert.ok(outputAssignment >= 0 && outputAssignment < packageStep);
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
      "packages/rabi-companion/presets.json",
      "packages/rabi-companion/scene-rules.json",
      "packages/rabi-companion/observation.json",
      "scripts/Resolve-RabiRouteManagerUrl.ps1",
      "scripts/resolve-manager.mjs",
      "scripts/upgrade-persona-message-config.mjs",
      "scripts/lib/discover-manager-url.mjs",
      "scripts/lib/windows-host-discovery.mjs",
      "apps/rabi-agent/lib/manager-client.mjs",
      "apps/rabi-agent/lib/manager-cli.mjs",
      "src/plugins/xiaoai-rabiroute/bridge-endpoint.mjs",
      "packages/rabi-knowledge-contract/schema.mjs",
      "packages/rabi-knowledge-contract/tools.mjs",
      "packages/rabi-knowledge-contract/receipt.mjs",
      "packages/rabi-api-contract/request.mjs",
      "packages/rabilink-agent-contract/profile.mjs",
      "packages/rabilink-agent-contract/state.mjs",
      "packages/rabilink-agent-contract/persona.mjs",
      "apps/rabi-mcp/lib/knowledge-tools.mjs",
      "apps/rabi-mcp/lib/knowledge-receipt.mjs",
      "scripts/lib/release-tracked-manifest.ps1",
      "scripts/lib/copy-installed-host.ps1",
      "scripts/lib/copy-agent-native-assets.ps1",
      "scripts/rabilink-relay-runtime-files.json",
      "scripts/lib/rabilink-relay-runtime-paths.ps1",
      "scripts/lib/rabilink-relay-runtime-paths.json",
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
    /Copy-RequiredPortableRuntimeFiles\s*\r?\n\s*\. \(Join-Path \$scriptDir 'lib\/copy-agent-native-assets\.ps1'\)\s*\r?\n\s*Copy-AgentNativeAssets[^\r\n]*\r?\n\s*foreach \(\$relative in @\("apps\\rabi-agent\\runtime", "apps\\rabi-agent\\dist\\agent-hooks"\)\)[\s\S]*?if \(\$IncludeSpeech\)/

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

test("tracked release manifests accept only the stable shared runtime contracts", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-knowledge-manifest-"));
  const helper = fileURLToPath(new URL("./lib/release-tracked-manifest.ps1", import.meta.url));
  const manifestFile = path.join(root, "tracked.json");
  const known = [
    "packages/rabi-knowledge-contract/schema.mjs",
    "packages/rabi-knowledge-contract/tools.mjs",
    "packages/rabi-knowledge-contract/receipt.mjs",
    "packages/rabi-api-contract/request.mjs",
    "packages/rabilink-agent-contract/profile.mjs",
    "packages/rabilink-agent-contract/state.mjs",
    "packages/rabilink-agent-contract/persona.mjs",
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
    const env = { ...process.env };
    // Windows PowerShell must initialize its own module path rather than inherit PowerShell 7 modules.
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$ErrorActionPreference='Stop'; . ${quote(helper)}; $manifestEntries = Read-ReleaseTrackedManifest ${quote(manifestFile)} ${quote(root)}; if ($manifestEntries.Count -ne ${entries.length}) { throw 'Unexpected entry count' }`], { encoding: "utf8", env });
  };
  try {
    const accepted = known.map(entry);
    const result = run(accepted);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const denied of ["packages/unknown-owner/schema.mjs", "packages/rabi-knowledge-contract/private.mjs", "packages/rabi-api-contract/private.mjs", "packages/rabilink-agent-contract/private.mjs", "apps/rabi-mcp/lib/knowledge-http-client.mjs"]) {
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

test("Windows PowerShell 5.1 copies runtime sources with zero, one and multiple development exclusions", { skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-source-ps5-regression-"));
  try {
    const write = (relative, contents) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); };
    write("plugins/contracts/plugin-sdk/public-source.mjs", fs.readFileSync(new URL("../plugins/contracts/plugin-sdk/public-source.mjs", import.meta.url)));
    const blocked = ["src/plugins/io.fixture/src/relay.test.ts", "plugins/contracts/plugin-sdk/builder.test.mjs", "src/plugins/io.fixture/tests/证据.ts"];
    const preserved = ["src/plugins/io.fixture/src/auth/authorize.ts", "src/plugins/io.fixture/catalog.json", "scripts/test-rabispeech-tts-loop.mjs"];
    for (const relative of [...blocked, ...preserved]) write(relative, "public fixture " + relative);
    for (const count of [0, 1, 3]) write("manifest-" + count + ".json", JSON.stringify({ version: 1, files: [...blocked.slice(0, count), ...preserved].map(relative => ({ path: relative, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex") })) }));
    const program = "param([string]$Release,[string]$Helper,[string]$Fixture,[string]$Result)\n$ErrorActionPreference='Stop'\n. $Helper\n$text=Get-Content -LiteralPath $Release -Raw -Encoding UTF8\n$start=$text.IndexOf('# Runtime selection is owned')\n$end=$text.IndexOf('function Copy-TrackedTree')\nif($start -lt 0 -or $end -le $start){throw 'Actual runtime selection block missing'}\n$selection=$text.Substring($start,$end-$start)\n$tokens=$null;$errors=$null\n$ast=[Management.Automation.Language.Parser]::ParseFile($Release,[ref]$tokens,[ref]$errors)\nif($errors.Count){throw ($errors|Out-String)}\n$copy=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Copy-TrackedTree'},$true)\n$counts=@()\nforeach($count in @(0,1,3)){\n  $repo=$Fixture\n  $TrackedFilesManifest=Join-Path $Fixture ('manifest-'+$count+'.json')\n  $trackedManifestEntries=Read-ReleaseTrackedManifest $TrackedFilesManifest $repo\n  $payload=Join-Path $Fixture ('payload-'+$count)\n  $null=New-Item -ItemType Directory -Path $payload\n  $excludedRuntimeFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)\n  . ([ScriptBlock]::Create($selection))\n  . ([ScriptBlock]::Create($copy.Extent.Text))\n  foreach($tree in @('src/plugins','plugins','scripts')){Copy-TrackedTree $tree}\n  if($runtimeSourceExclusions.Count -ne $count){throw ('Wrong exclusion array count: '+$count)}\n  foreach($entry in $trackedManifestEntries){\n    $destination=Join-Path $payload $entry.path\n    if($entry.path -match '\\.test\\.ts$|builder\\.test\\.mjs$|/tests/'){\n      if(Test-Path -LiteralPath $destination){throw ('Development test entered runtime payload: '+$entry.path)}\n    }else{\n      if(!(Test-Path -LiteralPath $destination -PathType Leaf)){throw ('Public runtime source disappeared: '+$entry.path)}\n      if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $entry.sha256){throw 'Public runtime source bytes changed'}\n    }\n  }\n  $counts+=$runtimeSourceExclusions.Count\n}\n[IO.File]::WriteAllText($Result,(($counts|ConvertTo-Json)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))\n";
    const probe = path.join(root, "copy.ps1"), resultFile = path.join(root, "copy-result.json");
    fs.writeFileSync(probe, program, "utf8");
    const shell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe,
      "-Release", fileURLToPath(new URL("./build-windows-release.ps1", import.meta.url)),
      "-Helper", fileURLToPath(new URL("./lib/release-tracked-manifest.ps1", import.meta.url)), "-Fixture", root, "-Result", resultFile],
    { encoding: "utf8", windowsHide: true, env: Object.fromEntries(Object.entries({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, "utf8")), [0, 1, 3]);
  } finally { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); }
});
