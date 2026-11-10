import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalPlanStorageName } from "../planStorageLayout.js";
import { prepareApplicationPluginStorage } from "../shared/pluginStorage.js";
import type { RuntimeLayout } from "../shared/runtimeLayout.js";
import type { DataUpgradeItem, DataUpgradeStatus } from "../shared/dataUpgradeContract.js";
import { atomicWriteFileSync } from "../shared/filePersistence.js";
import { BoundedStorageStartup } from "./boundedStorageStartup.js";
import { createStorageStartupProcess } from "./storageStartupProcess.js";
import type { PlanStorageStartupGateSummary } from "./planStorageStartupGate.js";
import type { DataUpgradeService } from "./dataUpgradeService.js";
import type { ApiOperationDefinition } from "./apiOperationContract.js";

export const pluginUpgradeId = (item: { pluginId: string; instanceId?: string; migrationId: string }): string =>
  `plugin:${JSON.stringify([item.pluginId, item.instanceId ?? null, item.migrationId])}`;
export const upgradeReceiptPath = (layout: RuntimeLayout): string => path.join(layout.stateRoot, "data", ".runtime", "data-upgrades.json");
export type DataUpgradeReceipt = { schemaVersion: 1; status: DataUpgradeStatus; confirmedItemIds: string[]; receipts: Record<string, DataUpgradeStatus> };
export async function readDataUpgradeReceipt(layout: RuntimeLayout): Promise<DataUpgradeReceipt | undefined> {
  try {
    const receipt = JSON.parse(await fs.promises.readFile(upgradeReceiptPath(layout), "utf8")) as DataUpgradeReceipt;
    if (receipt.schemaVersion !== 1 || !receipt.status || !Array.isArray(receipt.confirmedItemIds) || !receipt.receipts) throw new Error("Invalid data upgrade receipt.");
    return receipt;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function writeDataUpgradeReceipt(layout: RuntimeLayout, receipt: DataUpgradeReceipt): void {
  fs.mkdirSync(path.dirname(upgradeReceiptPath(layout)), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(upgradeReceiptPath(layout), JSON.stringify(receipt), { mode: 0o600 });
}
function entries(directory: string): fs.Dirent[] {
  try { return fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function metadataFingerprint(root: string): string {
  const hash = createHash("sha256");
  const record = (filename: string): void => {
    try {
      const stat = fs.lstatSync(filename);
      hash.update(JSON.stringify([path.relative(root, filename), stat.size, stat.mtimeMs, stat.ctimeMs, stat.dev, stat.ino]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(JSON.stringify([path.relative(root, filename), null]));
    }
  };
  // Confirmation watches the fixed plan structure. The migration owner proves
  // full attachment/history contents through its original transaction receipts.
  // Never enumerate attachment blobs, quarantine or nested historical snapshots.
  for (const directory of [path.join(root, "items", "active"), path.join(root, "active"), path.join(root, "archive")]) {
    record(directory);
    for (const entry of entries(directory).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json")) {
        record(filename);
        const id = entry.name.slice(0, -5);
        for (const sidecar of [path.join(root, "history", `${id}.jsonl`), path.join(root, "feedback", `${id}.jsonl`), path.join(root, "attachments", id)]) record(sidecar);
      } else if (entry.isDirectory() && !entry.isSymbolicLink() && directory !== path.join(root, "items", "active")) {
        record(filename);
        for (const relative of ["plan.json", "history.jsonl", "feedback.jsonl", "attachments", "feedback-attachments"]) record(path.join(filename, relative));
      }
    }
  }
  return hash.digest("hex");
}
/** Runs only in a bounded discovery child, never on the Manager request thread. */
export function discoverPlanDataUpgrades(rolesRoot: string): DataUpgradeItem[] {
  const items: DataUpgradeItem[] = [];
  for (const role of entries(rolesRoot)) {
    if (!role.isDirectory() || role.isSymbolicLink()) continue;
    const root = path.join(rolesRoot, role.name, "plans");
    let pending = [path.join(root, "items", "active"), path.join(root, "archive")]
      .some(directory => entries(directory).some(item => item.isFile() && item.name.endsWith(".json")));
    let error: string | undefined;
    for (const bucket of ["active", "archive"]) {
      for (const plan of entries(path.join(root, bucket))) {
        if (!plan.isDirectory() || plan.isSymbolicLink()) continue;
        const directory = path.join(root, bucket, plan.name), filename = path.join(directory, "plan.json");
        if (!fs.existsSync(filename)) continue;
        if (fs.lstatSync(filename).size > 8 * 1024 * 1024) { error = "计划元数据超过检查预算，请检查该计划文件后重试。"; continue; }
        let raw: Record<string, any>;
        try { raw = JSON.parse(fs.readFileSync(filename, "utf8")); }
        catch { error = "有计划文件无法读取，请检查该人格的数据后重试。"; continue; }
        if (plan.name !== canonicalPlanStorageName(raw.id || plan.name) || !fs.existsSync(path.join(directory, "history.jsonl"))
          || raw.activationStatus === undefined || raw.markerStatus === undefined
          || Array.isArray(raw.steps) && raw.steps.some((step: Record<string, unknown>) => step.workPhase !== undefined || step.discussionState !== undefined)) {
          pending = true;
        }
      }
    }
    if (pending || error) items.push({ id: `plan:${role.name}`, title: `计划数据 · ${role.name}`,
      description: "更新旧版计划目录、状态字段及历史记录；原身份和内容由现有迁移器保留。", state: error ? "failed" : "pending",
      inputFingerprint: metadataFingerprint(root), ...(error ? { error } : {}) });
  }
  return items;
}
export async function discoverDataUpgradesInChild(layout: RuntimeLayout, rolesRoot: string): Promise<DataUpgradeItem[]> {
  const pluginResults = await prepareApplicationPluginStorage({ phase: "owners-retired", layout, migrationPolicy: "inspect" });
  const items: DataUpgradeItem[] = pluginResults.filter(item => item.status === "pending" || item.status === "failed").map(item => ({
    id: pluginUpgradeId(item), title: `插件存档 · ${item.pluginId}${item.instanceId ? ` / ${item.instanceId}` : ""}`,
    inputFingerprint: item.inputFingerprint,
    description: item.status === "failed" ? "插件存档升级检查失败。" : "将旧版存档交接至插件专属目录；升级在应用重启且原拥有者退出后执行。",
    state: item.status === "failed" ? "failed" : "pending", ...(item.status === "failed" ? { error: item.message } : {})
  }));
  return [...items, ...discoverPlanDataUpgrades(rolesRoot)];
}
export async function discoverDataUpgrades(layout: RuntimeLayout, rolesRoot: string, scope: BoundedStorageStartup): Promise<DataUpgradeItem[]> {
  let items: DataUpgradeItem[] = [];
  await scope.run([rolesRoot], root => createStorageStartupProcess<DataUpgradeItem[]>({ kind: "data_upgrade_discovery", rolesRoot: root, layout }),
    (_root, discovered) => { items = discovered; }, () => { throw new Error("Data upgrade discovery did not complete."); });
  return items;
}

/** Called before CP/plugins start, under the exclusive generation owner. Never call from an active Manager API. */
export async function consumeConfirmedDataUpgrades(layout: RuntimeLayout, rolesRoot: string, readOnly: boolean,
  owners: Readonly<{ discover?: typeof discoverDataUpgrades; preparePlugins?: typeof prepareApplicationPluginStorage }> = {}): Promise<void> {
  if (readOnly) return;
  let receipt: DataUpgradeReceipt | undefined;
  const recordInterrupted = (message: string): void => {
    console.error(`[data-upgrades] ${message}`);
    if (!receipt) return;
    const status: DataUpgradeStatus = { ...receipt.status, state: "interrupted", revision: receipt.status.revision + 1,
      operation: receipt.status.operation ? { ...receipt.status.operation, state: "interrupted", updatedAt: new Date().toISOString(), error: message } : undefined };
    try {
      writeDataUpgradeReceipt(layout, { ...receipt, status, receipts: { ...receipt.receipts, ...(status.operation ? { [status.operation.operationId]: status } : {}) } });
      receipt = { ...receipt, status };
    } catch { console.error("[data-upgrades] Could not update the original upgrade receipt; its confirmed inputs were not replaced."); }
  };
  const preparePlugins = async (confirmedMigrationIds: readonly string[] = []) => {
    try {
      return await (owners.preparePlugins ?? prepareApplicationPluginStorage)({ phase: "owners-retired", layout, migrationPolicy: "defer", confirmedMigrationIds });
    } catch {
      recordInterrupted("插件存档准备未完成；已保留原数据和确认回执，应用继续启动以便检查。不能据此报告升级成功。");
      return undefined;
    }
  };
  try { receipt = await readDataUpgradeReceipt(layout); }
  catch {
    // A corrupt confirmation is not authorization. Keep the WebGUI repair/status entrance available.
    await preparePlugins();
    return;
  }
  const confirmed = receipt && ["awaiting-restart", "interrupted"].includes(receipt.status.state) ? receipt.confirmedItemIds : [];
  if (receipt && confirmed.length) {
    let candidates: DataUpgradeItem[];
    try {
      candidates = await (owners.discover ?? discoverDataUpgrades)(layout, rolesRoot, new BoundedStorageStartup({ concurrency: 1, itemTimeoutMs: 120_000, batchTimeoutMs: 150_000 }));
    } catch {
      recordInterrupted("升级来源检查未完成或超时；已保留原数据和确认回执，本次启动仅继续普通事务恢复。请检查后使用原升级记录重试。");
      await preparePlugins();
      return;
    }
    const changed = receipt.status.items.filter(item => confirmed.includes(item.id)).some(item => {
      const current = candidates.find(candidate => candidate.id === item.id);
      return !current || current.inputFingerprint !== item.inputFingerprint;
    });
    if (changed) {
      const status: DataUpgradeStatus = { ...receipt.status, state: "interrupted", revision: receipt.status.revision + 1, restartRequired: false,
        items: candidates, operation: receipt.status.operation ? { ...receipt.status.operation, state: "interrupted", requiresRestart: false,
          updatedAt: new Date().toISOString(), error: "升级来源已变化，请查看最新列表后重新确认。" } : undefined };
      writeDataUpgradeReceipt(layout, { ...receipt, status, confirmedItemIds: [], receipts: { ...receipt.receipts, ...(status.operation ? { [status.operation.operationId]: status } : {}) } });
      await preparePlugins();
      return;
    }
  }
  const pluginResults = await preparePlugins(confirmed.filter(id => id.startsWith("plugin:")).map(id => id.slice(7)));
  if (!pluginResults) return;
  if (!receipt || !confirmed.length) return;
  const items = receipt.status.items.map(item => ({ ...item }));
  const scope = new BoundedStorageStartup({ concurrency: 1, itemTimeoutMs: 180_000, batchTimeoutMs: 600_000 });
  for (const item of items.filter(item => confirmed.includes(item.id) && item.id.startsWith("plugin:"))) {
    const result = pluginResults.find(result => pluginUpgradeId(result) === item.id);
    item.state = result && result.status !== "failed" && result.status !== "pending" ? "succeeded" : "failed";
    if (item.state === "failed") item.error = result?.message ?? "Confirmed plugin migration is no longer available.";
  }
  await scope.run(items.filter(item => confirmed.includes(item.id) && item.id.startsWith("plan:")),
    item => createStorageStartupProcess<PlanStorageStartupGateSummary>({ kind: "plan", rolesRoot, roleId: item.id.slice(5), allowMigration: true }),
    (item, summary) => { item.state = summary.failures.length ? "failed" : "succeeded"; if (summary.failures.length) item.error = summary.failures.join("; "); },
    item => { item.state = "failed"; item.error = "Plan upgrade child failed or timed out; original migration receipts are preserved."; });
  const failed = items.some(item => confirmed.includes(item.id) && item.state === "failed"), now = new Date().toISOString();
  const status: DataUpgradeStatus = { ...receipt.status, revision: receipt.status.revision + 1, state: failed ? "failed" : "succeeded", items,
    restartRequired: false, operation: receipt.status.operation ? { ...receipt.status.operation, state: failed ? "failed" : "succeeded",
      updatedAt: now, completedAt: now, requiresRestart: false, completedItems: items.filter(item => item.state === "succeeded").length } : undefined };
  writeDataUpgradeReceipt(layout, { ...receipt, status, confirmedItemIds: [], receipts: { ...receipt.receipts,
    ...(status.operation ? { [status.operation.operationId]: status } : {}) } });
}

export function createDataUpgradeOperations(owner: Readonly<{ service: DataUpgradeService; canManage: (request: import("node:http").IncomingMessage) => boolean }>): readonly ApiOperationDefinition[] {
  const empty = { type: "object", properties: {}, additionalProperties: false };
  const response = { mediaType: "application/json", schema: { type: "object", additionalProperties: true } };
  return (["GET", "POST"] as const).map(method => ({ contract: {
    operationId: method === "GET" ? "manager.data-upgrades.status" : "manager.data-upgrades.start", contractVersion: "1.0.0",
    method, pathTemplate: method === "GET" ? "/api/data-upgrades" : "/api/data-upgrades/start", exposure: "public", transport: "http",
    description: method === "GET" ? "Read the cached background data upgrade snapshot." : "Confirm the displayed upgrades and request the normal Host lifecycle after the durable receipt is returned.",
    request: { path: empty, query: { type: "object", additionalProperties: true }, headers: { type: "object" },
      body: method === "GET" ? { kind: "none" } : { kind: "json", maxBytes: 4096, schema: { type: "object", required: ["operationId", "expectedRevision"],
        properties: { operationId: { type: "string", minLength: 8, maxLength: 128 }, expectedRevision: { type: "integer", minimum: 0 } }, additionalProperties: false } } },
    responses: { "200": response, "202": response, "400": response, "403": response, "409": response },
    effects: { mode: method === "GET" ? "read" : "data-write", description: "Metadata discovery is background-only; accepted upgrades persist consent before the formal Host lifecycle." },
    recovery: { strategy: "read-before-retry", description: "Read the persisted operation by its original operationId after uncertain transport; do not create a replacement request." },
    validators: [{ id: "manager.data-upgrades.owner", description: "Connection management authorization, cached revision CAS and stable operation receipts are checked by their owners." }]
  }, handler: input => {
    const headers = { "cache-control": "private, no-store" };
    if (method === "GET") return { status: 200, headers, body: owner.service.snapshot() };
    if (!owner.canManage(input.request)) return { status: 403, headers, body: { code: -1, message: "数据升级需要有效的管理连接。" } };
    try {
      const status = owner.service.accept(input.body as import("../shared/dataUpgradeContract.js").DataUpgradeStartRequest);
      if (status.state === "awaiting-restart" && status.operation) {
        const id = status.operation.operationId;
        input.response.once("finish", () => { void owner.service.requestRestart(id); });
      }
      return { status: status.state === "awaiting-restart" ? 202 : 200, headers, body: status };
    } catch (error) {
      const known = error as { statusCode?: number; message?: string };
      return { status: known.statusCode ?? 400, headers, body: { code: -1, message: known.statusCode ? known.message : "升级请求未保存，请查看运行日志。" } };
    }
  } }));
}
