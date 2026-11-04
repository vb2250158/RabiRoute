import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("bound Codex and DSH primary sessions show Locate session instead of initialization", () => {
  for (const [adapter, card] of [["codex", "Codex"], ["dsh", "Dsh"]]) {
    const source = fs.readFileSync(new URL(`../src/agentAdapters/${card}AgentCard.vue`, import.meta.url), "utf8");
    assert.match(source, /function hasManagedAgentSessionBinding\(type: "codex" \| "dsh"\)/);
    assert.match(source, /action: "open",[\s\S]*agentAdapter: session\.agentAdapter,[\s\S]*threadId: session\.sessionId,[\s\S]*cwd: session\.workspace/);
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
