import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEX_SHARED_RUNTIME_URL } from "../src/codexSharedRuntime.js";

const codex = fileURLToPath(new URL("../node_modules/@openai/codex/bin/codex.js", import.meta.url));
const child = spawn(process.execPath, [codex, "--remote", CODEX_SHARED_RUNTIME_URL, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: "inherit"
});
child.once("exit", (code) => { process.exitCode = code ?? 1; });
