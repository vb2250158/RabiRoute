import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const STANDARD_ACTIONS = [
  "send_private_msg", "send_group_msg", "send_msg", "delete_msg", "get_msg", "get_forward_msg",
  "send_like", "set_group_kick", "set_group_ban", "set_group_anonymous_ban", "set_group_whole_ban",
  "set_group_admin", "set_group_anonymous", "set_group_card", "set_group_name", "set_group_leave",
  "set_group_special_title", "set_friend_add_request", "set_group_add_request", "get_login_info",
  "get_stranger_info", "get_friend_list", "get_group_info", "get_group_list", "get_group_member_info",
  "get_group_member_list", "get_group_honor_info", "get_cookies", "get_csrf_token", "get_credentials",
  "get_record", "get_image", "can_send_image", "can_send_record", "get_status", "get_version_info",
  "set_restart", "clean_cache", ".handle_quick_operation",
];
const SELECTORS = ["post_type", "notice_type", "sub_type", "request_type", "meta_event_type", "message_type"];
const SOURCE_REFERENCE = {
  repository: "https://github.com/NapNeko/NapCatQQ",
  currentMainCommit: "105f38e3ecb1428c147e0f9165f65f854233d988",
  currentMainStatus: "README-only",
  currentMainTree: "https://api.github.com/repos/NapNeko/NapCatQQ/git/trees/105f38e3ecb1428c147e0f9165f65f854233d988?recursive=1",
  standardRepository: "https://github.com/botuniverse/onebot-11",
  standardCommit: "d4456ee706f9ada9c2dfde56a2bcfc69752600e4",
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function createReader(source) {
  const file = ts.createSourceFile("napcat.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const variables = new Map();
  const classes = new Map();
  const functions = new Map();
  const calls = [];
  let registry;
  const line = node => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const text = node => node?.getText(file);
  function className(node) {
    return node.name?.text ?? (ts.isVariableDeclaration(node.parent) ? text(node.parent.name) : undefined);
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const topLevel = ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent);
      if (topLevel || !variables.has(node.name.text)) variables.set(node.name.text, node.initializer);
      if (node.name.text === "actionHandlers" && ts.isArrayLiteralExpression(node.initializer)) registry = node.initializer;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes.set(className(node), node);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  function evaluate(node, seen = new Set()) {
    if (!node) throw new Error("missing schema declaration");
    if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, seen);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isVoidExpression(node)) return { "x-upstream-schema-absent": true };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isBinaryExpression(node)) {
      const left = evaluate(node.left, seen);
      const right = evaluate(node.right, seen);
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AsteriskToken: return left * right;
        case ts.SyntaxKind.PlusToken: return left + right;
        case ts.SyntaxKind.MinusToken: return left - right;
        default: throw new Error("unsupported arithmetic expression");
      }
    }
    if (ts.isIdentifier(node)) {
      if (!variables.has(node.text) || seen.has(node.text)) throw new Error(`unresolved identifier ${node.text}`);
      return evaluate(variables.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(item => evaluate(item, seen));
    if (ts.isObjectLiteralExpression(node)) {
      const result = {};
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(result, evaluate(property.expression, seen));
        else if (ts.isPropertyAssignment(property)) result[property.name.text ?? text(property.name)] = evaluate(property.initializer, seen);
        else throw new Error("unsupported object property");
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = evaluate(node.expression, seen);
      if (object && Object.hasOwn(object, node.name.text)) return object[node.name.text];
      throw new Error(`unresolved property ${text(node)}`);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && text(node.expression.expression) === "Type") {
      return evaluateType(node.expression.name.text, node.arguments, seen);
    }
    // esbuild string enums contain only literal assignments and a return statement.
    if (ts.isCallExpression(node) && ts.isParenthesizedExpression(node.expression) && ts.isArrowFunction(node.expression.expression)) {
      const fn = node.expression.expression;
      const parameter = text(fn.parameters[0]?.name);
      const result = {};
      if (!ts.isBlock(fn.body)) throw new Error("unsupported enum body");
      for (const statement of fn.body.statements) {
        if (ts.isReturnStatement(statement)) continue;
        const expression = statement.expression;
        if (!expression || !ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isElementAccessExpression(expression.left) || text(expression.left.expression) !== parameter ||
            !ts.isStringLiteral(expression.left.argumentExpression) || !ts.isStringLiteral(expression.right)) {
          throw new Error("unsupported enum assignment");
        }
        result[expression.left.argumentExpression.text] = expression.right.text;
      }
      return result;
    }
    throw new Error(`unsupported ${ts.SyntaxKind[node.kind]}`);
  }
  function evaluateType(kind, args, seen) {
    const value = index => evaluate(args[index], seen);
    const options = index => args[index] ? value(index) : {};
    const scalar = { String: "string", Number: "number", Integer: "integer", Boolean: "boolean", Null: "null" };
    if (Object.hasOwn(scalar, kind)) return { type: scalar[kind], ...options(0) };
    switch (kind) {
      case "Any": case "Unknown": return { ...options(0) };
      case "Undefined": case "Void": return { "x-typebox-kind": kind, ...options(0) };
      case "Optional": return { ...value(0), "x-typebox-optional": true };
      case "Union": return { anyOf: value(0), ...options(1) };
      case "Intersect": return { allOf: value(0), ...options(1) };
      case "Array": return { type: "array", items: value(0), ...options(1) };
      case "Literal": return { const: value(0), type: typeof value(0), ...options(1) };
      case "Object": {
        const properties = value(0);
        const required = Object.keys(properties).filter(key => !properties[key]["x-typebox-optional"]);
        return { type: "object", properties, ...(required.length ? { required } : {}), ...options(1) };
      }
      case "Omit": case "Pick": {
        const original = value(0);
        const keys = value(1);
        const keep = key => kind === "Omit" ? !keys.includes(key) : keys.includes(key);
        return { ...original, properties: Object.fromEntries(Object.entries(original.properties).filter(([key]) => keep(key))),
          required: (original.required ?? []).filter(keep), ...options(2) };
      }
      case "Enum": {
        const enumeration = value(0);
        return { enum: Object.values(enumeration).filter(item => typeof item === "number" || !Object.hasOwn(enumeration, item)), ...options(1) };
      }
      case "Record": return { type: "object", additionalProperties: value(1), "x-typebox-key": value(0), ...options(2) };
      default: throw new Error(`unsupported Type.${kind}`);
    }
  }
  function contract(node) {
    try {
      return { resolved: true, schema: evaluate(node), line: node ? line(node) : null };
    } catch (error) {
      return { resolved: false, schema: null, line: node ? line(node) : null, reason: error.message };
    }
  }
  function properties(node, seen = new Set()) {
    if (!node || seen.has(node)) return {};
    seen.add(node);
    const base = text(node.heritageClauses?.[0]?.types?.[0]?.expression);
    const result = { ...properties(classes.get(base), seen) };
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && member.initializer) result[text(member.name)] = member.initializer;
    }
    return result;
  }
  return { file, variables, classes, functions, calls, registry, line, text, evaluate, contract, properties };
}

function extractActions(reader) {
  const { registry, calls, classes, functions, evaluate, properties, text, line, contract } = reader;
  if (!registry) throw new Error("NapCat actionHandlers registry was not found");
  const explicit = registry.elements.filter(ts.isNewExpression).map(node => ({ className: text(node.expression), line: line(node) }));
  const automatic = calls.filter(node => text(node.expression)?.startsWith("__decorateClass") && node.arguments[0] &&
    ts.isArrayLiteralExpression(node.arguments[0]) && node.arguments[0].elements.some(item => text(item) === "ActionHandler"))
    .map(node => ({ className: text(node.arguments[1]), line: line(node) }));
  const aliasSuffixes = new Set();
  const registrationFunction = [...functions.values()].find(node => node.name.text.startsWith("createActionMap") && text(node).includes("AutoRegisterRouter"));
  function findAliases(node) {
    if (ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length === 1) {
      const suffix = node.templateSpans[0].literal.text;
      if (suffix === "_async" || suffix === "_rate_limited") aliasSuffixes.add(suffix);
    }
    ts.forEachChild(node, findAliases);
  }
  if (registrationFunction) findAliases(registrationFunction);
  const registrations = [...explicit, ...automatic];
  const actions = [];
  for (const className of [...new Set(registrations.map(item => item.className))].sort()) {
    const node = classes.get(className);
    if (!node) throw new Error(`Registered action class ${className} was not found`);
    const fields = properties(node);
    const action = evaluate(fields.actionName);
    if (typeof action !== "string") throw new Error(`Registered class ${className} has no static action name`);
    function metadata(key) {
      try { return fields[key] ? evaluate(fields[key]) : null; } catch { return null; }
    }
    actions.push({ action, registered: true, aliases: [...aliasSuffixes].sort().map(suffix => action + suffix), className, line: line(node),
      registrationLines: registrations.filter(item => item.className === className).map(item => item.line).sort((a, b) => a - b),
      autoRegistered: automatic.some(item => item.className === className), testOnly: /^test_auto_register_/.test(action),
      summary: metadata("actionSummary"), description: metadata("actionDescription"), tags: metadata("actionTags"),
      payloadContract: contract(fields.payloadSchema), returnContract: contract(fields.returnSchema) });
  }
  actions.sort((left, right) => left.action.localeCompare(right.action, "en"));
  const constants = evaluate(reader.variables.get("ActionName"));
  return { actions, explicit, automatic, constants };
}

function extractWebui(reader) {
  const mounts = [];
  const routes = [];
  for (const call of reader.calls) {
    if (!ts.isPropertyAccessExpression(call.expression) || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0])) continue;
    const receiver = reader.text(call.expression.expression);
    const method = call.expression.name.text;
    if (!/^(router|app)/.test(receiver) || !["get", "post", "put", "patch", "delete", "all", "use", "ws"].includes(method)) continue;
    const handlers = call.arguments.slice(1).map(node => ts.isIdentifier(node) ? node.text : ts.isCallExpression(node) ? reader.text(node.expression) : "inline");
    const row = { receiver, method: method.toUpperCase(), path: call.arguments[0].text, handlers, line: reader.line(call) };
    (method === "use" ? mounts : routes).push(row);
  }
  function ascend(receiver, suffix, lines, seen = new Set()) {
    if (seen.has(receiver)) return [];
    const found = [];
    for (const mount of mounts.filter(item => item.handlers.includes(receiver))) {
      const next = mount.path + suffix;
      if (mount.receiver === "app") found.push({ path: next, mountLines: [...lines, mount.line] });
      else found.push(...ascend(mount.receiver, next, [...lines, mount.line], new Set([...seen, receiver])));
    }
    return found;
  }
  const result = [];
  for (const route of routes) {
    const paths = route.receiver === "app" ? [{ path: route.path, mountLines: [] }] : ascend(route.receiver, route.path, []);
    for (const full of paths) result.push({ method: route.method, path: full.path, line: route.line,
      handlerNames: route.handlers, mountLines: full.mountLines.sort((a, b) => a - b), kind: full.path.startsWith("/api/") ? "api" : "page" });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path, "en") || left.method.localeCompare(right.method, "en"));
}

function extractEvents(reader) {
  function derivesFromEvent(node, seen = new Set()) {
    if (!node || seen.has(node)) return false;
    const base = reader.text(node.heritageClauses?.[0]?.types?.[0]?.expression);
    return base === "OneBotEvent" || derivesFromEvent(reader.classes.get(base), new Set([...seen, node]));
  }
  const instantiations = new Map();
  function findNew(node) {
    if (ts.isNewExpression(node)) {
      const name = reader.text(node.expression);
      instantiations.set(name, [...(instantiations.get(name) ?? []), reader.line(node)]);
    }
    ts.forEachChild(node, findNew);
  }
  findNew(reader.file);
  function eventFields(node, seen = new Set()) {
    if (!node || seen.has(node)) return { names: [], selectorAssignments: [] };
    const base = reader.text(node.heritageClauses?.[0]?.types?.[0]?.expression);
    const inherited = eventFields(reader.classes.get(base), new Set([...seen, node]));
    const names = new Set(inherited.names);
    const selectorAssignments = [...inherited.selectorAssignments];
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member)) names.add(reader.text(member.name));
      if (!ts.isConstructorDeclaration(member)) continue;
      function findAssignment(statement) {
        if (ts.isBinaryExpression(statement) && statement.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(statement.left) && statement.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const name = statement.left.name.text;
          names.add(name);
          if (SELECTORS.includes(name)) selectorAssignments.push({ name, line: reader.line(statement) });
        }
        ts.forEachChild(statement, findAssignment);
      }
      findAssignment(member);
    }
    return { names: [...names].sort(), selectorAssignments };
  }
  const events = [];
  for (const [className, node] of reader.classes) {
    if (!derivesFromEvent(node)) continue;
    const fields = reader.properties(node);
    const inheritedFields = eventFields(node);
    const selectors = {};
    for (const key of SELECTORS) {
      if (!fields[key]) continue;
      try { selectors[key] = { resolved: true, value: reader.evaluate(fields[key]) }; }
      catch { selectors[key] = { resolved: false }; }
    }
    for (const key of SELECTORS) {
      const assignmentLines = inheritedFields.selectorAssignments.filter(item => item.name === key).map(item => item.line);
      if (!assignmentLines.length) continue;
      selectors[key] = { resolved: false, ...(selectors[key]?.resolved ? { initialValue: selectors[key].value } : {}), assignmentLines };
    }
    events.push({ className, line: reader.line(node), base: reader.text(node.heritageClauses?.[0]?.types?.[0]?.expression),
      fields: inheritedFields.names, declaredFields: node.members.filter(ts.isPropertyDeclaration).map(member => reader.text(member.name)).sort(),
      selectors, instantiated: instantiations.has(className), instantiationLines: instantiations.get(className) ?? [] });
  }
  const messageProjections = [];
  function findMessageProjection(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const keys = properties.map(item => reader.text(item.name));
      const postType = properties.find(item => reader.text(item.name) === "post_type")?.initializer;
      if (postType && !ts.isCallExpression(postType) && keys.includes("message_type") && keys.includes("message_id")) {
        messageProjections.push({ line: reader.line(node), fields: keys.sort(), selectors: { message_type: ["group", "private"], post_type: ["message", "message_sent"] } });
      }
    }
    ts.forEachChild(node, findMessageProjection);
  }
  findMessageProjection(reader.file);
  return { events: events.sort((a, b) => a.className.localeCompare(b.className, "en")), messageProjections };
}

export function auditNapcatBundle(source, { version, expectedSha256, catalog } = {}) {
  const bundleSha256 = sha256(source);
  if (!version || !expectedSha256) throw new Error("Explicit version and SHA256 are required");
  if (bundleSha256 !== expectedSha256.toLowerCase()) throw new Error("NapCat bundle SHA256 mismatch");
  const reader = createReader(source);
  const declaredVersion = reader.variables.get("napCatVersion");
  const versionLiterals = [];
  function findVersionLiterals(node) {
    if (ts.isStringLiteral(node)) versionLiterals.push(node.text);
    ts.forEachChild(node, findVersionLiterals);
  }
  if (declaredVersion) {
    findVersionLiterals(declaredVersion);
    if (!versionLiterals.includes(version)) throw new Error("NapCat declared version mismatch");
  }
  const { actions, explicit, constants } = extractActions(reader);
  const webuiRoutes = extractWebui(reader);
  const { events, messageProjections } = extractEvents(reader);
  const actionNames = new Set(actions.map(item => item.action));
  const rows = catalog?.rows ?? catalog?.items ?? [];
  const coverage = actions.map(item => ({ action: item.action, operationIds: [...new Set(rows.filter(row =>
    Array.isArray(row.upstreamOneBotActions) && row.upstreamOneBotActions.includes(item.action)).map(row => row.operationId))].sort() }));
  const referencedActions = [...new Set(rows.flatMap(row => row.upstreamOneBotActions ?? []))].sort();
  const unregisteredReferences = referencedActions.filter(action => !actionNames.has(action)).map(action => ({ action,
    operationIds: [...new Set(rows.filter(row => row.upstreamOneBotActions?.includes(action)).map(row => row.operationId))].sort() }));
  const referencedWebuiPaths = new Set(catalog?.webuiKnownActions ?? []);
  const webuiCoverage = webuiRoutes.filter(item => item.kind === "api").map(item => ({ method: item.method, path: item.path,
    referencedPathInSnapshot: referencedWebuiPaths.has(item.path) }));
  const unresolvedSchemas = actions.flatMap(item => ["payloadContract", "returnContract"].filter(key => !item[key].resolved)
    .map(key => ({ action: item.action, contract: key, reason: item[key].reason })));
  return {
    schemaVersion: 1,
    source: { version, bundleSha256, kind: "official-distribution-public-code", versionDeclarationLine: declaredVersion ? reader.line(declaredVersion) : null,
      versionDeclarationLiterals: versionLiterals, upstream: SOURCE_REFERENCE },
    counts: { registeredBaseActions: actions.length, businessActions: actions.filter(item => !item.testOnly).length,
      testActions: actions.filter(item => item.testOnly).length, registeredNamesIncludingAliases: new Set(actions.flatMap(item => [item.action, ...item.aliases])).size,
      explicitRegistryEntries: explicit.length, duplicateRegistryEntries: explicit.length - new Set(explicit.map(item => item.className)).size,
      webuiApiRoutes: webuiRoutes.filter(item => item.kind === "api").length, pageRoutes: webuiRoutes.filter(item => item.kind === "page").length,
      eventClasses: events.length, instantiatedEventClasses: events.filter(item => item.instantiated).length,
      eventBaseClasses: events.filter(item => !item.instantiated).length, messageEventProjections: messageProjections.length,
      unresolvedSchemas: unresolvedSchemas.length },
    actions, webuiRoutes, events, messageProjections,
    unresolvedSchemas,
    unregisteredActionConstants: Object.entries(constants).filter(([, action]) => !actionNames.has(action)).map(([name, action]) => ({ name, action })).sort((a, b) => a.action.localeCompare(b.action, "en")),
    standardComparison: { sourceCommit: SOURCE_REFERENCE.standardCommit, standardActionCount: STANDARD_ACTIONS.length,
      registered: STANDARD_ACTIONS.filter(action => actionNames.has(action)).sort(), absent: STANDARD_ACTIONS.filter(action => !actionNames.has(action)).sort() },
    groupJoining: { registeredActionsContainingJoin: actions.filter(item => /join/i.test(item.action)).map(item => item.action),
      activeApplicationAction: null, assessment: version === "4.18.4" ? "No self-initiated group-join action in the registered OneBot API. Existing request/invitation handling uses set_group_add_request." : "Review version-specific native handlers before assigning join semantics.",
      requestHandler: actionNames.has("set_group_add_request") ? "set_group_add_request" : null },
    ...(catalog ? { rabiCoverage: { sourceSnapshotSha256: sha256(JSON.stringify(catalog)), rows: coverage,
      coveredBaseActions: coverage.filter(item => item.operationIds.length).length, unregisteredReferences,
      webuiRoutes: webuiCoverage, referencedWebuiPaths: webuiCoverage.filter(item => item.referencedPathInSnapshot).length,
      unregisteredWebuiPathReferences: [...referencedWebuiPaths].filter(reference => !webuiCoverage.some(item => item.path === reference)).sort(),
      webuiCoverageEvidence: "Path references from the supplied native-owner snapshot. Method-level runtime use requires separate evidence." } } : {}),
  };
}

/** Reconcile implementation declarations with the extracted native API denominator. */
export function auditNapcatWebuiCoverage(facts, declaration) {
  if (declaration?.source?.version !== facts.source.version || declaration?.source?.bundleSha256 !== facts.source.bundleSha256) {
    throw new Error("WebUI coverage source identity mismatch");
  }
  const native = new Set(facts.webuiRoutes.filter(row => row.kind === "api").map(row => `${row.method} ${row.path}`));
  const states = ["typed-summary", "existing-native-owner", "typed-management", "owner-dependency", "host-owner-boundary"];
  const seen = new Set();
  const byState = Object.fromEntries(states.map(state => [state, 0]));
  const byInventoryGroup = {};
  const byInventoryGroupAndState = {};
  for (const row of declaration.rows ?? []) {
    const key = `${row.method} ${row.path}`;
    if (!native.has(key) || seen.has(key)) throw new Error("Unknown or duplicate method/path in WebUI coverage");
    if (!states.includes(row.state)) throw new Error("Unknown WebUI implementation state");
    if (row.runtimeAcceptance !== "not-asserted-by-this-static-manifest") throw new Error("Static WebUI coverage cannot assert runtime acceptance");
    if (!row.permission || !row.callShape || !row.implementation) throw new Error("WebUI owner contract metadata is missing");
    if (["owner-dependency", "host-owner-boundary"].includes(row.state) && !row.dependencies?.length) throw new Error("Pending WebUI owner requires a concrete dependency");
    seen.add(key);
    byState[row.state]++;
    byInventoryGroup[row.inventoryGroup] = (byInventoryGroup[row.inventoryGroup] ?? 0) + 1;
    const group = byInventoryGroupAndState[row.inventoryGroup] ??= {};
    group[row.state] = (group[row.state] ?? 0) + 1;
  }
  if (seen.size !== native.size) throw new Error("WebUI coverage has missing native API rows");
  if (declaration.counts?.total !== seen.size || states.some(state => (declaration.counts?.byState?.[state] ?? 0) !== byState[state])) {
    throw new Error("WebUI coverage declared counts do not match its rows");
  }
  const sameCounts = (declared, actual) => JSON.stringify(Object.entries(declared ?? {}).sort()) === JSON.stringify(Object.entries(actual).sort());
  if (!sameCounts(declaration.counts.byInventoryGroup, byInventoryGroup) || Object.keys(byInventoryGroupAndState).some(group =>
    !sameCounts(declaration.counts.byInventoryGroupAndState?.[group], byInventoryGroupAndState[group]))) {
    throw new Error("WebUI inventory/source group counts do not match its rows");
  }
  const receiptOperations = declaration.rabiOnlyOperations ?? [];
  const receiptIds = new Set();
  for (const operation of receiptOperations) {
    if (!operation.operationId || receiptIds.has(operation.operationId) || !operation.path?.startsWith("/api/agent/")
      || operation.nativeCoverageContribution !== 0 || native.has(`${operation.method} ${operation.path}`)) {
      throw new Error("Rabi-only receipts cannot contribute native WebUI coverage");
    }
    if (operation.runtimeAcceptance !== "not-asserted-by-this-static-manifest") throw new Error("Static WebUI coverage cannot assert runtime acceptance");
    receiptIds.add(operation.operationId);
  }
  const implementedSourceRows = byState["typed-summary"] + byState["existing-native-owner"] + byState["typed-management"];
  if (declaration.counts.implementedSourceRows !== implementedSourceRows || declaration.counts.pendingProtectedOwnerRows !== byState["owner-dependency"]
    || declaration.counts.hostOwnerBoundaryRows !== byState["host-owner-boundary"] || declaration.counts.rabiOnlyOperations !== receiptOperations.length) {
    throw new Error("WebUI implementation/receipt counts do not match its rows");
  }
  return { source: declaration.source, implementationRelease: declaration.implementationRelease,
    counts: { total: seen.size, byState, byInventoryGroup, byInventoryGroupAndState, implementedSourceRows,
      pendingProtectedOwnerRows: byState["owner-dependency"], hostOwnerBoundaryRows: byState["host-owner-boundary"], rabiOnlyOperations: receiptOperations.length, duplicateMethodPaths: 0 },
    rows: declaration.rows, rabiOnlyOperations: receiptOperations };
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!["--bundle", "--version", "--sha256", "--rabi-catalog", "--webui-coverage", "--output"].includes(key) || !args[index + 1]) throw new Error(`Invalid argument ${key}`);
    options[key.slice(2)] = args[index + 1];
  }
  if (!options.bundle || !options.output) throw new Error("Usage: --bundle <file> --version <version> --sha256 <digest> [--rabi-catalog <snapshot>] --output <json>");
  const source = await fs.readFile(options.bundle, "utf8");
  const catalog = options["rabi-catalog"] ? JSON.parse(await fs.readFile(options["rabi-catalog"], "utf8")) : undefined;
  const result = auditNapcatBundle(source, { version: options.version, expectedSha256: options.sha256, catalog });
  if (options["webui-coverage"]) result.webuiCoverage = auditNapcatWebuiCoverage(result, JSON.parse(await fs.readFile(options["webui-coverage"], "utf8")));
  await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await fs.writeFile(options.output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result.counts));
  if (result.unresolvedSchemas.length) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
