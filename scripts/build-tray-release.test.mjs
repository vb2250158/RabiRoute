import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const producer = fileURLToPath(new URL("./build-tray-release.mjs", import.meta.url));
const manifestName = "tray-release.json";
const fixture = new Map([
  ["python/pythonw.exe", "windowless Python fixture"],
  ["main.py", "print('tray fixture')"],
  ["rabiroute_tray/assets/tray.ico", "Tray icon fixture"],
  ["python/python.exe", "Python fixture"]
]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rabi-tray-producer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, "desktop-runtime");
  const output = path.join(root, "state");
  for (const [relative, text] of fixture) {
    const file = path.join(runtime, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  return {
    runtime,
    releases: path.join(output, "tray-releases"),
    async build(destination = output) {
      const { stdout } = await execute(process.execPath, [
        producer, "--desktop-runtime", runtime, "--output-root", destination
      ]);
      return JSON.parse(stdout);
    }
  };
}

test("publishes the complete deterministic Tray payload and reuses it on concurrent attempts", async t => {
  const candidate = await createFixture(t);
  const [first, second] = await Promise.all([candidate.build(), candidate.build()]);
  assert.deepEqual(first, second);
  assert.equal(first.releaseRoot, path.join(candidate.releases, first.digest));
  assert.equal(first.fileCount, fixture.size);
  assert.deepEqual(await fs.readdir(candidate.releases), [first.digest]);

  const manifestBytes = await fs.readFile(path.join(first.releaseRoot, manifestName));
  assert.equal(sha256(manifestBytes), first.digest);
  assert.deepEqual(JSON.parse(manifestBytes), {
    schemaVersion: 1,
    files: Array.from(fixture.keys()).sort().map(relative => {
      const contents = fixture.get(relative);
      return { path: relative, size: Buffer.byteLength(contents), sha256: sha256(contents) };
    })
  });
  for (const [relative, contents] of fixture) {
    assert.equal(await fs.readFile(path.join(first.releaseRoot, relative), "utf8"), contents);
  }

  await fs.writeFile(path.join(candidate.runtime, "main.py"), "print('next tray fixture')");
  const updated = await candidate.build();
  assert.notEqual(updated.digest, first.digest);
  assert.equal(await fs.readFile(path.join(first.releaseRoot, "main.py"), "utf8"), fixture.get("main.py"));
});

test("refuses to reuse a tampered release and leaves its original files available for diagnosis", async t => {
  const candidate = await createFixture(t);
  const existing = await candidate.build();
  const script = path.join(existing.releaseRoot, "main.py");
  await fs.writeFile(script, "tampered");

  await assert.rejects(candidate.build(), /Existing Tray release fails verification/);
  assert.deepEqual(await fs.readdir(candidate.releases), [existing.digest]);
  assert.equal(await fs.readFile(script, "utf8"), "tampered");
});

test("rejects overlapping or incomplete input before publishing any output", async t => {
  const candidate = await createFixture(t);
  await assert.rejects(candidate.build(candidate.runtime), /output must not overlap/);
  await fs.unlink(path.join(candidate.runtime, "python", "pythonw.exe"));
  await assert.rejects(candidate.build(), /missing python\/pythonw\.exe/);
  await assert.rejects(fs.access(candidate.releases), { code: "ENOENT" });
});

test("rejects a linked payload directory without following it", async t => {
  const candidate = await createFixture(t);
  await fs.symlink(path.join(candidate.runtime, "python"), path.join(candidate.runtime, "alias"),
    process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(candidate.build(), /Tray runtime contains a link or unsupported file: alias/);
  await assert.rejects(fs.access(candidate.releases), { code: "ENOENT" });
});
