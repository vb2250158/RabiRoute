import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const [raw, expected] of [["{", {}], ["[]", {}], ['{"plugin.good":321,"plugin.bad":0}', { "plugin.good": 321 }]] as const) {
  test(`kernel timeout environment preserves usable settings: ${raw}`, () => {
    const module = new URL("./runtimeTimeouts.ts", import.meta.url).href;
    const script = `const m=await import(${JSON.stringify(module)}); console.log(JSON.stringify(m.readTimeoutOverrides())); try {m.configureTimeouts({bad:0});process.exitCode=2;} catch {}`;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), windowsHide: true, encoding: "utf8", timeout: 15000,
      env: { ...process.env, RABIROUTE_TIMEOUT_OVERRIDES: raw }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
    assert.match(result.stderr, /RABIROUTE_TIMEOUT_OVERRIDES/);
  });
}
