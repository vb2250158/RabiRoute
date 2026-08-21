import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");

test("bound Codex and DSH primary sessions show Locate session instead of initialization", () => {
  assert.match(source, /function hasManagedAgentSessionBinding\(type: "codex" \| "dsh"\)/);
  assert.match(source, /action: "open",[\s\S]*agentAdapter: session\.agentAdapter,[\s\S]*threadId: session\.sessionId,[\s\S]*cwd: session\.workspace/);

  for (const adapter of ["codex", "dsh"]) {
    const marker = "v-if=\"hasManagedAgentSessionBinding('" + adapter + "')\"";
    const start = source.indexOf(marker);
    const end = source.indexOf("</div>", start);
    const block = source.slice(start, end);
    assert.ok(start >= 0);
    assert.match(block, /定位会话/);
    assert.match(block, /v-else[\s\S]*自动初始化会话/);
    assert.match(block, new RegExp("openManagedAgentSession\\('" + adapter + "'\\)"));
    assert.match(block, new RegExp("initializeManagedAgentSession\\('" + adapter + "'\\)"));
  }
});
