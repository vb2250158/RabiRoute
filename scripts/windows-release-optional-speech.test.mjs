import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const releaseScript = fs.readFileSync(
  new URL("./build-windows-release.ps1", import.meta.url),
  "utf8"
);
const releaseWorkflow = fs.readFileSync(
  new URL("../.github/workflows/release-windows.yml", import.meta.url),
  "utf8"
);

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
