import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { atomicWriteFileSync } from "./filePersistence.js";

test("atomic write retries transient Windows/SMB rename failures without losing the previous file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-atomic-write-"));
  const target = path.join(root, "manifest-index.json");
  fs.writeFileSync(target, "before", "utf8");
  let renameAttempts = 0;
  try {
    atomicWriteFileSync(target, "after", {
      maxRenameAttempts: 3,
      retryDelayMs: 1,
      renameSync: (source, destination) => {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          assert.equal(fs.readFileSync(target, "utf8"), "before");
          const error = new Error("injected transient SMB rename failure") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        fs.renameSync(source, destination);
      }
    });

    assert.equal(renameAttempts, 3);
    assert.equal(fs.readFileSync(target, "utf8"), "after");
    assert.deepEqual(fs.readdirSync(root), ["manifest-index.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
