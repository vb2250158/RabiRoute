import test from "node:test";
import assert from "node:assert/strict";
import {
  codexThreadItems,
  comboboxValueText,
  selectCodexThread
} from "./shared/codexThreadSelection.js";

test("Codex thread items preserve real thread ids and updated times", () => {
  const items = codexThreadItems([
    {
      id: "019f64e2-c3c3-7a72-bba1-ac777fcf6ee2",
      title: "路由优化",
      updatedAt: "2026-07-16T02:46:59.000Z"
    }
  ]);

  assert.equal(items[0].value, "019f64e2-c3c3-7a72-bba1-ac777fcf6ee2");
  assert.match(items[0].title, /^路由优化 · /);
  assert.doesNotMatch(items[0].title, /时间未知/);
});

test("Codex combobox object values do not become [object Object]", () => {
  const threads = [
    {
      id: "019f64e2-c3c3-7a72-bba1-ac777fcf6ee2",
      title: "路由优化",
      updatedAt: "2026-07-16T02:46:59.000Z"
    }
  ];

  assert.equal(comboboxValueText({ title: "路由优化", value: threads[0].id }), threads[0].id);
  assert.equal(comboboxValueText({ title: "bad" }), "bad");
  assert.equal(comboboxValueText({ value: {} }), "");
  assert.equal(comboboxValueText("[object Object]"), "");

  assert.deepEqual(selectCodexThread({ title: "路由优化", value: threads[0].id }, threads), {
    threadId: threads[0].id,
    threadName: "路由优化",
    selected: threads[0]
  });
});
