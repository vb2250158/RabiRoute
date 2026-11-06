import { handleAntigravityHookInput } from "./lib/rabi-manager-client.mjs";

// Antigravity runs hook commands with the plugin directory as the working
// directory and passes the payload as one JSON object on stdin.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

try {
  const input = await readStdin();
  // Keep this executable deliberately thin: the Manager owns persona binding,
  // context construction, and permission decisions. The hook only translates
  // Antigravity's event names and payload shape.
  const output = await handleAntigravityHookInput(input);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  // Report on stderr so stdout stays valid JSON for the host. The Manager
  // remains the source of truth for binding state.
  process.stderr.write(`[rabi-antigravity-context] ${error instanceof Error ? error.message : String(error)}\n`);
}
