import fs from "node:fs";
import path from "node:path";

const defaultFiles = [
  "data/gateways.json",
  "examples/data/gateways.json"
];

const files = process.argv.slice(2);
const targets = files.length > 0 ? files : defaultFiles;
let hasError = false;

for (const target of targets) {
  const filePath = path.resolve(process.cwd(), target);
  if (!fs.existsSync(filePath)) {
    console.log(`skip ${target}: file not found`);
    continue;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const content = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const trimmed = content.trimEnd();
  const hasTrailingLiteralNewline = /(?:\\n)+$/.test(trimmed);

  try {
    JSON.parse(content);
    if (raw !== content) {
      console.warn(`warn ${target}: file starts with UTF-8 BOM; JSON was parsed after stripping it`);
    }
    if (hasTrailingLiteralNewline) {
      console.warn(`warn ${target}: file ends with visible literal \\n; remove it unless it is intentionally inside a JSON string`);
    } else {
      console.log(`ok ${target}`);
    }
  } catch (error) {
    hasError = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error ${target}: JSON parse failed: ${message}`);

    if (hasTrailingLiteralNewline) {
      const repaired = trimmed.replace(/(?:\\n)+$/, "");
      try {
        JSON.parse(repaired);
        console.error(`hint ${target}: removing trailing visible literal \\n makes the JSON valid`);
      } catch {
        // Keep the primary parse error as the actionable output.
      }
    }
  }
}

if (hasError) {
  process.exitCode = 1;
}
