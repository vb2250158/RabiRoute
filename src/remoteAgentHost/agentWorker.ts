import { createAgentAdapter } from "../agentAdapters/agentAdapter.js";
import { normalizeAgentAdapters } from "../agentAdapters/types.js";

const messageArgument = process.argv.find(argument => argument.startsWith("--message="));

if (!messageArgument) {
  console.error("RabiRoute Remote Agent delivery failed: message is missing.");
  process.exit(1);
}

const message = decodeURIComponent(messageArgument.slice("--message=".length));
const adapters = normalizeAgentAdapters(
  String(process.env.AGENT_ADAPTERS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

if (!adapters.length) {
  console.error("RabiRoute Remote Agent delivery failed: no Agent adapters are configured.");
  process.exit(1);
}

try {
  await Promise.all(adapters.map(adapter => createAgentAdapter(adapter).deliver(message)));
  console.log("RabiRoute Remote Agent delivery completed.");
} catch (error) {
  console.error(`RabiRoute Remote Agent delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
