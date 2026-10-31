import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export function generatePluginApiTypes(root, { check = false } = {}) {
  const sourcePath = path.join(root, "src/manager/apiOperationContract.ts");
  const outputPath = path.join(root, "plugins/contracts/plugin-sdk/api-operation-contract.d.ts");
  const exported = new Set(["ApiMethod", "ApiSchema", "ApiBodyContract", "ApiResponseContract", "ApiOperationContract", "ApiOperationInput", "ApiOperationResult", "ApiOperationStream", "ApiOperationDefinition", "ApiOperationRegistration", "ApiUpgradeSession", "ApiUpgradeInput", "ApiUpgradeDefinition", "ApiUpgradeRegistration", "ApiHttpProxyInput", "ApiHttpProxyDefinition", "ManagerApiOperationsService"]);
  const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, "utf8"), ts.ScriptTarget.Latest, true);
  const definitions = source.statements.filter(statement => ts.isTypeAliasDeclaration(statement) && exported.has(statement.name.text));
  if (definitions.length !== exported.size) throw new Error("Public API operation type definitions are incomplete.");
  const generated = "// Generated from src/manager/apiOperationContract.ts. Do not edit; run scripts/generate-plugin-api-types.mjs.\n"
    + 'import type { IncomingMessage, ServerResponse } from "node:http";\nimport type { Duplex } from "node:stream";\n\n'
    + definitions.map(statement => statement.getText(source)).join("\n\n") + "\n";
  if (check) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8").replaceAll("\r\n", "\n") !== generated.replaceAll("\r\n", "\n")) {
      throw new Error("Published plugin API types have drifted from their executable contract source.");
    }
    process.stdout.write("Plugin API operation types match the source.\n");
  } else {
    fs.writeFileSync(outputPath, generated);
    process.stdout.write("Generated plugin API operation types.\n");
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  generatePluginApiTypes(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), { check: process.argv.includes("--check") });
}
