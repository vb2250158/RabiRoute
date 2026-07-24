import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_PATH = path.join(REPO_ROOT, "dist", "acceptance", "personaSyncDualNode.js");

function parseArgs(argv) {
  const options = { outputPath: "", timeoutMs: 30_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--timeout-seconds") options.timeoutMs = Math.max(5, Number(argv[++index] || 0)) * 1000;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function helpText() {
  return [
    "Usage: npm run check:persona-sync:dual-node -- [options]",
    "  --output <report.json>    Override the local sanitized evidence path",
    "  --timeout-seconds <n>     One-shot infrastructure deadline (default 30)",
    "Runs two isolated persona roots with the current built coordinator, dedicated LAN listener,",
    "the real RabiLink Relay server, and a real target worker/Manager data plane.",
    "It does not use the existing port 8790, application token, Relay data, or persona folders."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (!fs.existsSync(RUNNER_PATH)) throw new Error("Built dual-node acceptance runner is missing. Run npm run build:backend first.");
  const { runPersonaSyncDualNodeAcceptance } = await import(pathToFileURL(RUNNER_PATH).href);
  const result = await runPersonaSyncDualNodeAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    acceptancePassed: result.report.acceptancePassed,
    transports: result.report.transports,
    counts: result.report.counts,
    evidencePath: result.evidencePath
  }, null, 2)}\n`);
  return result.exitCode;
}

process.exitCode = await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
