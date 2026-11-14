import process from "node:process";
import { buildPluginWebPackages } from "./build-plugin-web-packages.mjs";

// Complete every catalog Web package after the one shell/runtime build. This
// entry no longer creates global-asset wrappers or a second plugin Vite graph.
const result = await buildPluginWebPackages(process.cwd(), { allWeb: true });
console.log(`Built ${result.packages.length} self-contained Web plugin closures.`);
