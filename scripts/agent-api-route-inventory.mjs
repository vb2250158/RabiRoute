#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/builtin");
const managerFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile() && entry.name === "manager.mjs") managerFiles.push(target);
  }
}
walk(root);
const exact = [], dispatchScopes = [], unresolved = [], declarations = [];
const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
for (const file of managerFiles) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const relativeFile = path.relative(root, file).replaceAll(path.sep, "/");
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = new Map();
      for (const prop of node.properties) {
        const name = prop.name && (ts.isIdentifier(prop.name) ? prop.name.text : literal(prop.name));
        if (name) fields.set(name, ts.isPropertyAssignment(prop) ? prop.initializer : undefined);
      }
      if (fields.has("routeId")) {
        const routeId = literal(fields.get("routeId"));
        const kind = literal(fields.get("kind"));
        const routePath = literal(fields.get(kind === "prefix" ? "pathPrefix" : "path"));
        const methodNode = fields.get("methods");
        const methods = methodNode && ts.isArrayLiteralExpression(methodNode) ? methodNode.elements.map(literal) : null;
        const record = { file: relativeFile, routeId: routeId ?? null, path: routePath ?? null, methods };
        declarations.push(record);
        if (!routeId || !routePath || !["exact", "prefix"].includes(kind) || node.properties.some(ts.isSpreadAssignment)) {
          unresolved.push({ ...record, reason: "dynamic or unsupported route declaration", line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
        } else if (kind === "prefix") {
          dispatchScopes.push({ ...record, pathPrefix: routePath });
          if (methodNode && (!methods || methods.some(method => !method))) {
            unresolved.push({ ...record, reason: "prefix route has dynamic methods" });
          }
        } else if (!methods || !methods.length || methods.some(method => !method)) {
          unresolved.push({ ...record, reason: "exact route has no fully literal methods" });
        } else {
          for (const method of methods) {
            if (method === "*") unresolved.push({ ...record, reason: "wildcard method is not expanded" });
            else exact.push({ ...record, method });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const unique = items => [...new Map(items.map(item => [JSON.stringify(item), item])).values()];
const uniqueDeclarations = unique(declarations);
const uniqueExact = unique(exact.map(({ file, routeId, path: routePath, method }) => ({ file, routeId, path: routePath, method })));
const uniqueScopes = unique(dispatchScopes.map(({ file, routeId, pathPrefix, methods }) => ({ file, routeId, pathPrefix, methods })));
const result = {
  schemaVersion: "1",
  generatedAt: new Date().toISOString(),
  sourceRoot: path.relative(process.cwd(), root).replaceAll(path.sep, "/") || ".",
  routeDeclarationCount: uniqueDeclarations.length,
  managerFileCount: managerFiles.length,
  exactMethodPathCount: uniqueExact.length,
  dispatchScopeCount: uniqueScopes.length,
  unresolvedCount: unique(unresolved).length,
  counts: { routeDeclarations: uniqueDeclarations.length, exactMethodPaths: uniqueExact.length, dispatchScopes: uniqueScopes.length, unresolved: unique(unresolved).length },
  limitations: ["AST 仅收集 manager.mjs 中显式含 routeId 属性的对象，不执行代码；完全由导入或工厂生成的路由不在清单内。", "dispatchScopes 不是 endpoint；处理器内动态 pathname、regex、switch、别名和独立监听器不在 exact 计数内；exact 计数按文件和 routeId 区分。", "unresolved 只表示声明层无法展开，不代表所有源码未解析分支的完整数量。"],
  exact: unique(exact), dispatchScopes: unique(dispatchScopes), unresolved: unique(unresolved)
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
