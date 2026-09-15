import { handleHookInput } from "./lib/rabi-manager-client.mjs";

// Read the JSON payload supplied by CodeBuddy for the current lifecycle event.
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

try {
  const input = await readStdin();
  // Keep this executable deliberately thin: Manager owns persona binding,
  // context construction, and tool permission decisions.
  const output = await handleHookInput(input);
  // An empty result means this event has nothing to add to the WorkBuddy turn.
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  // Hook failures are reported to stderr so they do not corrupt CodeBuddy's JSON
  // protocol; the Manager remains the source of truth for binding state.
  process.stderr.write(`[rabi-workbuddy-context] ${error instanceof Error ? error.message : String(error)}\n`);
}
