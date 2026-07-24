import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_PATH = path.join(REPO_ROOT, "dist", "acceptance", "speechIngressSeparation.js");

function parseArgs(argv) {
  const options = { outputPath: "", timeoutMs: 20_000, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.outputPath = String(argv[++index] || "");
    else if (argument === "--timeout-seconds") options.timeoutMs = Math.max(1, Number(argv[++index] || 0)) * 1000;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function helpText() {
  return [
    "Usage: npm run check:speech-ingress-separation -- [options]",
    "  --output <report.json>    Override the local acceptance evidence path",
    "  --timeout-seconds <n>     One-shot deadline per isolated speech child (default 20)",
    "Runs the current built dist/index.js twice in an isolated temporary data root.",
    "It verifies one host store, separate speech/rabilink persona histories, and stable mobile reply targeting.",
    "No real Manager, Desktop task, QQ, Relay, microphone, or persona data is read or modified."
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${helpText()}\n`);
    return 0;
  }
  if (!fs.existsSync(RUNNER_PATH)) throw new Error("Built acceptance runner is missing. Run npm run build:backend first.");
  const { runSpeechIngressSeparationAcceptance } = await import(pathToFileURL(RUNNER_PATH).href);
  const result = await runSpeechIngressSeparationAcceptance(options);
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    acceptancePassed: result.report.acceptancePassed,
    counts: result.report.counts,
    endpoints: result.report.endpoints,
    evidencePath: result.evidencePath
  }, null, 2)}\n`);
  return result.exitCode;
}

process.exitCode = await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
