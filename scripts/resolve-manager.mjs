import { discoverManagerIdentity } from "./lib/discover-manager-url.mjs";

try {
  const identity = await discoverManagerIdentity();
  process.stdout.write(JSON.stringify(identity) + "\n");
} catch (error) {
  process.stderr.write(`RabiRoute discovery failed: ${error.message}\n`);
  process.exitCode = 1;
}
