import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { migrateAgentDeliveryConfiguration } from "./agentDeliveryMigration.js";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

export function migrateAgentDeliveryFiles(options: {
  personaPath: string; routePaths: string[]; apply?: boolean;
  beforeWrite?: (index: number) => void;
  explicitTargetRuleIds?: ReadonlySet<string>;
}): { changed: boolean; files: number; snapshotPath?: string } {
  const paths = [options.personaPath, ...options.routePaths].map(file => path.resolve(file));
  if (new Set(paths).size !== paths.length) throw new Error("Migration paths must be unique.");
  const snapshotRoot = path.join(path.dirname(paths[0]), ".agent-delivery-migration");
  // A prior process may have stopped between file commits. Recover only bytes
  // proven to belong to that transaction, never overwrite another editor.
  if (fs.existsSync(snapshotRoot)) for (const entry of fs.readdirSync(snapshotRoot)) {
    const directory = path.join(snapshotRoot, entry);
    const manifestPath = path.join(directory, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!["prepared", "recovery_required"].includes(manifest.state)) continue;
    if (!options.apply) throw new Error(`Unfinished migration requires recovery: ${directory}`);
    const recoveries = (manifest.paths as string[]).map((file, index) => {
      const original = fs.readFileSync(path.join(directory, `${index}.json`));
      const current = fs.readFileSync(file);
      const candidatePath = path.join(directory, `${index}.next.json`);
      if (!current.equals(original) && (!fs.existsSync(candidatePath) || !current.equals(fs.readFileSync(candidatePath)))) {
        throw new Error(`Migration recovery conflicts with a configuration edit: ${directory}`);
      }
      return { file, original };
    });
    for (const { file, original } of recoveries) {
      fs.writeFileSync(file, original);
      if (!fs.readFileSync(file).equals(original)) throw new Error(`Migration recovery readback mismatch: ${directory}`);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, state: "restored" }, null, 2));
  }
  const originals = paths.map(file => fs.readFileSync(file));
  const persona = JSON.parse(originals[0].toString("utf8"));
  if (options.explicitTargetRuleIds && persona.agentDeliveryConfigurationVersion !== 1) {
    for (const rule of persona.automationRules ?? []) {
      if (rule.action?.type === "deliver_agent" && !options.explicitTargetRuleIds.has(rule.id)) delete rule.action.target;
    }
  }
  const routes = originals.slice(1).map((bytes, index) => ({ ...JSON.parse(bytes.toString("utf8")), id: path.basename(path.dirname(paths[index + 1])) })) as GatewayDefinition[];
  const result = migrateAgentDeliveryConfiguration(persona, routes);
  if (!result.changed || !options.apply) return { changed: result.changed, files: result.changed ? paths.length : 0 };
  const next = [result.persona, ...result.routes].map(value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
  const snapshotPath = path.join(path.dirname(paths[0]), ".agent-delivery-migration", randomUUID());
  fs.mkdirSync(snapshotPath, { recursive: true });
  originals.forEach((bytes, index) => fs.writeFileSync(path.join(snapshotPath, `${index}.json`), bytes, { flag: "wx" }));
  next.forEach((bytes, index) => fs.writeFileSync(path.join(snapshotPath, `${index}.next.json`), bytes, { flag: "wx" }));
  fs.writeFileSync(path.join(snapshotPath, "manifest.json"), JSON.stringify({ state: "prepared", paths }, null, 2));
  const written: number[] = [];
  try {
    // Publish the persona's version marker only after all route receivers exist.
    for (const index of [...paths.keys()].slice(1).concat(0)) {
      options.beforeWrite?.(index);
      if (!fs.readFileSync(paths[index]).equals(originals[index])) throw new Error("Configuration changed during migration.");
      const temporary = `${paths[index]}.${path.basename(snapshotPath)}.tmp`;
      fs.writeFileSync(temporary, next[index], { flag: "wx" });
      fs.renameSync(temporary, paths[index]);
      written.push(index);
      if (!fs.readFileSync(paths[index]).equals(next[index])) throw new Error("Migration readback mismatch.");
    }
    paths.forEach((file, index) => {
      if (!fs.readFileSync(file).equals(next[index])) throw new Error("Configuration changed before migration commit.");
    });
    fs.writeFileSync(path.join(snapshotPath, "manifest.json"), JSON.stringify({ state: "committed", paths }, null, 2));
    return { changed: true, files: paths.length, snapshotPath };
  } catch (error) {
    const conflicts: string[] = [];
    for (const index of written.reverse()) {
      if (!fs.readFileSync(paths[index]).equals(next[index])) { conflicts.push(paths[index]); continue; }
      fs.writeFileSync(paths[index], originals[index]);
      if (!fs.readFileSync(paths[index]).equals(originals[index])) conflicts.push(paths[index]);
    }
    fs.writeFileSync(path.join(snapshotPath, "manifest.json"), JSON.stringify({ state: conflicts.length ? "recovery_required" : "restored", paths, conflicts }, null, 2));
    if (conflicts.length) throw new Error(`Migration recovery requires review of ${snapshotPath}`, { cause: error });
    throw error;
  }
}
