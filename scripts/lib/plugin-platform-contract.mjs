import path from "node:path";
import ts from "typescript";

export const PUBLICATION_MODULE = "@rabiroute/plugin-sdk/publication";
const publicationTypes = new Set(["PluginPublication", "PluginPublicationContext", "PluginPublicationRegistrar"]);

function parse(source, file = "plugin.mjs") {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function publicationBinding(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return false;
    return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => {
      const symbol = (element.propertyName ?? element.name).text;
      return clause.isTypeOnly || element.isTypeOnly ? publicationTypes.has(symbol) : symbol === "PublicationScope";
    });
  }
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.length > 0 && node.exportClause.elements.every(element =>
      (node.isTypeOnly || element.isTypeOnly) && publicationTypes.has((element.propertyName ?? element.name).text));
  }
  if (ts.isImportTypeNode(node)) return !node.isTypeOf && node.qualifier
    && ts.isIdentifier(node.qualifier) && publicationTypes.has(node.qualifier.text);
  return false;
}

/** The dependency-free publication leaf is the only SDK exception, with named bindings only. */
export function kernelImportViolations(file, source) {
  const violations = [];
  const check = (specifier, node) => {
    if (specifier.startsWith("node:")) return;
    if (specifier.startsWith("./") && !specifier.includes("\\")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (target.startsWith("src/plugin-kernel/")) return;
    }
    if (specifier === PUBLICATION_MODULE && publicationBinding(node)) return;
    violations.push(`${file} imports outside the Plugin Kernel: ${specifier}`);
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) check(node.moduleSpecifier.text, node);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) check(node.argument.literal.text, node);
    else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) check(node.arguments[0].text, node);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      check(node.moduleReference.expression.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, file));
  return violations;
}

/** Validate that the exception still resolves directly to a dependency-free leaf. */
export function publicationPackageViolations(manifest, source, declarations = "") {
  const expected = { types: "./publication.d.ts", import: "./publication.mjs", default: "./publication.mjs" };
  const exported = manifest.exports?.["./publication"];
  const violations = [];
  if (!exported || Object.keys(exported).length !== Object.keys(expected).length
    || Object.entries(expected).some(([key, value]) => exported[key] !== value)) {
    violations.push("Plugin SDK must export its formal publication leaf directly.");
  }
  if (!["publication.mjs", "publication.d.ts"].every(file => manifest.files?.includes(file))) {
    violations.push("Plugin SDK package must include the formal publication leaf and declarations.");
  }
  const visit = node => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)
      || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)
      || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
      violations.push("Plugin SDK publication leaf must remain dependency-free.");
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  visit(parse(declarations, "publication.d.ts"));
  const declarationFile = parse(declarations, "publication.d.ts");
  const localTypes = new Set();
  const declared = node => {
    if ((ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)
      || ts.isTypeParameterDeclaration(node)) && node.name) localTypes.add(node.name.text);
    ts.forEachChild(node, declared);
  };
  declared(declarationFile);
  const stableTypes = new Set(["Readonly", "Promise", "AbortSignal"]);
  const stableType = name => ts.isIdentifier(name) && (localTypes.has(name.text) || stableTypes.has(name.text));
  const validateType = node => {
    if (ts.isTypeQueryNode(node) || (ts.isTypeReferenceNode(node)
      && !stableType(node.typeName)) || (ts.isExpressionWithTypeArguments(node) && !stableType(node.expression))) {
      violations.push("Plugin SDK publication declarations must use only local or stable lifecycle types.");
    }
    ts.forEachChild(node, validateType);
  };
  validateType(declarationFile);
  return violations;
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
  return node;
}

export function relativeModuleSpecifiers(source) {
  return parse(source).statements.flatMap(node =>
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
    && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("./")
      ? [node.moduleSpecifier.text] : []);
}

/** A structural authoring gate, not proof that native cleanup actually joins resources. */
export function hasReleasablePluginScope(source, { modules = new Map(), fileName = "manager.mjs" } = {}) {
  const file = parse(source, fileName);
  const files = new Map([...modules].map(([name, text]) => [name, parse(text, name)]));
  files.set(fileName, file);
  const bindings = new Map();
  const scope = node => {
    while (node && !ts.isBlock(node) && !ts.isSourceFile(node) && !ts.isFunctionLike(node)
      && !ts.isCatchClause(node) && !ts.isCaseBlock(node) && !ts.isForStatement(node)
      && !ts.isForOfStatement(node) && !ts.isForInStatement(node)) node = node.parent;
    return node;
  };
  const bind = (owner, name, value) => {
    const values = bindings.get(owner) ?? new Map();
    values.set(name, value); bindings.set(owner, values);
  };
  const index = node => {
    if (ts.isVariableDeclaration(node)) {
      const names = name => {
        if (ts.isIdentifier(name)) bind(scope(node.parent), name.text, ts.isIdentifier(node.name) ? node.initializer : undefined);
        else for (const element of name.elements) if (ts.isBindingElement(element)) names(element.name);
      };
      names(node.name);
    }
    if (ts.isFunctionDeclaration(node) && node.name) bind(scope(node.parent), node.name.text, node);
    if (ts.isClassDeclaration(node) && node.name) bind(scope(node.parent), node.name.text, node);
    if (ts.isFunctionLike(node)) for (const parameter of node.parameters) {
      if (ts.isIdentifier(parameter.name)) bind(node, parameter.name.text, undefined);
    }
    ts.forEachChild(node, index);
  };
  for (const module of files.values()) index(module);
  const exported = (module, name, seen = new Set()) => {
    if (!module || seen.has(module)) return undefined;
    seen = new Set(seen).add(module);
    for (const statement of module.statements) {
      const publicStatement = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (publicStatement && ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (publicStatement && ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
        if (declaration) return declaration.initializer;
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const element = statement.exportClause.elements.find(item => item.name.text === name);
        if (!element) continue;
        const original = (element.propertyName ?? element.name).text;
        if (!statement.moduleSpecifier) return bindings.get(module)?.get(original);
        if (ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(module.fileName), statement.moduleSpecifier.text));
          return exported(files.get(target), original, seen);
        }
      }
    }
    return undefined;
  };
  for (const module of files.values()) for (const statement of module.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
      || !statement.moduleSpecifier.text.startsWith("./") || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(module.fileName), statement.moduleSpecifier.text));
    for (const element of statement.importClause.namedBindings.elements) {
      bind(module, element.name.text, exported(files.get(target), (element.propertyName ?? element.name).text));
    }
  }
  const bindingOwner = identifier => {
    for (let node = identifier.parent; node; node = node.parent) {
      const values = bindings.get(node);
      if (values?.has(identifier.text)) return node;
    }
    return undefined;
  };
  const binding = identifier => bindings.get(bindingOwner(identifier))?.get(identifier.text);
  const returns = fn => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const values = [];
    const visit = node => {
      if (ts.isReturnStatement(node) && node.expression) values.push(node.expression);
      if (ts.isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    return values;
  };
  const propertyName = node => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : undefined;
  const property = (object, name) => object.properties.find(item => propertyName(item) === name);
  const resolve = (input, seen = new Set()) => {
    const node = unwrap(input);
    if (!node || seen.has(node)) return undefined;
    seen = new Set(seen).add(node);
    if (ts.isIdentifier(node)) return resolve(binding(node), seen);
    if (ts.isPropertyAssignment(node)) return resolve(node.initializer, seen);
    if (ts.isShorthandPropertyAssignment(node)) return resolve(node.name, seen);
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "Object" && node.expression.name.text === "freeze") return resolve(node.arguments[0], seen);
      const fn = resolve(node.expression, seen);
      if (fn && ts.isFunctionLike(fn)) {
        const values = returns(fn);
        if (values.length === 1) return resolve(values[0], seen);
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = resolve(node.expression, seen);
      return object && ts.isObjectLiteralExpression(object) ? resolve(property(object, node.name.text), seen) : undefined;
    }
    return node;
  };
  const cleanup = (input, seen = new Set()) => {
    const fn = resolve(input);
    if (!fn || !ts.isFunctionLike(fn) || !fn.body || fn.asteriskToken || seen.has(fn)) return false;
    seen = new Set(seen).add(fn);
    let found = false;
    const visit = node => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const local = resolve(node.expression);
        if (local && ts.isFunctionLike(local)) found ||= cleanup(local, seen);
        else {
          const callee = node.expression.getText();
          // Logging and fulfilled empty wrappers do not release an owner.
          if (!/^(?:console|JSON|Math|Promise|Object)\./.test(callee)
            && !/^(?:String|Number|Boolean|Error)$/.test(callee)) found = true;
        }
        if (ts.isPropertyAccessExpression(node.expression) && ["then", "finally", "catch"].includes(node.expression.name.text)) {
          found ||= node.arguments.some(argument => cleanup(argument, seen));
        }
      }
      ts.forEachChild(node, visit);
    };
    if (ts.isBlock(fn.body)) ts.forEachChild(fn.body, visit); else visit(fn.body);
    return found;
  };
  const publication = argument => {
    const object = resolve(argument);
    if (!object || !ts.isObjectLiteralExpression(object)) return false;
    return ["publish", "rollback"].every(name => {
      const fn = resolve(property(object, name));
      return fn && ts.isFunctionLike(fn) && Boolean(fn.body);
    }) && cleanup(property(object, "retire"));
  };
  const activations = [];
  const find = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "definePlugin") {
      const object = resolve(node.arguments[0]);
      if (object && ts.isObjectLiteralExpression(object)) {
        const activate = resolve(property(object, "activate"));
        if (activate && ts.isFunctionLike(activate) && activate.body && ts.isIdentifier(activate.parameters[0]?.name)) activations.push(activate);
      }
    }
    ts.forEachChild(node, find);
  };
  find(file);
  return activations.some(activate => {
    const context = activate.parameters[0].name.text;
    let found = false;
    const visit = node => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && ts.isIdentifier(node.expression.expression.expression)
        && node.expression.expression.expression.text === context
        && bindingOwner(node.expression.expression.expression) === activate) {
        const namespace = node.expression.expression.name.text, method = node.expression.name.text;
        if (namespace === "publication" && method === "add") found ||= publication(node.arguments[0]);
        if (namespace === "effects" && method === "adopt") found ||= cleanup(node.arguments[0]);
        if (namespace === "effects" && method === "add") {
          const starter = resolve(node.arguments[0]);
          if (starter && ts.isFunctionLike(starter) && !starter.asteriskToken) found ||= returns(starter).some(value => cleanup(value));
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(activate.body, visit);
    return found;
  });
}
