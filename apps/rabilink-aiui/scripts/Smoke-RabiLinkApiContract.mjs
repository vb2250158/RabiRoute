import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

const tempRoot = path.join(os.tmpdir(), `rabilink-api-contract-${process.pid}-${Date.now()}`);

try {
  fs.mkdirSync(tempRoot, { recursive: true });
  const utilsRoot = path.join(tempRoot, "utils");
  fs.mkdirSync(utilsRoot, { recursive: true });

  const apiSource = readText(path.join(projectRoot, "utils", "rabilink-api.js"))
    .replace('import wx from "wx";', 'import wx from "../test-mocks/wx.js";')
    .replace("'../../../packages/rabi-api-contract/fingerprint.mjs'", JSON.stringify(pathToFileURL(path.resolve(projectRoot,'../../packages/rabi-api-contract/fingerprint.mjs')).href));
  writeText(path.join(utilsRoot, "rabilink-api.js"), apiSource);
  for(const file of ['phone-eye-transport.js','rabilink-store.js'])writeText(path.join(utilsRoot,file),readText(path.join(projectRoot,'utils',file)).replace(/import wx from ["']wx["'];/, 'import wx from "../test-mocks/wx.js";'));
  writeText(path.join(tempRoot, "test-mocks", "wx.js"), `
export const requests = [];
export const nextResponses = [];

const wx = {
  getStorageSync() { return undefined; },
  request(options = {}) {
    requests.push(options);
    const response = nextResponses.length ? nextResponses.shift() : { statusCode: 200, data: { code: 0, ok: true } };
    if (response.fail && typeof options.fail === "function") {
      options.fail(response.fail);
      return;
    }
    if (typeof options.success === "function") options.success(response);
  }
};

export default wx;
`);

  const mock = await import(pathToFileURL(path.join(tempRoot, "test-mocks", "wx.js")).href);
  const api = await import(`${pathToFileURL(path.join(utilsRoot, "rabilink-api.js")).href}?contract=${Date.now()}`);
  const config = {
    relayBaseUrl: "https://relay.example.com/",
    token: "test-token"
  };

  await api.getMobileState(config);
  assert(mock.requests.at(-1).url === "https://relay.example.com/api/rabilink/mobile/state", "getMobileState must call the mobile state endpoint.");
  assert(mock.requests.at(-1).method === "GET", "getMobileState must use GET.");
  assert(mock.requests.at(-1).header["X-RabiLink-Token"] === "test-token", "Requests must carry X-RabiLink-Token.");

  mock.nextResponses.push({
    statusCode: 401,
    data: { code: "INVALID_TOKEN", ok: false, message: "凭证无效" }
  });
  const authError = await assertRejects(() => api.getMobileState(config), "凭证无效");
  assert(authError.statusCode === 401, "API errors must preserve the HTTP status code for HUD auth handling.");
  assert(authError.code === "INVALID_TOKEN", "API errors must preserve the server error code.");

  mock.nextResponses.push({
    statusCode: 200,
    data: { code: 0, ok: true, token: "rbd_device-token" }
  });
  const claim = await api.claimRabiLinkDeviceToken({ relayBaseUrl: "https://relay.example.com", token: "" }, "SN-1234");
  const claimPost = mock.requests.at(-1);
  assert(claimPost.url === "https://relay.example.com/api/rabilink/devices/token", "Device claim must use the SN token endpoint.");
  assert(claimPost.method === "POST" && claimPost.data.serialNumber === "SN-1234", "Device claim must submit the normalized glasses SN.");
  assert(!Object.hasOwn(claimPost.header, "X-RabiLink-Token"), "First device claim must not require an existing app token.");
  assert(claim.token === "rbd_device-token", "Device claim must return the server-issued device credential.");

  await api.selectMobileTarget(config, "pc-a");
  assert(mock.requests.at(-1).url === "https://relay.example.com/api/rabilink/mobile/target", "selectMobileTarget must call target endpoint.");
  assert(mock.requests.at(-1).method === "PATCH", "selectMobileTarget must use PATCH.");
  assert(mock.requests.at(-1).data.targetDeviceId === "pc-a", "selectMobileTarget must send targetDeviceId.");

  const pc = { code: 0, data: { capability: 'future' } };
  mock.nextResponses.push({ statusCode: 200, data: { code: 0, data: { structuredContent: { ok: true, data: pc, headers: {} } } } });
  const unknown = await api.getMobileWebgui(config, '/api/future-public-capability', 'pc-a');
  const generic = mock.requests.at(-1);
  assert(generic.url === 'https://relay.example.com/api/rabilink/device/api', 'Every Manager business request must use the generic transport.');
  assert(generic.data.targetDeviceId === 'pc-a' && generic.data.request.path === '/api/future-public-capability', 'Target and unknown future path are client-owned.');
  assert(unknown.data.capability === 'future' && !Object.hasOwn(generic.data, 'profileRevision'), 'Relay must not select a persona/profile revision.');

  const mutation = { operationId: 'ui-original-operation', expectedContentHash: 'a'.repeat(64) };
  mock.nextResponses.push({ statusCode: 200, data: { code: 0, data: { structuredContent: { ok: true, headers: { etag: 'verified' }, data: { code: 0, receipt: { state: 'committed', operationId: mutation.operationId, contentHash: 'b'.repeat(64) } } } } } });
  await api.postMobileWebgui(config, '/gateways', { gateways: [] }, 'pc-a', 'POST', mutation);
  const write = mock.requests.at(-1).data.request;
  assert(write.path === '/gateways' && write.method === 'POST' && write.headers['If-Match'] === mutation.expectedContentHash, 'Write fences survive the generic transport.');
  assert(write.operationId === mutation.operationId, 'The caller owns the original idempotency key.');

  await assertRejects(() => api.getMobileState({ relayBaseUrl: "", token: "test-token" }), "Relay URL is empty.");
  await assertRejects(() => api.getMobileState({ relayBaseUrl: "https://relay.example.com", token: "" }), "RabiLink token is empty.");

  console.log("RabiLink AIUI API contract smoke passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function assertRejects(action, expectedMessage) {
  try {
    await action();
  } catch (error) {
    assert(String(error?.message || error).includes(expectedMessage), `Expected rejection to include: ${expectedMessage}`);
    return error;
  }
  fail(`Expected action to reject: ${expectedMessage}`);
}
