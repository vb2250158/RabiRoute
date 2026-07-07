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

const toolImportCandidates = [
  {
    file: "examples/rabilink-relay/rokid-rabilink-tools-import.example.json",
    serverUrl: "https://rabi.example.com",
  },
  {
    file: "data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.openapi.json",
    rejectExampleServer: true,
    optional: true,
  },
];

const toolImportPostmanCandidates = [
  {
    file: "examples/rabilink-relay/rokid-rabilink-tools-import.example.postman.json",
    serverUrl: "https://rabi.example.com",
  },
  {
    file: "data/rabilink-relay/rokid-rabilink-tools-import.CURRENT.postman.json",
    rejectExampleServer: true,
    allowHttp: true,
    optional: true,
  },
];

const requiredPaths = [
  ["/rokid/rabilink/tasks", "post"],
  ["/rokid/rabilink/messages", "get"],
  ["/rokid/rabilink/tasks/{taskId}/messages", "get"],
  ["/rokid/rabilink/tasks/{taskId}", "get"],
];

const toolImportRequiredPaths = [
  ["/rokid/rabilink/tasks", "post"],
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

  const globalMessagesGet = getOperation(document, "/rokid/rabilink/messages", "get");
  const globalParamNames = new Set((globalMessagesGet.parameters || []).map((parameter) => parameter.name));
  assert(!globalMessagesGet.requestBody, `${candidate.file}: GET /rokid/rabilink/messages must not define requestBody.`);
  assert(globalParamNames.has("after"), `${candidate.file}: GET /rokid/rabilink/messages should expose after cursor.`);
  assert(!globalParamNames.has("taskId"), `${candidate.file}: GET /rokid/rabilink/messages must not require taskId.`);

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

function validateToolImportDocument(candidate) {
  const absolutePath = path.join(repoRoot, candidate.file);
  if (candidate.optional && !fs.existsSync(absolutePath)) {
    return null;
  }
  const document = readJson(candidate.file);
  const actualServerUrl = document.servers?.[0]?.url || "";
  const expectedServerUrl = candidate.serverUrl || actualServerUrl;

  assert(document.openapi?.startsWith("3."), `${candidate.file}: openapi must be 3.x.`);
  assert(document.info?.title === "RabiLinkMessage Tools", `${candidate.file}: title must be RabiLinkMessage Tools.`);
  assert(actualServerUrl === expectedServerUrl, `${candidate.file}: server URL must be ${expectedServerUrl}.`);
  if (candidate.rejectExampleServer) {
    assert(!actualServerUrl.includes("example.com"), `${candidate.file}: data OpenAPI must use the real relay URL, not ${actualServerUrl}.`);
  }

  const pathNames = new Set(Object.keys(document.paths || {}));
  assert(!pathNames.has("/rokid/rabilink/tasks/{taskId}/messages"), `${candidate.file}: tool import must not include task-scoped message polling.`);
  assert(!pathNames.has("/rokid/rabilink/tasks/{taskId}"), `${candidate.file}: tool import must not include task status debug tool.`);
  assert(!pathNames.has("/tasks"), `${candidate.file}: tool import should use full /rokid/rabilink/tasks path with root servers.url.`);
  assert(!pathNames.has("/messages"), `${candidate.file}: tool import should use full /rokid/rabilink/messages path with root servers.url.`);

  for (const [routePath, method] of toolImportRequiredPaths) {
    const operation = getOperation(document, routePath, method);
    assert(operation, `${candidate.file}: missing ${method.toUpperCase()} ${routePath}.`);
    validateResponses(candidate.file, operation, routePath, method);
    if (method === "get") {
      assert(!operation.requestBody, `${candidate.file}: GET ${routePath} must not define requestBody.`);
    }
  }

  const globalMessagesGet = getOperation(document, "/rokid/rabilink/messages", "get");
  const globalParamNames = new Set((globalMessagesGet.parameters || []).map((parameter) => parameter.name));
  assert(globalParamNames.has("after"), `${candidate.file}: GET /rokid/rabilink/messages should expose after cursor.`);
  assert(!globalParamNames.has("taskId"), `${candidate.file}: GET /rokid/rabilink/messages must not require taskId.`);

  return {
    file: candidate.file,
    title: document.info.title,
    serverUrl: actualServerUrl,
    security: "plugin-level",
  };
}

function flattenPostmanItems(items, output = []) {
  for (const item of items || []) {
    if (item.request) {
      output.push(item);
    }
    if (item.item) {
      flattenPostmanItems(item.item, output);
    }
  }
  return output;
}

function validatePostmanResponse(candidateFile, item) {
  const responses = item.response || [];
  const okResponse = responses.find((response) => response.code === 200);
  assert(okResponse, `${candidateFile}: ${item.name} should include a 200 response example.`);
  const contentType = (okResponse.header || []).find((header) => header.key?.toLowerCase() === "content-type")?.value || "";
  assert(contentType.includes("application/json"), `${candidateFile}: ${item.name} 200 response must be application/json.`);
  assert(okResponse.body, `${candidateFile}: ${item.name} 200 response should include JSON body.`);
  JSON.parse(okResponse.body);
}

function getAbsolutePostmanUrl(candidateFile, item) {
  const rawUrl = item.request?.url?.raw || "";
  assert(rawUrl, `${candidateFile}: ${item.name} should define request.url.raw.`);
  assert(!rawUrl.includes("{{"), `${candidateFile}: ${item.name} URL must be absolute; Rizon does not expand Postman variables.`);
  try {
    return new URL(rawUrl);
  } catch {
    fail(`${candidateFile}: ${item.name} URL must be a valid absolute URL, got ${rawUrl}.`);
  }
}

function getPostmanBaseUrl(candidateFile, item, allowHttp = false) {
  const url = getAbsolutePostmanUrl(candidateFile, item);
  const allowedProtocols = allowHttp ? new Set(["http:", "https:"]) : new Set(["https:"]);
  assert(allowedProtocols.has(url.protocol), `${candidateFile}: ${item.name} URL should use ${allowHttp ? "HTTP or HTTPS" : "HTTPS"}.`);
  return `${url.protocol}//${url.host}`;
}

function validateToolImportPostman(candidate) {
  const absolutePath = path.join(repoRoot, candidate.file);
  if (candidate.optional && !fs.existsSync(absolutePath)) {
    return null;
  }
  const document = readJson(candidate.file);
  const schema = document.info?.schema || "";

  assert(schema.includes("collection/v2.1.0"), `${candidate.file}: expected Postman Collection v2.1 schema.`);
  assert(document.info?.name === "RabiLinkMessage Tools", `${candidate.file}: name must be RabiLinkMessage Tools.`);

  const items = flattenPostmanItems(document.item);
  const submit = items.find((item) => item.name === "submitRabiLinkTask");
  const messages = items.find((item) => item.name === "getRabiLinkMessages");

  assert(submit, `${candidate.file}: missing submitRabiLinkTask.`);
  assert(messages, `${candidate.file}: missing getRabiLinkMessages.`);
  assert(items.length === 2, `${candidate.file}: tool import should only expose submitRabiLinkTask and getRabiLinkMessages.`);

  const baseUrl = getPostmanBaseUrl(candidate.file, submit, candidate.allowHttp);
  const expectedBaseUrl = candidate.serverUrl || baseUrl;
  assert(baseUrl === expectedBaseUrl, `${candidate.file}: base URL must be ${expectedBaseUrl}.`);
  assert(getPostmanBaseUrl(candidate.file, messages, candidate.allowHttp) === expectedBaseUrl, `${candidate.file}: all tool URLs must share ${expectedBaseUrl}.`);
  if (candidate.rejectExampleServer) {
    assert(!baseUrl.includes("example.com"), `${candidate.file}: data Postman collection must use the real relay URL, not ${baseUrl}.`);
  }

  assert(submit.request.method === "POST", `${candidate.file}: submitRabiLinkTask must use POST.`);
  assert(submit.request.url?.raw === `${expectedBaseUrl}/rokid/rabilink/tasks`, `${candidate.file}: submitRabiLinkTask URL must be ${expectedBaseUrl}/rokid/rabilink/tasks.`);
  assert(submit.request.body?.mode === "raw", `${candidate.file}: submitRabiLinkTask should use raw JSON body.`);
  const submitBody = JSON.parse(submit.request.body.raw);
  assert(typeof submitBody.text === "string", `${candidate.file}: submitRabiLinkTask body should include text.`);

  assert(messages.request.method === "GET", `${candidate.file}: getRabiLinkMessages must use GET.`);
  assert(messages.request.url?.raw === `${expectedBaseUrl}/rokid/rabilink/messages?after=`, `${candidate.file}: getRabiLinkMessages URL must be ${expectedBaseUrl}/rokid/rabilink/messages?after=.`);
  const queryNames = new Set((messages.request.url?.query || []).map((query) => query.key));
  assert(queryNames.has("after"), `${candidate.file}: getRabiLinkMessages should expose after query parameter.`);

  validatePostmanResponse(candidate.file, submit);
  validatePostmanResponse(candidate.file, messages);

  return {
    file: candidate.file,
    title: document.info.name,
    serverUrl: baseUrl,
    security: "plugin-level",
  };
}

try {
  const results = [
    ...candidates.map(validateDocument),
    ...toolImportCandidates.map(validateToolImportDocument),
    ...toolImportPostmanCandidates.map(validateToolImportPostman),
  ].filter(Boolean);
  for (const result of results) {
    console.log(`[ok] ${result.file} title=${result.title} server=${result.serverUrl} auth=${result.security}`);
  }
} catch (error) {
  console.error(`[fail] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
