import { handleHookInput } from "./lib/rabi-context-store.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

try {
  const input = await readStdin();
  const output = await handleHookInput(input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  // Hooks are context helpers, not an execution gate. Fail open and keep diagnostics on stderr.
  process.stderr.write(`[rabi-codex-context] ${error instanceof Error ? error.message : String(error)}\n`);
}
