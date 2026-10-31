import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPlan, getPlan, updatePlan } from "./roleKnowledge.js";
import { planAttachmentDirectory, planJsonFile } from "./planStorageLayout.js";

for (const archive of [false, true]) {
  for (const legacyLayout of [false, true]) {
  test(`retaining attachments after moving the role root${legacyLayout ? " with legacy paths" : ""}${archive ? " while archiving" : ""} preserves their bytes and identity`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-root-relocation-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const original = path.join(root, "original");
    const relocated = path.join(root, "relocated");
    fs.mkdirSync(original);
    const content = Buffer.from("retained attachment");
    const plan = createPlan(original, {
      id: "relocated-attachment", title: "Retain attachment", focus: "Retain attachment",
      status: "完成", keywords: ["attachment"],
      steps: [{ id: "done", title: "Done", completedAt: new Date().toISOString() }],
      attachments: [{ name: "evidence.txt", contentBase64: content.toString("base64") }]
    });
    fs.renameSync(original, relocated);
    if (legacyLayout) {
      const filename = planJsonFile(relocated, plan.id, "active");
      const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
      stored.attachments[0].path = path.join(original, "plans", "attachments", plan.id, path.basename(plan.attachments[0]!.path));
      fs.writeFileSync(filename, JSON.stringify(stored));
    }
    const before = getPlan(relocated, plan.id)!;
    const updated = updatePlan(relocated, plan.id, {
      attachments: before.attachments,
      ...(archive ? { archiveStatus: "已归档" } : {})
    });
    const expected = path.join(planAttachmentDirectory(relocated, plan.id, archive ? "archive" : "active"), path.basename(plan.attachments[0]!.path));
    assert.deepEqual(updated.attachments, [{ ...plan.attachments[0], path: expected }]);
    assert.deepEqual(fs.readFileSync(expected), content);
    assert.deepEqual(getPlan(relocated, plan.id)!.attachments, updated.attachments);
  });
  }
}

for (const missing of [false, true]) {
  test(`retaining an attachment with ${missing ? "missing bytes" : "a mismatched digest"} rejects the update without rewriting the plan`, t => {
    const roleDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-retention-rejection-"));
    t.after(() => fs.rmSync(roleDir, { recursive: true, force: true }));
    const plan = createPlan(roleDir, {
      id: "retention-rejection", title: "Retain attachment", focus: "Retain attachment",
      status: "暂停", keywords: ["attachment"], steps: [{ id: "check", title: "Check" }],
      attachments: [{ name: "evidence.txt", contentBase64: Buffer.from("original bytes").toString("base64") }]
    });
    const filename = planJsonFile(roleDir, plan.id, "active");
    const stored = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (missing) fs.unlinkSync(plan.attachments[0]!.path);
    else stored.attachments[0].sha256 = "0".repeat(64);
    fs.writeFileSync(filename, JSON.stringify(stored));
    const before = fs.readFileSync(filename);
    assert.throws(() => updatePlan(roleDir, plan.id, { attachments: stored.attachments }), /missing or changed/);
    assert.deepEqual(fs.readFileSync(filename), before);
    if (!missing) assert.equal(fs.readFileSync(plan.attachments[0]!.path, "utf8"), "original bytes");
  });
}
