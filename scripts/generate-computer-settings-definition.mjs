import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function declaration(value) {
  if (Array.isArray(value)) return "readonly [" + value.map(declaration).join(", ") + "]";
  if (value && typeof value === "object") return "{ " + Object.entries(value).map(([key,item]) => "readonly " + JSON.stringify(key) + ": " + declaration(item)).join("; ") + " }";
  return JSON.stringify(value);
}
/** A published SDK carries a generated bootstrap snapshot; the Core source owns the editable definition. */
export async function generateComputerSettingsDefinition(root, { check = false } = {}) {
  const source = path.join(root, "src/plugins/io.rabiroute.manager.core/assets/computer-settings.json");
  const definition = canonical(JSON.parse(await fs.readFile(source, "utf8")));
  if (definition.schemaVersion !== 1 || !definition.schema || (!definition.features || typeof definition.features !== "object" || Array.isArray(definition.features)) || !definition.actions) throw new Error("The Core computer settings definition is incomplete.");
  const json = JSON.stringify(definition);
  const digest = createHash("sha256").update(json).digest("hex");
  const header = "// Generated from Core/assets/computer-settings.json. Edit the canonical definition, not this SDK bootstrap.\n";
  const module = header + "const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };\n"
    + "export const COMPUTER_SETTINGS_DEFINITION = freeze(" + JSON.stringify(definition, null, 2) + ");\n"
    + "export const COMPUTER_SETTINGS_DEFINITION_DIGEST = " + JSON.stringify(digest) + ";\n";
  const types = header + "export const COMPUTER_SETTINGS_DEFINITION: " + declaration(definition) + ";\n"
    + "export const COMPUTER_SETTINGS_DEFINITION_DIGEST: " + JSON.stringify(digest) + ";\n";
  let changed = false;
  for (const [name,bytes] of [["computer-settings-definition.mjs",module],["computer-settings-definition.d.mts",types]]) {
    const filename = path.join(root,"apps/rabi-agent/lib",name);
    let previous;try { previous = await fs.readFile(filename,"utf8"); } catch(error) { if(error.code!=="ENOENT")throw error; }
    if(previous===bytes)continue;
    changed = true;
    if(check)throw new Error("The generated SDK computer definition is stale: " + name);
    await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes,"utf8");
  }
  return { digest, changed };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await generateComputerSettingsDefinition(process.cwd(), { check: process.argv.includes("--check") });
  console.log("Core computer definition bootstrap " + result.digest + (result.changed ? " generated" : " unchanged"));
}
