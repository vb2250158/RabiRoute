import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { roleInfoPayload } from "./roleInfoPayload.js";

test("gateway summary role info omits full persona markdown reads and contents", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-summary-"));
  const roleDir = path.join(rootDir, "data", "roles", "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi\n\nLong persona body.", "utf8");

  const originalReadFileSync = fs.readFileSync;
  const markdownReads: string[] = [];
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof filePath === "string" && filePath.toLowerCase().endsWith(".md")) markdownReads.push(filePath);
    return originalReadFileSync.call(fs, filePath, ...args as [never]);
  }) as typeof fs.readFileSync;

  try {
    const payload = roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, { includeContents: false });
    const role = (payload.options as Array<Record<string, unknown>>)[0];
    assert.equal(markdownReads.length, 0);
    assert.equal("roleContent" in role, false);
    assert.equal("roleError" in role, false);
    assert.equal("selectedRoleContent" in payload, false);
    assert.equal("selectedRoleError" in payload, false);
    assert.equal(role.roleTitle, "Rabi");
    assert.equal(payload.selectedRoleTitle, "Rabi");
    assert.equal(role.value, "Rabi");
    assert.equal(payload.selectedRoleDataDir, roleDir);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("full gateway role info keeps persona preview content", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-detail-"));
  const roleDir = path.join(rootDir, "data", "roles", "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi\n\nPersona preview.", "utf8");

  try {
    const payload = roleInfoPayload(rootDir, { agentRoleId: "Rabi" });
    const role = (payload.options as Array<Record<string, unknown>>)[0];
    assert.equal(role.roleContent, "# Rabi\n\nPersona preview.");
    assert.equal(role.roleTitle, "Rabi");
    assert.equal(payload.selectedRoleContent, "# Rabi\n\nPersona preview.");
    assert.equal(payload.selectedRoleTitle, "Rabi");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("one gateway payload reuses the persona catalog across routes", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rabiroute-role-cache-"));
  const roleDir = path.join(rootDir, "data", "roles", "Rabi");
  fs.mkdirSync(roleDir, { recursive: true });
  fs.writeFileSync(path.join(roleDir, "persona.md"), "# Rabi\n\nCached persona.", "utf8");

  const originalReadFileSync = fs.readFileSync;
  const markdownReads: string[] = [];
  fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof filePath === "string" && filePath.toLowerCase().endsWith(".md")) markdownReads.push(filePath);
    return originalReadFileSync.call(fs, filePath, ...args as [never]);
  }) as typeof fs.readFileSync;

  try {
    const catalogCache = new Map<string, Array<Record<string, unknown>>>();
    roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, { catalogCache });
    roleInfoPayload(rootDir, { agentRoleId: "Rabi" }, { catalogCache });
    assert.equal(markdownReads.length, 1);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
