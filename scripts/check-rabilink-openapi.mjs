import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const candidates = [
  {
    file: "docs/rokid-rabilink-plugin.CURRENT.openapi.json",
    serverUrl: "https://rabi.example.com",
    requiresSecurityScheme: true,
  },
  {
    file: "docs/rokid-rabilink-plugin.MANUAL_AUTH.openapi.json",
    serverUrl: "https://rabi.example.com",
    requiresSecurityScheme: false,
  },
];

const requiredPaths = [
  ["/rokid/rabilink/tasks", "post"],
  ["/rokid/rabilink/tasks/{taskId}", "get"],
  ["/rokid/rabilink/messages", "get"],
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
  const document = readJson(candidate.file);

  assert(document.openapi?.startsWith("3."), `${candidate.file}: openapi must be 3.x.`);
  assert(document.info?.title === "RabiLinkMessage", `${candidate.file}: title must be RabiLinkMessage.`);
  assert(document.servers?.[0]?.url === candidate.serverUrl, `${candidate.file}: server URL must be ${candidate.serverUrl}.`);

  for (const [routePath, method] of requiredPaths) {
    const operation = getOperation(document, routePath, method);
    assert(operation, `${candidate.file}: missing ${method.toUpperCase()} ${routePath}.`);
    validateResponses(candidate.file, operation, routePath, method);
    if (method === "get") {
      assert(!operation.requestBody, `${candidate.file}: GET ${routePath} must not define requestBody.`);
    }
  }

  const messagesGet = getOperation(document, "/rokid/rabilink/messages", "get");
  const messageParamNames = new Set((messagesGet.parameters || []).map((parameter) => parameter.name));
  assert(messageParamNames.has("after"), `${candidate.file}: GET /rokid/rabilink/messages should expose after cursor.`);
  assert(!messageParamNames.has("taskId"), `${candidate.file}: GET /rokid/rabilink/messages must not require taskId.`);

  const hasSecurityScheme = Boolean(document.components?.securitySchemes?.RabiLinkToken);
  if (candidate.requiresSecurityScheme) {
    assert(hasSecurityScheme, `${candidate.file}: expected RabiLinkToken security scheme.`);
  } else {
    assert(!hasSecurityScheme, `${candidate.file}: manual-auth OpenAPI must not define RabiLinkToken security scheme.`);
  }

  return {
    file: candidate.file,
    title: document.info.title,
    serverUrl: document.servers[0].url,
    security: hasSecurityScheme ? "openapi" : "manual",
  };
}

try {
  const results = candidates.map(validateDocument);
  for (const result of results) {
    console.log(`[ok] ${result.file} title=${result.title} server=${result.serverUrl} auth=${result.security}`);
  }
} catch (error) {
  console.error(`[fail] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
