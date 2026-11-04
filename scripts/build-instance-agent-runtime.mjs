import { buildInstanceAgentRuntime } from "./lib/build-native-agent-runtime.mjs";
console.log("Built native remote Agent runtime.", await buildInstanceAgentRuntime());
