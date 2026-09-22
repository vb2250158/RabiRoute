import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { open as openZip, type ZipFile } from "yauzl";
import { buildRoleSkillArchive, RoleSkillArchiveError, roleSkillArchiveLimits, type RoleSkillArchiveLimits } from "./roleSkillArchive.js";

const markdown = (id?: string) => Buffer.from(`---\r\n${id ? `id: ${id}\r\n` : ""}keywords: [synthetic, archive]\r\n---\r\n# Synthetic skill\r\nSynthetic summary.\r\n`);
async function fixture() {
  const base = await fs.mkdtemp(path.resolve(".archive-test-"));
  const role = path.join(base, "role");
  const skills = path.join(role, "skills");
  await fs.mkdir(skills, { recursive: true });
  return { base, role, skills, output: path.join(base, "archive.zip") };
}
async function readZip(file: string): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((resolve, reject) => openZip(file, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result!)));
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    zip.on("error", reject);
    zip.on("end", () => resolve(entries));
    zip.on("entry", entry => {
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(error); zip.close(); return; }
        const chunks: Buffer[] = [];
        stream.on("error", reject);
        stream.on("data", chunk => chunks.push(chunk));
        stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}
async function rejectsArchive(f: Awaited<ReturnType<typeof fixture>>, id: string, code: RoleSkillArchiveError["code"], limits?: Partial<RoleSkillArchiveLimits>) {
  await assert.rejects(buildRoleSkillArchive(f.role, id, f.output, limits), (error: unknown) => error instanceof RoleSkillArchiveError && error.code === code);
  await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
}

test("root, nested and final directory scans stop at remaining budget plus one and close handles", async () => {
  for (const scenario of ["root", "nested", "final"]) {
    const f = await fixture();
    const originalOpendir = fs.opendir;
    const scans: { target: string; reads: number; closes: number }[] = [];
    let rootOpens = 0;
    try {
      const nested = path.join(f.skills, "sample", "nested");
      if (scenario === "nested") {
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(f.skills, "sample", "SKILL.md"), markdown());
        await fs.writeFile(path.join(f.skills, "sample", "z-pending"), "synthetic");
        for (const name of ["a", "b", "c"]) await fs.writeFile(path.join(nested, name), "synthetic");
      } else {
        await fs.writeFile(path.join(f.skills, "sample.md"), markdown());
        if (scenario === "root") {
          for (const name of ["a", "b", "c"]) await fs.writeFile(path.join(f.skills, name), "synthetic");
        }
      }
      fs.opendir = async (...args: Parameters<typeof fs.opendir>) => {
        const target = String(args[0]);
        if (target === f.skills && ++rootOpens === 2 && scenario === "final") {
          // Add entries after the final source-stat checks, immediately before
          // the catalog recheck opens; even this late failure must remove ZIP.
          for (const name of ["a", "b", "c"]) await fs.writeFile(path.join(f.skills, name), "synthetic");
        }
        assert.equal(typeof args[1] === "object" && args[1]?.bufferSize, 1);
        const directory = await originalOpendir(...args);
        const scan = { target, reads: 0, closes: 0 };
        scans.push(scan);
        return new Proxy(directory, { get(targetDirectory, key) {
          if (key === "read") return async () => { scan.reads += 1; return targetDirectory.read(); };
          if (key === "close") return async () => { scan.closes += 1; await targetDirectory.close(); };
          const value = Reflect.get(targetDirectory, key, targetDirectory);
          return typeof value === "function" ? value.bind(targetDirectory) : value;
        } });
      };
      syncBuiltinESMExports();
      await rejectsArchive(f, "sample", "too_large", { maxEntries: scenario === "nested" ? 5 : 2 });
      const boundedScan = scenario === "nested" ? scans.find(scan => scan.target === nested) : scans.at(-1);
      assert.ok(boundedScan);
      // Nested remaining budget is 1: root + SKILL + nested + pending sibling
      // reserve 4 of 5 entries. A third child must never be read.
      assert.equal(boundedScan.reads, scenario === "nested" ? 2 : 3);
      assert.ok(scans.every(scan => scan.closes === 1), "every opened directory closes exactly once");
      if (scenario === "final") assert.equal(rootOpens, 2);
    } finally {
      fs.opendir = originalOpendir;
      syncBuiltinESMExports();
      await fs.rm(f.base, { recursive: true, force: true });
    }
  }
});

test("complete skill includes every regular file, empty directory, original bytes and ZIP hash", async () => {
  const f = await fixture();
  try {
    const files = new Map([
      ["SKILL.md", markdown()], ["scripts/run", Buffer.from("#!/bin/sh\nexit 0\n")],
      ["references/notes.md", Buffer.from("[outside](../../other/SKILL.md)")],
      ["agents/config.json", Buffer.from('{"synthetic":true}')],
      [".hidden", Buffer.from("hidden")], ["binary.dat", Buffer.from([0, 255, 128, 13, 10])],
      ["LICENSE", Buffer.from("synthetic")]
    ]);
    for (const [name, bytes] of files) {
      const target = path.join(f.skills, "sample", name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }
    await fs.mkdir(path.join(f.skills, "sample", "empty"));
    await fs.writeFile(path.join(f.skills, "other.md"), markdown());
    await fs.mkdir(path.join(f.skills, "unselected"));
    await fs.writeFile(path.join(f.skills, "unselected", "SKILL.md"), markdown());
    await fs.symlink(f.base, path.join(f.skills, "unselected", "not-followed"), "junction");
    const result = await buildRoleSkillArchive(f.role, "sample", f.output);
    const actual = await readZip(f.output);
    assert.equal(result.fileCount, files.size);
    assert.ok(actual.has("sample/"));
    assert.ok(actual.has("sample/empty/"));
    for (const [name, bytes] of files) assert.deepEqual(actual.get(`sample/${name}`), bytes);
    assert.equal([...actual.keys()].filter(name => !name.endsWith("/")).length, files.size);
    const archive = await fs.readFile(f.output);
    assert.equal(result.sizeBytes, archive.length);
    assert.equal(result.sha256, createHash("sha256").update(archive).digest("hex"));
    assert.equal(Object.isFrozen(roleSkillArchiveLimits), true);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("flat skill keeps bytes and metadata id chooses the actual directory", async () => {
  for (const directory of [false, true]) {
    const f = await fixture();
    try {
      const target = directory ? path.join(f.skills, "physical", "SKILL.md") : path.join(f.skills, "physical.md");
      await fs.mkdir(path.dirname(target), { recursive: true });
      const bytes = markdown("logical");
      await fs.writeFile(target, bytes);
      const result = await buildRoleSkillArchive(f.role, "logical", f.output);
      assert.deepEqual((await readZip(f.output)).get("logical/SKILL.md"), bytes);
      assert.equal(result.fileCount, 1);
    } finally { await fs.rm(f.base, { recursive: true, force: true }); }
  }
});

test("missing and invalid entries do not become skills", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.skills, "invalid.md"), "# No keywords\ntext");
    await rejectsArchive(f, "absent", "not_found");
    await rejectsArchive(f, "invalid", "not_found");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("duplicate metadata ids and flat/directory collisions are conflicts", async () => {
  for (const sameId of [false, true]) {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.skills, "sample.md"), markdown("logical"));
      await fs.mkdir(path.join(f.skills, "sample"));
      await fs.writeFile(path.join(f.skills, "sample", "SKILL.md"), markdown(sameId ? "logical" : "different"));
      await rejectsArchive(f, "logical", "conflict");
    } finally { await fs.rm(f.base, { recursive: true, force: true }); }
  }
});

test("unsafe requested ZIP names fail before output creation", async () => {
  const f = await fixture();
  try {
    for (const id of ["../sample", "..", "a/b", "a\\b", "C:sample", "/absolute", "NUL", "con.txt", "CON .txt", "CONIN$", "LPT1", "COM¹.txt", "a\0b", "trailing.", "trailing ", "a:stream"]) {
      await rejectsArchive(f, id, "unsafe_path");
    }
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("hardlinks and unsafe child names reject the whole skill", async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.skills, "sample");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "SKILL.md"), markdown());
    const original = path.join(f.base, "original");
    await fs.writeFile(original, "synthetic");
    await fs.link(original, path.join(folder, "linked"));
    await rejectsArchive(f, "sample", "unsafe_path");
    await fs.unlink(path.join(folder, "linked"));
    // Valid on Windows as a directory; still an unsafe extraction device name.
    if (process.platform !== "win32") {
      await fs.writeFile(path.join(folder, "NUL"), "synthetic");
      await rejectsArchive(f, "sample", "unsafe_path");
    }
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("junctions at skills root, selected root and child chain are rejected", async () => {
  for (const location of ["skills", "selected", "child"]) {
    const f = await fixture();
    try {
      const outside = path.join(f.base, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "SKILL.md"), markdown());
      if (location === "skills") {
        await fs.rmdir(f.skills);
        await fs.symlink(outside, f.skills, "junction");
      } else if (location === "selected") {
        await fs.symlink(outside, path.join(f.skills, "sample"), "junction");
      } else {
        await fs.mkdir(path.join(f.skills, "sample"));
        await fs.writeFile(path.join(f.skills, "sample", "SKILL.md"), markdown());
        await fs.symlink(outside, path.join(f.skills, "sample", "references"), "junction");
      }
      await rejectsArchive(f, "sample", "unsafe_path");
    } finally { await fs.rm(f.base, { recursive: true, force: true }); }
  }
});

test("file, total, entry, depth and streamed archive limits remove output", async () => {
  for (const limits of [{ maxFileBytes: 1 }, { maxTotalBytes: 1 }, { maxEntries: 1 }, { maxDepth: 0 }, { maxArchiveBytes: 1 }]) {
    const f = await fixture();
    try {
      await fs.mkdir(path.join(f.skills, "sample"));
      await fs.writeFile(path.join(f.skills, "sample", "SKILL.md"), markdown());
      await rejectsArchive(f, "sample", "too_large", limits);
    } finally { await fs.rm(f.base, { recursive: true, force: true }); }
  }
});

test("Unicode-normalized archive name collisions are rejected without renaming", async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.skills, "sample");
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "SKILL.md"), markdown());
    await fs.writeFile(path.join(folder, "\u00e9"), "first");
    await fs.writeFile(path.join(folder, "e\u0301"), "second");
    await rejectsArchive(f, "sample", "conflict");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("output cannot be created inside its own skills source", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.skills, "sample.md"), markdown());
    const inside = path.join(f.skills, "archive.zip");
    await assert.rejects(buildRoleSkillArchive(f.role, "sample", inside), { code: "unsafe_path" });
    await assert.rejects(fs.stat(inside), { code: "ENOENT" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("existing output is not overwritten or deleted", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.skills, "sample.md"), markdown());
    await fs.writeFile(f.output, "existing");
    await assert.rejects(buildRoleSkillArchive(f.role, "sample", f.output), { code: "conflict" });
    assert.equal(await fs.readFile(f.output, "utf8"), "existing");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("mid-read and ZIP output failures close every source handle and remove output", { timeout: 5000 }, async () => {
  for (const failure of ["read", "output"]) {
    const f = await fixture();
    const originalOpen = fs.open;
    const outstanding = new Set<Awaited<ReturnType<typeof fs.open>>>();
    let assetOpened = false;
    try {
      const folder = path.join(f.skills, "sample");
      const asset = path.join(folder, "payload");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "SKILL.md"), markdown());
      await fs.writeFile(asset, randomBytes(256 * 1024));
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (typeof args[0] !== "string" || !args[0].startsWith(`${folder}${path.sep}`)) return handle;
        outstanding.add(handle);
        const isAsset = args[0] === asset;
        if (isAsset) assetOpened = true;
        let reads = 0;
        return new Proxy(handle, { get(target, key) {
          if (key === "close") return async () => {
            try { await target.close(); } finally { outstanding.delete(handle); }
          };
          if (key === "read") return async (...readArgs: unknown[]) => {
            if (isAsset && failure === "read" && ++reads === 2) throw new Error("Synthetic mid-read failure.");
            return Reflect.apply(target.read, target, readArgs);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      };
      syncBuiltinESMExports();
      await rejectsArchive(f, "sample", failure === "read" ? "conflict" : "too_large",
        failure === "output" ? { maxArchiveBytes: 2048 } : undefined);
      assert.equal(assetOpened, true, "failure must occur after the asset handle opens");
      assert.equal(outstanding.size, 0, "all source handles must close before rejection returns");
    } finally {
      fs.open = originalOpen;
      syncBuiltinESMExports();
      for (const handle of outstanding) await handle.close();
      await fs.rm(f.base, { recursive: true, force: true });
    }
  }
});

test("source or directory mutation during streaming is a conflict, not a partial success", async () => {
  for (const mutateDirectory of [false, true]) {
    const f = await fixture();
    const originalOpen = fs.open;
    try {
      const folder = path.join(f.skills, "sample");
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, "SKILL.md"), markdown());
      const asset = path.join(folder, "payload");
      await fs.writeFile(asset, "before");
      let changed = false;
      fs.open = async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === asset && !changed) {
          changed = true;
          await fs.writeFile(mutateDirectory ? path.join(folder, "new-child") : asset, "changed-longer");
        }
        return handle;
      };
      syncBuiltinESMExports();
      await rejectsArchive(f, "sample", "conflict");
      assert.equal(changed, true);
    } finally {
      fs.open = originalOpen;
      syncBuiltinESMExports();
      await fs.rm(f.base, { recursive: true, force: true });
    }
  }
});
