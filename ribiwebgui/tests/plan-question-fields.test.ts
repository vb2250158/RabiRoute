import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse, compileScript } from "@vue/compiler-sfc";

const root = path.resolve(import.meta.dirname, "..");
const fields = fs.readFileSync(path.join(root, "src/components/PlanQuestionFields.vue"), "utf8");
const details = fs.readFileSync(path.join(root, "src/components/PlanImplementationDetails.vue"), "utf8");

test("每题和每个方案复用实施明细组件，展开控件不嵌入选择标签", () => {
  assert.match(fields, /q\.implementation/);
  assert.match(fields, /o\.implementation/);
  assert.doesNotMatch(fields, /<label[^>]*>[\s\S]*?<PlanImplementationDetails[\s\S]*?<\/label>/);
  assert.match(details, /<details class="plan-implementation">/);
  assert.doesNotMatch(details, /<details[^>]*\sopen/);
  assert.match(details, /implementation\.changes/);
  assert.match(fields, /selectionMode === 'multiple' \? 'checkbox' : 'radio'/);
  assert.match(fields, /needsText\(q\)/);
});

test("审批题目及明细组件能够编译，实施明细变化会重建折叠状态", () => {
  for (const [filename, source] of [["PlanQuestionFields.vue", fields], ["PlanImplementationDetails.vue", details]]) {
    const { descriptor, errors } = parse(source, { filename });
    assert.deepEqual(errors, []);
    assert.doesNotThrow(() => compileScript(descriptor, { id: filename, inlineTemplate: true }));
  }
  assert.match(fields, /:key="JSON\.stringify\(o\.implementation\)"/);
  assert.match(fields, /:key="JSON\.stringify\(q\.implementation\)"/);
});
