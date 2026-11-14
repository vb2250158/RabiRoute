import { discoverSpeechServiceUrl } from "./lib/discover-speech-url.mjs";

try {
  if (process.argv.length > 3) throw new Error("Usage: node scripts/resolve-speech.mjs [explicit-service-url]");
  process.stdout.write(`${await discoverSpeechServiceUrl({ explicit: process.argv[2] })}\n`);
} catch (error) {
  process.stderr.write(`RabiSpeech discovery failed: ${error.message}\n`);
  process.exitCode = 1;
}
