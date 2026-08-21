import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Windows launcher compares sources with the completed backend output, not early manager.js", () => {
  const source = fs.readFileSync(new URL("../Start-RabiRoute-Desktop.bat", import.meta.url), "utf8");
  assert.match(source, /Get-ChildItem -LiteralPath \$distRoot -Recurse -File -Include \*\.js/);
  assert.match(source, /Sort-Object LastWriteTimeUtc -Descending/);
  assert.match(source, /\$distTime = if \(\$latestDist\)/);
  assert.doesNotMatch(source, /\$distTime = \(Get-Item \$DistManager\)\.LastWriteTimeUtc\s*\r?\n\s*\$sourceRoots/);
});
