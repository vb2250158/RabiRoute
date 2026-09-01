import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORMAL_PARENT_MODULES = Object.freeze([
  "src/manager/controlPlaneRoutes.ts",
  "src/outbox.ts",
  "src/manager/planQaFeedback.ts",
  "src/manager/planFeedbackRecovery.ts",
  "src/manager/memoryConsolidationScheduleWorker.ts",
  "src/manager/personaAvatarRoutes.ts",
  "src/manager/personaDocumentRoutes.ts",
  "src/manager/planAttachmentRoutes.ts",
  "src/manager/rolePanelDelivery.ts",
  "src/manager/planTaskCompletionDelivery.ts"
]);

// TODO(manager-storage-parent-boundary): these modules remain outside the P0 gate
// only until their local storage seams are moved behind bounded read/mutation ports.
const PENDING_PARENT_MODULES = Object.freeze([
  "src/manager/desktopPetRoutes.ts",
  "src/manager/bilibiliHistoryBridge.ts",
  "src/manager/codexHookRoutes.ts"
]);

const FORBIDDEN_STORAGE_IMPLEMENTATION_IMPORT = /(?:^|\/)managerStorageMutation(?:Pool|Protocol|Child)(?:\.[cm]?[jt]s)?$/i;

const OWNER_EXPORT_GROUPS = Object.freeze({
  planAndMemory: Object.freeze({
    module: "roleKnowledge",
    exports: Object.freeze([
      "applyMemoryConsolidationResult",
      "archiveCompletedPlans",
      "clearPlanCatalogAfterStartupMigration",
      "completeMemoryConsolidation",
      "createMemoryConsolidationRequest",
      "createPlan",
      "createRecentMemory",
      "getConsolidatedMemory",
      "getRecentMemory",
      "markMemoryConsolidationRunDelivered",
      "pendingMemoryConsolidation",
      "roleKnowledgeSnapshot",
      "roleKnowledgeSnapshotFromStorage",
      "updatePlan",
      "updateRecentMemory"
    ])
  }),
  planFeedback: Object.freeze({
    module: "planFeedback",
    exports: Object.freeze([
      "updatePlanFeedbackDelivery",
      "updatePlanFeedbackDeliveryAsync",
      "updatePlanFeedbackPostCommit",
      "updatePlanFeedbackQaHandling"
    ])
  }),
  planFeedbackSubmission: Object.freeze({
    module: "planFeedbackSubmission",
    exports: Object.freeze(["submitPlanFeedback"])
  }),
  personaAvatar: Object.freeze({
    module: "personaAvatar",
    exports: Object.freeze(["removePersonaAvatar", "savePersonaAvatar"])
  }),
  rolePanel: Object.freeze({
    module: "rolePanelTimeline",
    exports: Object.freeze([
      "appendRolePanelTimelineMessage",
      "appendRolePanelTimelineMessageIfAbsent",
      "readRolePanelTimeline"
    ])
  }),
  messageContext: Object.freeze({
    module: "messageContextStore",
    exports: Object.freeze(["appendMessageContextToDir"])
  }),
  rabiLinkConversation: Object.freeze({
    module: "rabilinkConversationLedger",
    exports: Object.freeze(["appendRabiLinkConversationEntry"])
  }),
  conversationSituation: Object.freeze({
    module: "conversationSituationStore",
    exports: Object.freeze(["recordConversationSituation"])
  }),
  wearableHealth: Object.freeze({
    module: "wearableHealth",
    exports: Object.freeze(["ingestWearableHealthObservation", "updateWearableHealthConfig"])
  }),
  identity: Object.freeze({
    module: "identityRelations",
    exports: Object.freeze([
      "observeIdentityEndpoint",
      "recordIdentityCandidateObservation",
      "updateIdentityRelation"
    ])
  }),
  personaVoiceIdentity: Object.freeze({
    module: "personaVoiceIdentities",
    exports: Object.freeze(["updatePersonaVoiceIdentity"])
  })
});

const HARD_OWNER_GROUP_KEYS = new Set([
  "planAndMemory",
  "planFeedback",
  "planFeedbackSubmission",
  "rolePanel"
]);
const HARD_OWNER_MODULES = new Set(
  [...HARD_OWNER_GROUP_KEYS].map((key) => OWNER_EXPORT_GROUPS[key].module)
);

// These are real remaining parent-storage seams, not a wildcard allow-list.
// The executable baseline below fails when any seam is added, removed, or
// changes multiplicity; each entry also remains visible as a TODO in test output.
const EXPECTED_PENDING_PARENT_VIOLATION_COUNTS = Object.freeze([
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-call|identityRelations.recordIdentityCandidateObservation", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-call|identityRelations.updateIdentityRelation", 2],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-call|personaVoiceIdentities.updatePersonaVoiceIdentity", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-call|wearableHealth.updateWearableHealthConfig", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|identityRelations.recordIdentityCandidateObservation", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|identityRelations.updateIdentityRelation", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|messageContextStore.appendMessageContextToDir", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|personaVoiceIdentities.updatePersonaVoiceIdentity", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|wearableHealth.ingestWearableHealthObservation", 1],
  ["src/manager/controlPlaneRoutes.ts|domain-storage-owner-import|wearableHealth.updateWearableHealthConfig", 1],
  ["src/manager/controlPlaneRoutes.ts|role-storage-fs-access|fs.existsSync", 1],
  ["src/manager/controlPlaneRoutes.ts|role-storage-fs-access|fs.readdirSync", 1],
  ["src/manager/controlPlaneRoutes.ts|role-storage-fs-access|fs.readFileSync", 1],
  ["src/manager/personaAvatarRoutes.ts|domain-storage-owner-call|personaAvatar.removePersonaAvatar", 1],
  ["src/manager/personaAvatarRoutes.ts|domain-storage-owner-call|personaAvatar.savePersonaAvatar", 1],
  ["src/manager/personaAvatarRoutes.ts|domain-storage-owner-import|personaAvatar.removePersonaAvatar", 1],
  ["src/manager/personaAvatarRoutes.ts|domain-storage-owner-import|personaAvatar.savePersonaAvatar", 1],
  ["src/manager/personaAvatarRoutes.ts|role-storage-fs-access|fs.createReadStream", 1],
  ["src/manager/personaAvatarRoutes.ts|role-storage-fs-access|fs.statSync", 1],
  ["src/manager/personaDocumentRoutes.ts|role-storage-fs-access|fs.existsSync", 1],
  ["src/manager/personaDocumentRoutes.ts|role-storage-fs-access|fs.readFileSync", 1],
  ["src/manager/personaDocumentRoutes.ts|role-storage-fs-access|fs.realpathSync", 2],
  ["src/manager/personaDocumentRoutes.ts|role-storage-fs-access|fs.statSync", 1],
  ["src/manager/planAttachmentRoutes.ts|role-storage-fs-access|fs.readFileSync", 1],
  ["src/outbox.ts|domain-storage-owner-call|messageContextStore.appendMessageContextToDir", 1],
  ["src/outbox.ts|domain-storage-owner-call|rabilinkConversationLedger.appendRabiLinkConversationEntry", 1],
  ["src/outbox.ts|domain-storage-owner-import|messageContextStore.appendMessageContextToDir", 1],
  ["src/outbox.ts|domain-storage-owner-import|rabilinkConversationLedger.appendRabiLinkConversationEntry", 1],
  ["src/outbox.ts|role-storage-fs-access|fs.appendFileSync", 2],
  ["src/outbox.ts|role-storage-fs-access|fs.existsSync", 2],
  ["src/outbox.ts|role-storage-fs-access|fs.mkdirSync", 2],
  ["src/outbox.ts|role-storage-fs-access|fs.readFile", 1],
  ["src/outbox.ts|role-storage-fs-access|fs.readFileSync", 2]
]);

const FORBIDDEN_OWNER_EXPORTS = new Map(
  Object.values(OWNER_EXPORT_GROUPS).map((group) => [group.module, new Set(group.exports)])
);

const FORBIDDEN_FS_METHODS = new Set([
  "access",
  "appendFile",
  "copyFile",
  "createReadStream",
  "createWriteStream",
  "lstat",
  "mkdir",
  "open",
  "readFile",
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "truncate",
  "unlink",
  "writeFile"
]);

const STORAGE_PATH_CARRYING_READERS = new Set([
  "readPersonaAvatar"
]);

function moduleOwnerKey(moduleSpecifier) {
  const basename = moduleSpecifier.replace(/\\/g, "/").split("/").at(-1) ?? "";
  return basename.replace(/\.[cm]?[jt]s$/i, "");
}

function rootPathName(name) {
  const normalized = name.replace(/[^a-z]/gi, "").toLowerCase();
  return normalized.endsWith("roledir")
    || normalized.endsWith("rolesdir")
    || normalized.endsWith("rolesroot")
    || normalized.endsWith("routeroot")
    || normalized.endsWith("plandirectories")
    || normalized.endsWith("roledirectories");
}

function pathFactoryName(name) {
  return /(?:path|file|roleDir|rolesDir|routeDir|dataDir|dataDirs|folderPath)(?:$|For|From|Of|By|With|To)/i.test(name)
    || /^(?:resolve|join|dirname|normalize|realpath)(?:Sync)?$/i.test(name);
}

function makeSourceProgram(relativePath, sourceText) {
  const fileName = path.resolve(repoRoot, relativePath);
  const compilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext
  };
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    compilerOptions.target,
    true,
    ts.ScriptKind.TS
  );
  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const canonicalFileName = path.resolve(fileName).toLowerCase();
  const host = {
    ...baseHost,
    fileExists(candidate) {
      return path.resolve(candidate).toLowerCase() === canonicalFileName;
    },
    getSourceFile(candidate) {
      return path.resolve(candidate).toLowerCase() === canonicalFileName ? sourceFile : undefined;
    },
    readFile(candidate) {
      return path.resolve(candidate).toLowerCase() === canonicalFileName ? sourceText : undefined;
    },
    writeFile() {}
  };
  const program = ts.createProgram({ rootNames: [fileName], options: compilerOptions, host });
  return {
    checker: program.getTypeChecker(),
    sourceFile: program.getSourceFile(fileName) ?? sourceFile
  };
}

function visitTree(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => visitTree(child, visit));
}

function bindingIdentifiers(name, output = []) {
  if (ts.isIdentifier(name)) {
    output.push(name);
    return output;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    bindingIdentifiers(element.name, output);
  }
  return output;
}

function functionSymbol(node, checker) {
  if (node.name && ts.isIdentifier(node.name)) return checker.getSymbolAtLocation(node.name);
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return checker.getSymbolAtLocation(node.parent.name);
  }
  return undefined;
}

function directReturnExpressions(body) {
  const expressions = [];
  function visit(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) expressions.push(node.expression);
    ts.forEachChild(node, visit);
  }
  visit(body);
  return expressions;
}

function analyzeSource(relativePath, sourceText) {
  const { checker, sourceFile } = makeSourceProgram(relativePath, sourceText);
  const violations = [];
  const importedOwnersByLocalName = new Map();
  const importedOwnerNamespaces = new Map();
  const fsNamespaceNames = new Set();
  const fsNamedImports = new Map();
  const taintedPathSymbols = new Set();
  const pathReturningFunctions = new Set();
  const localFunctions = new Map();

  function addViolation(node, code, detail) {
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      code,
      column: location.character + 1,
      detail,
      file: relativePath.replace(/\\/g, "/"),
      line: location.line + 1
    });
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const moduleSpecifier = statement.moduleSpecifier.text;
    const importClause = statement.importClause;
    if (FORBIDDEN_STORAGE_IMPLEMENTATION_IMPORT.test(moduleSpecifier)) {
      addViolation(
        statement.moduleSpecifier,
        "storage-implementation-import",
        `formal parent module imports child/pool implementation ${JSON.stringify(moduleSpecifier)}; inject a narrow port instead`
      );
    }

    if (moduleSpecifier === "node:fs" || moduleSpecifier === "fs") {
      if (importClause?.name) fsNamespaceNames.add(importClause.name.text);
      const bindings = importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) fsNamespaceNames.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          fsNamedImports.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
    }
    if (moduleSpecifier === "node:fs/promises" || moduleSpecifier === "fs/promises") {
      if (importClause?.name) fsNamespaceNames.add(importClause.name.text);
      const bindings = importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) fsNamespaceNames.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          fsNamedImports.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
    }

    const ownerKey = moduleOwnerKey(moduleSpecifier);
    const forbiddenExports = FORBIDDEN_OWNER_EXPORTS.get(ownerKey);
    if (!forbiddenExports || !importClause?.namedBindings) continue;
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      importedOwnerNamespaces.set(importClause.namedBindings.name.text, { ownerKey, forbiddenExports });
      addViolation(
        importClause.namedBindings,
        "domain-storage-owner-namespace-import",
        `formal parent namespace-imports ${ownerKey}, exposing storage mutation owners; inject a narrow port instead`
      );
      continue;
    }
    for (const element of importClause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = element.propertyName?.text ?? element.name.text;
      if (!forbiddenExports.has(importedName)) continue;
      importedOwnersByLocalName.set(element.name.text, { importedName, ownerKey });
      addViolation(
        element,
        "domain-storage-owner-import",
        `formal parent imports ${ownerKey}.${importedName}; inject a read/mutation port instead`
      );
    }
  }

  visitTree(sourceFile, (node) => {
    if (ts.isIdentifier(node) && rootPathName(node.text)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) taintedPathSymbols.add(symbol);
    }
    if (ts.isFunctionLike(node) && node.body) {
      const symbol = functionSymbol(node, checker);
      if (!symbol) return;
      localFunctions.set(symbol, {
        name: node.name && ts.isIdentifier(node.name)
          ? node.name.text
          : ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)
            ? node.parent.name.text
            : "",
        node,
        parameters: node.parameters.map((parameter) => bindingIdentifiers(parameter.name)
          .map((identifier) => checker.getSymbolAtLocation(identifier))
          .filter(Boolean)),
        returns: directReturnExpressions(node.body)
      });
    }
  });

  function calleeSymbol(expression) {
    if (ts.isIdentifier(expression)) return checker.getSymbolAtLocation(expression);
    if (ts.isParenthesizedExpression(expression)) return calleeSymbol(expression.expression);
    return undefined;
  }

  function calleeName(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression);
    return "";
  }

  function isPathTainted(node, active = new Set()) {
    if (!node || active.has(node)) return false;
    active.add(node);
    try {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        return rootPathName(node.text) || Boolean(symbol && taintedPathSymbols.has(symbol));
      }
      if (ts.isPropertyAccessExpression(node)) {
        return rootPathName(node.name.text) || isPathTainted(node.expression, active);
      }
      if (ts.isElementAccessExpression(node)) {
        return isPathTainted(node.expression, active)
          || (ts.isStringLiteralLike(node.argumentExpression) && rootPathName(node.argumentExpression.text));
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const symbol = calleeSymbol(node.expression);
        const name = calleeName(node.expression);
        if (symbol && pathReturningFunctions.has(symbol)) return true;
        const hasTaintedArgument = (node.arguments ?? []).some((argument) => isPathTainted(argument, active));
        return hasTaintedArgument && (pathFactoryName(name) || STORAGE_PATH_CARRYING_READERS.has(name));
      }
      if (ts.isParenthesizedExpression(node)
        || ts.isAsExpression(node)
        || ts.isTypeAssertionExpression(node)
        || ts.isNonNullExpression(node)
        || ts.isSatisfiesExpression(node)) {
        return isPathTainted(node.expression, active);
      }
      let childTainted = false;
      ts.forEachChild(node, (child) => {
        if (!childTainted && isPathTainted(child, active)) childTainted = true;
      });
      return childTainted;
    } finally {
      active.delete(node);
    }
  }

  function taintBinding(name) {
    let changed = false;
    for (const identifier of bindingIdentifiers(name)) {
      const symbol = checker.getSymbolAtLocation(identifier);
      if (symbol && !taintedPathSymbols.has(symbol)) {
        taintedPathSymbols.add(symbol);
        changed = true;
      }
    }
    return changed;
  }

  let changed = true;
  while (changed) {
    changed = false;
    visitTree(sourceFile, (node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && isPathTainted(node.initializer)) {
        changed = taintBinding(node.name) || changed;
      }
      if (ts.isParameter(node) && node.initializer && isPathTainted(node.initializer)) {
        changed = taintBinding(node.name) || changed;
      }
      if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && isPathTainted(node.right)
        && (ts.isIdentifier(node.left) || ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))) {
        if (ts.isIdentifier(node.left)) {
          const symbol = checker.getSymbolAtLocation(node.left);
          if (symbol && !taintedPathSymbols.has(symbol)) {
            taintedPathSymbols.add(symbol);
            changed = true;
          }
        }
      }
      if (ts.isForOfStatement(node) && isPathTainted(node.expression)) {
        const initializer = node.initializer;
        if (ts.isVariableDeclarationList(initializer)) {
          for (const declaration of initializer.declarations) changed = taintBinding(declaration.name) || changed;
        }
      }
      if (!ts.isCallExpression(node)) return;
      if (ts.isPropertyAccessExpression(node.expression)
        && /^(?:add|push|set|unshift)$/i.test(node.expression.name.text)
        && node.arguments.some((argument) => isPathTainted(argument))) {
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver)) {
          const symbol = checker.getSymbolAtLocation(receiver);
          if (symbol && !taintedPathSymbols.has(symbol)) {
            taintedPathSymbols.add(symbol);
            changed = true;
          }
        }
      }
      if (ts.isPropertyAccessExpression(node.expression)
        && /^(?:filter|flatMap|forEach|map|some)$/i.test(node.expression.name.text)
        && isPathTainted(node.expression.expression)) {
        const callback = node.arguments[0];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          if (callback.parameters[0]) changed = taintBinding(callback.parameters[0].name) || changed;
        }
      }
      if (calleeName(node.expression) === "mapBounded" && isPathTainted(node.arguments[0])) {
        const callback = node.arguments[2];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          if (callback.parameters[0]) changed = taintBinding(callback.parameters[0].name) || changed;
        }
      }
      const targetFunction = localFunctions.get(calleeSymbol(node.expression));
      if (!targetFunction) return;
      node.arguments.forEach((argument, index) => {
        if (!isPathTainted(argument)) return;
        for (const parameterSymbol of targetFunction.parameters[index] ?? []) {
          if (!taintedPathSymbols.has(parameterSymbol)) {
            taintedPathSymbols.add(parameterSymbol);
            changed = true;
          }
        }
      });
    });
    for (const [symbol, info] of localFunctions) {
      if (!pathReturningFunctions.has(symbol) && info.returns.some((expression) => isPathTainted(expression))) {
        pathReturningFunctions.add(symbol);
        changed = true;
      }
    }
  }

  function fsMethodForCall(call) {
    const expression = call.expression;
    if (ts.isIdentifier(expression) && fsNamedImports.has(expression.text)) {
      return fsNamedImports.get(expression.text);
    }
    if (!ts.isPropertyAccessExpression(expression)) return undefined;
    if (ts.isIdentifier(expression.expression) && fsNamespaceNames.has(expression.expression.text)) {
      return expression.name.text;
    }
    if (ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "promises"
      && ts.isIdentifier(expression.expression.expression)
      && fsNamespaceNames.has(expression.expression.expression.text)) {
      return expression.name.text;
    }
    return undefined;
  }

  visitTree(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    if (ts.isIdentifier(expression)) {
      const owner = importedOwnersByLocalName.get(expression.text);
      if (owner) {
        addViolation(
          expression,
          "domain-storage-owner-call",
          `formal parent calls ${owner.ownerKey}.${owner.importedName}; call the injected port instead`
        );
      }
    } else if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const owner = importedOwnerNamespaces.get(expression.expression.text);
      if (owner?.forbiddenExports.has(expression.name.text)) {
        addViolation(
          expression,
          "domain-storage-owner-call",
          `formal parent calls ${owner.ownerKey}.${expression.name.text}; call the injected port instead`
        );
      }
    }

    const method = fsMethodForCall(node);
    if (!method || (!method.endsWith("Sync") && !FORBIDDEN_FS_METHODS.has(method))) return;
    const taintedArguments = node.arguments.filter((argument) => isPathTainted(argument));
    if (taintedArguments.length === 0) return;
    addViolation(
      expression,
      "role-storage-fs-access",
      `formal parent calls fs.${method} with a rolesRoot/roleDir/routeRoot-derived path; use a bounded child read/mutation port`
    );
  });

  return violations.sort((left, right) => left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.code.localeCompare(right.code));
}

function formatViolations(violations) {
  return violations.map((violation) => (
    `${violation.file}:${violation.line}:${violation.column} [${violation.code}] ${violation.detail}`
  )).join("\n");
}

function ownerIdentityForViolation(violation) {
  const direct = violation.detail.match(/\b(?:imports|calls) ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/);
  if (direct) return { module: direct[1], exportName: direct[2] };
  const namespace = violation.detail.match(/\bnamespace-imports ([A-Za-z0-9_]+)/);
  return namespace ? { module: namespace[1], exportName: "*" } : undefined;
}

function isHardParentViolation(violation) {
  if (violation.code === "storage-implementation-import") return true;
  const owner = ownerIdentityForViolation(violation);
  return Boolean(owner && HARD_OWNER_MODULES.has(owner.module));
}

function pendingViolationIdentity(violation) {
  const owner = ownerIdentityForViolation(violation);
  if (owner) return `${violation.file}|${violation.code}|${owner.module}.${owner.exportName}`;
  const fsMethod = violation.detail.match(/\bcalls fs\.([A-Za-z0-9_]+)/)?.[1];
  if (fsMethod) return `${violation.file}|${violation.code}|fs.${fsMethod}`;
  return `${violation.file}|${violation.code}|${violation.detail}`;
}

function violationCounts(violations) {
  const counts = new Map();
  for (const violation of violations) {
    const identity = pendingViolationIdentity(violation);
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function formalParentViolations() {
  return FORMAL_PARENT_MODULES.flatMap((relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    assert.equal(fs.existsSync(absolutePath), true, `missing formal parent module: ${relativePath}`);
    return analyzeSource(relativePath, fs.readFileSync(absolutePath, "utf8"));
  });
}

test("storage parent-boundary analyzer is symbol-aware and leaves local runtime logs alone", () => {
  const fixture = [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import { updatePlan as persistPlan } from "../roleKnowledge.js";',
    'import type { ManagerStorageMutationRequest } from "./managerStorageMutationProtocol.js";',
    'function mutate(roleDir, runtimeLogPath) {',
    '  const targetPath = path.join(roleDir, "plans", "one.json");',
    '  fs.readFileSync(targetPath, "utf8");',
    '  fs.appendFileSync(runtimeLogPath, "local runtime log");',
    '  return persistPlan(roleDir, "one", {});',
    '}',
    ''
  ].join("\n");
  const violations = analyzeSource("src/manager/__boundary-fixture.ts", fixture);
  assert.deepEqual(
    violations.map(({ code, line }) => ({ code, line })),
    [
      { code: "domain-storage-owner-import", line: 3 },
      { code: "storage-implementation-import", line: 4 },
      { code: "role-storage-fs-access", line: 7 },
      { code: "domain-storage-owner-call", line: 9 }
    ]
  );
});

test("formal Manager parents cannot call promised plan, memory, feedback, or role-panel owners", () => {
  const violations = formalParentViolations().filter(isHardParentViolation);
  assert.equal(
    violations.length,
    0,
    `hard Manager storage boundary violations:\n${formatViolations(violations)}`
  );
});

test("the Agent plan-feedback submit port uses one generation, authoritative revision, and delivery fencing", () => {
  const controlPlane = fs.readFileSync(path.join(repoRoot, "src/manager/controlPlaneRoutes.ts"), "utf8");
  const start = controlPlane.indexOf("async function submitAgentPlanFeedback(");
  const end = controlPlane.indexOf("\nfunction respondRoleStorageError", start);
  assert.ok(start >= 0 && end > start, "missing submitAgentPlanFeedback port implementation");
  const implementation = controlPlane.slice(start, end);
  const queryAt = implementation.indexOf("await application.queries.planFeedback(");
  const commandAt = implementation.indexOf("await application.commands.submitPlanFeedback(");
  assert.match(implementation, /const application = currentRoleStorageApplication\(\);/);
  assert.ok(queryAt >= 0 && commandAt > queryAt, "authoritative feedback projection must be queried before command submission");
  assert.match(implementation, /expectedRevision:\s*projection\.planRevision/);
  assert.match(
    implementation,
    /idempotencyKey:\s*roleStorageOperationKey\(["']agent-plan-feedback-reply["'],\s*input\.deliveryId\)/
  );
  assert.match(controlPlane, /submitPlanFeedback:\s*submitAgentPlanFeedback/);

  const outbox = fs.readFileSync(path.join(repoRoot, "src/outbox.ts"), "utf8");
  assert.doesNotMatch(outbox, /from\s+["'][^"']*planFeedbackSubmission(?:\.js)?["']/);
  assert.match(outbox, /submitPlanFeedback\?:\s*AgentPlanFeedbackSubmitPort/);
});

test("pending formal-parent storage seams match the explicit migration ledger", () => {
  const pending = formalParentViolations().filter((violation) => !isHardParentViolation(violation));
  assert.deepEqual(
    violationCounts(pending),
    EXPECTED_PENDING_PARENT_VIOLATION_COUNTS,
    `pending Manager storage seams changed; migrate the seam or update its explicit TODO with evidence:\n${formatViolations(pending)}`
  );
});

test("plan feedback recovery discovery is owned only by the Manager read child", () => {
  const sourceRoot = path.join(repoRoot, "src");
  const importers = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      const sourceText = fs.readFileSync(absolutePath, "utf8");
      if (!/from\s+["'][^"']*planFeedbackRecoveryDiscovery(?:\.js)?["']/.test(sourceText)) continue;
      importers.push(path.relative(repoRoot, absolutePath).replace(/\\/g, "/"));
    }
  };
  visit(sourceRoot);
  assert.deepEqual(importers.sort(), ["src/manager/managerReadWorker.ts"]);

  const readWorker = fs.readFileSync(path.join(repoRoot, "src/manager/managerReadWorker.ts"), "utf8");
  assert.match(
    readWorker,
    /case\s+["']plan_feedback_recovery_candidates["']:[\s\S]*listOpenPlanFeedbackRecoveryCandidates\(task\.rolesRoot\)/
  );
});

test("production role-panel timeline I/O stays inside the read child, mutation child, and storage primitive", () => {
  const allowed = new Set([
    "src/rolePanelTimeline.ts",
    "src/manager/managerReadWorker.ts",
    "src/manager/managerStorageMutationChild.ts"
  ]);
  const sources = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) sources.push(absolute);
    }
  };
  visit(path.join(repoRoot, "src"));
  const violations = sources.flatMap((absolute) => {
    const relative = path.relative(repoRoot, absolute).replace(/\\/g, "/");
    if (allowed.has(relative)) return [];
    const source = fs.readFileSync(absolute, "utf8");
    return /\b(?:appendRolePanelTimelineMessage(?:IfAbsent)?|readRolePanelTimeline)\b/.test(source)
      ? [relative]
      : [];
  });
  assert.deepEqual(violations, []);
});

for (const pendingPath of PENDING_PARENT_MODULES) {
  test.todo(`remove pending storage-boundary exclusion after port migration: ${pendingPath}`);
}

for (const [identity, count] of EXPECTED_PENDING_PARENT_VIOLATION_COUNTS) {
  test.todo(`migrate explicit pending Manager storage seam (${count}x): ${identity}`);
}
