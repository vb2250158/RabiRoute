import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { relativeMaterialPath } from "./workbenchGraph.mjs";

export async function ownedFile(root, relative) {
  relativeMaterialPath(relative);
  const base = await fs.realpath(root), file = await fs.realpath(path.join(base, relative));
  const relation = path.relative(base, file);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) throw new Error("文件越出绑定根。");
  return file;
}
export async function fingerprint(root, relative) {
  const file = await ownedFile(root, relative), handle = await fs.open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("目录不能作为文件产物。");
    const hash = createHash("sha256"), buffer = Buffer.alloc(256 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("产物尚未稳定。");
    return { sha256: hash.digest("hex"), bytes: after.size };
  } finally { await handle.close(); }
}
async function matches(root, pattern) {
  relativeMaterialPath(pattern);
  const folder = path.posix.dirname(pattern), leaf = path.posix.basename(pattern);
  if (folder.includes("*") || pattern.includes("?") || pattern.includes("[") || leaf.includes("**")) throw new Error("仅支持文件名中的单层 * 通配符。");
  if (!leaf.includes("*")) return [pattern];
  const directory = folder === "." ? await fs.realpath(root) : await ownedFile(root, folder);
  const expression = new RegExp("^" + leaf.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return (await fs.readdir(directory, { withFileTypes: true })).filter(row => row.isFile() && expression.test(row.name)).map(row => folder === "." ? row.name : `${folder}/${row.name}`).sort();
}
export async function inspectRequirements(requirements, roots) {
  const records = [];
  for (const requirement of requirements || []) {
    const rootKey = requirement.root || "output", root = roots[rootKey];
    if (!root) throw new Error(`未配置产物绑定根：${rootKey}`);
    const files = await matches(root, requirement.path).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const relative of files) {
      try { records.push({ key: requirement.key, root: rootKey, path: relative, ...await fingerprint(root, relative) }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return records;
}
export async function validateArtifacts(node, roots, baseline, receipt, attemptId, machineId) {
  const artifacts = await inspectRequirements(node.requirements, roots), results = [];
  for (const requirement of node.requirements || []) {
    const matches = artifacts.filter(row => row.key === requirement.key);
    let valid = matches.length >= (requirement.minCount || 1);
    for (const file of matches) {
      const old = baseline.find(row => row.key === file.key && row.root === file.root && row.path === file.path);
      if (requirement.freshness === "produced") valid &&= !old || old.sha256 !== file.sha256 || receipt.writes?.some(write => write.path === file.path && write.root === file.root && write.sha256 === file.sha256 && write.attemptId === attemptId);
      if (requirement.freshness === "validated") valid &&= node.config.validationOnly === true && receipt.validated?.some(row => row.sha256 === file.sha256 && row.path === file.path);
      if (requirement.freshness === "reused") valid &&= receipt.reused?.some(row => row.sha256 === file.sha256 && row.path === file.path && row.attemptId);
      if (requirement.type && requirement.type !== "file") throw new Error(`不支持的产物校验器：${requirement.type}`);
    }
    results.push({ key: requirement.key, passed: Boolean(valid), required: requirement.required !== false });
  }
  if (results.some(row => row.required && !row.passed)) throw new Error(`产物校验失败：${results.filter(row => row.required && !row.passed).map(row => row.key).join(", ")}`);
  return { artifacts: artifacts.map(row => ({ ...row, artifactId: randomUUID(), attemptId, machineId })), validation: results };
}
