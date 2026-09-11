import ts from "typescript";
import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const prefix = "__rabiAutomaticCode";

export function compileAutomaticCode(source, moduleId, runtimeImport) {
  const parsed = ts.createSourceFile(moduleId, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, "\n"));
  if (source.includes(prefix)) throw new Error("Reserved automatic-code identifier or already instrumented input.");
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, parsed);
  const implementations = Object.create(null);
  const closureShapes = Object.create(null);
  const unsupported = [];
  const selected = new Map();
  const inspect = (declaration, id) => {
    if (!declaration.body) return;
    let reason = declaration.asteriskToken ? "generator execution requires an iterator boundary" : undefined;
    const visit = node => {
      if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isPrivateIdentifier(node)) reason = "private fields or super require a class-owned migration";
      if (ts.isMetaProperty(node)) reason = "lexical meta properties cannot move into a patch factory";
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") reason = "direct eval requires its original lexical scope";
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    if (reason) { unsupported.push({ symbol: id, reason }); return; }
    const closures = [];
    const bindings = [];
    const inspectClosures = node => {
      if (node !== declaration && ts.isFunctionLike(node)) {
        closures.push(print(node));
        return;
      }
      if (ts.isVariableDeclaration(node)) bindings.push(print(node.name));
      ts.forEachChild(node, inspectClosures);
    };
    inspectClosures(declaration);
    if (closures.length) {
      closureShapes[id] = { closures, bindings };
      unsupported.push({ symbol: id, reason: "Existing captured callbacks require unchanged closure bodies and binding layout." });
    }
    const modifiers = declaration.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
    const implementation = ts.factory.createFunctionExpression(modifiers, undefined, undefined, undefined, declaration.parameters, undefined, declaration.body);
    implementations[id] = print(implementation);
    selected.set(declaration, id);
  };
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) inspect(statement, statement.name.text);
    if (ts.isClassDeclaration(statement) && statement.name) {
      for (const member of statement.members) {
        if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
          inspect(member, `${statement.name.text}.${member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) ? "static." : ""}${member.name.text}`);
        }
      }
    }
  }
  const transform = skeleton => context => {
    const visit = node => {
      const id = selected.get(node);
      if (id) {
        const parameters = skeleton ? node.parameters : node.parameters.map((parameter, index) => ts.factory.createParameterDeclaration(
          undefined, parameter.dotDotDotToken, `${prefix}Arg${index}`, undefined, undefined,
          parameter.initializer ? ts.factory.createIdentifier("undefined") : undefined));
        const expression = ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(
          ts.factory.createParenthesizedExpression(ts.factory.createBinaryExpression(ts.factory.createIdentifier(prefix), ts.SyntaxKind.QuestionQuestionEqualsToken,
            ts.factory.createCallExpression(ts.factory.createIdentifier(`${prefix}Register`), undefined, [ts.factory.createStringLiteral(moduleId), ts.factory.createCallExpression(ts.factory.createIdentifier(`${prefix}Definition`), undefined, []), ts.factory.createArrowFunction(undefined, undefined, [ts.factory.createParameterDeclaration(undefined, undefined, `${prefix}Source`)], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.factory.createCallExpression(ts.factory.createIdentifier("eval"), undefined, [ts.factory.createIdentifier(`${prefix}Source`)]))]))), "invoke"), undefined,
          [ts.factory.createStringLiteral(id), ts.factory.createThis(), ts.factory.createIdentifier("arguments")]);
        const body = skeleton ? ts.factory.createBlock([]) : ts.factory.createBlock([ts.factory.createReturnStatement(expression)], true);
        if (ts.isFunctionDeclaration(node)) return ts.factory.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, parameters, node.type, body);
        return ts.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, parameters, node.type, body);
      }
      return ts.visitEachChild(node, visit, context);
    };
    return node => ts.visitNode(node, visit);
  };
  const render = skeleton => {
    const result = ts.transform(parsed, [transform(skeleton)]);
    try { return printer.printFile(result.transformed[0]); } finally { result.dispose(); }
  };
  const definition = { moduleId, sourceHash: hash(source), shapeHash: hash(JSON.stringify([render(true), closureShapes])), implementations, unsupported };
  const output = Object.keys(implementations).length && runtimeImport
    ? `import { registerAutomaticCode as ${prefix}Register } from ${JSON.stringify(runtimeImport)};\nvar ${prefix};\nfunction ${prefix}Definition() { return ${JSON.stringify(definition).replaceAll('"__proto__":', '["__proto__"]:')}; }\n${render(false)}`
    : source;
  return { definition, output };
}
