import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const candidates = [
  {
    file: "examples/rabilink-relay/rokid-rabilink-plugin.CURRENT.example.json",
    serverUrl: "https://rabi.example.com",
    requiresSecurityScheme: true,
  },
  {
    file: "examples/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.example.json",
    serverUrl: "https://rabi.example.com",
    requiresSecurityScheme: false,
  },
  {
    file: "data/rabilink-relay/rokid-rabilink-plugin.CURRENT.openapi.json",
    requiresSecurityScheme: true,
    rejectExampleServer: true,
    optional: true,
  },
  {
    file: "data/rabilink-relay/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json",
    requiresSecurityScheme: false,
    rejectExampleServer: true,
    optional: true,
  },
];

const requiredPaths = [
  ["/rokid/rabilink/tasks", "post"],
  ["/rokid/rabilink/tasks/{taskId}/messages", "get"],
  ["/rokid/rabilink/tasks/{taskId}", "get"],
];

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function getOperation(document, routePath, method) {
  return document.paths?.[routePath]?.[method];
}

function validateResponses(relativePath, operation, routePath, method) {
  const responseKeys = Object.keys(operation.responses || {});
  assert(
    responseKeys.length > 0,
    `${relativePath}: ${method.toUpperCase()} ${routePath} has no responses.`,
  );
  assert(
    responseKeys.every((status) => status === "200"),
    `${relativePath}: ${method.toUpperCase()} ${routePath} must only define 200 responses, got ${responseKeys.join(", ")}.`,
  );
  const content = operation.responses["200"]?.content;
  assert(
    content?.["application/json"]?.schema,
    `${relativePath}: ${method.toUpperCase()} ${routePath} 200 response must define application/json schema.`,
  );
}

function validateDocument(candidate) {
  const absolutePath = path.join(repoRoot, candidate.file);
  if (candidate.optional && !fs.existsSync(absolutePath)) {
    return null;
  }
  const document = readJson(candidate.file);
  const actualServerUrl = document.servers?.[0]?.url || "";
  const expectedServerUrl = candidate.serverUrl || actualServerUrl;

  assert(document.openapi?.startsWith("3."), `${candidate.file}: openapi must be 3.x.`);
  assert(document.info?.title === "RabiLinkMessage", `${candidate.file}: title must be RabiLinkMessage.`);
  assert(actualServerUrl === expectedServerUrl, `${candidate.file}: server URL must be ${expectedServerUrl}.`);
  if (candidate.rejectExampleServer) {
    assert(!actualServerUrl.includes("example.com"), `${candidate.file}: data OpenAPI must use the real relay URL, not ${actualServerUrl}.`);
  }

  for (const [routePath, method] of requiredPaths) {
    const operation = getOperation(document, routePath, method);
    assert(operation, `${candidate.file}: missing ${method.toUpperCase()} ${routePath}.`);
    validateResponses(candidate.file, operation, routePath, method);
    if (method === "get") {
      assert(!operation.requestBody, `${candidate.file}: GET ${routePath} must not define requestBody.`);
    }
  }

  assert(!getOperation(document, "/rokid/rabilink/messages", "get"), `${candidate.file}: global GET /rokid/rabilink/messages should not be exposed in the Rokid plugin; use taskId messages.`);

  const messagesGet = getOperation(document, "/rokid/rabilink/tasks/{taskId}/messages", "get");
  const messageParamNames = new Set((messagesGet.parameters || []).map((parameter) => parameter.name));
  assert(messageParamNames.has("taskId"), `${candidate.file}: GET /rokid/rabilink/tasks/{taskId}/messages should require taskId.`);
  assert(messageParamNames.has("after"), `${candidate.file}: GET /rokid/rabilink/tasks/{taskId}/messages should expose after cursor.`);

  const hasSecurityScheme = Boolean(document.components?.securitySchemes?.RabiLinkToken);
  if (candidate.requiresSecurityScheme) {
    assert(hasSecurityScheme, `${candidate.file}: expected RabiLinkToken security scheme.`);
  } else {
    assert(!hasSecurityScheme, `${candidate.file}: manual-auth OpenAPI must not define RabiLinkToken security scheme.`);
  }

  return {
    file: candidate.file,
    title: document.info.title,
    serverUrl: actualServerUrl,
    security: hasSecurityScheme ? "openapi" : "manual",
  };
}

try {
  const results = candidates.map(validateDocument).filter(Boolean);
  for (const result of results) {
    console.log(`[ok] ${result.file} title=${result.title} server=${result.serverUrl} auth=${result.security}`);
  }
} catch (error) {
  console.error(`[fail] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
