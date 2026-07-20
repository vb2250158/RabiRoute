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
    .replace('import wx from "wx";', 'import wx from "../test-mocks/wx.js";');
  writeText(path.join(utilsRoot, "rabilink-api.js"), apiSource);
  writeText(path.join(tempRoot, "test-mocks", "wx.js"), `
export const requests = [];
export const nextResponses = [];

const wx = {
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

  await api.getMobileRoutes(config, "pc-a");
  assert(mock.requests.at(-1).url === "https://relay.example.com/api/rabilink/mobile/routes?targetDeviceId=pc-a", "getMobileRoutes must include targetDeviceId query.");

  await api.setMobileAgentBinding(config, "route/one", { agentAdapter: "codex" }, "pc-a");
  assert(
    mock.requests.at(-1).url === "https://relay.example.com/api/rabilink/mobile/routes/route%2Fone/agent-binding?targetDeviceId=pc-a",
    "setMobileAgentBinding must encode route id and include target query."
  );
  assert(mock.requests.at(-1).method === "PATCH", "setMobileAgentBinding must use PATCH.");
  assert(mock.requests.at(-1).data.agentAdapter === "codex", "setMobileAgentBinding must send binding body.");

  await api.getMobileWebgui(config, "/api/agent/copilot-status", "pc-a");
  assert(
    mock.requests.at(-1).url === "https://relay.example.com/api/rabilink/mobile/webgui?path=%2Fapi%2Fagent%2Fcopilot-status&targetDeviceId=pc-a",
    "getMobileWebgui must proxy path via encoded query."
  );

  await api.postMobileWebgui(config, "/manager/start", { dryRun: true }, "pc-a");
  const webguiPost = mock.requests.at(-1);
  assert(webguiPost.url === "https://relay.example.com/api/rabilink/mobile/webgui?targetDeviceId=pc-a", "postMobileWebgui must use the mobile webgui endpoint.");
  assert(webguiPost.method === "POST", "postMobileWebgui transport must use POST.");
  assert(webguiPost.data.method === "POST" && webguiPost.data.path === "/manager/start", "postMobileWebgui must wrap PC method and path.");
  assert(webguiPost.data.body.dryRun === true, "postMobileWebgui must preserve body.");

  mock.nextResponses.push({
    statusCode: 202,
    data: { code: 0, ok: true, status: "accepted", eventId: "voice-event-1", nextCursor: "out-10" }
  });
  const inputResponse = await api.publishRabiLinkVoiceInput(config, {
    text: "把这一句同步到电脑",
    sessionId: "session-a",
    sequence: 7,
    createdAt: 123456
  });
  const transcriptPost = mock.requests.at(-1);
  assert(transcriptPost.url === "https://relay.example.com/rokid/rabilink/input", "Voice input must use the message input endpoint, not a task endpoint.");
  assert(transcriptPost.method === "POST", "Voice input must use POST.");
  assert(transcriptPost.data.text === "把这一句同步到电脑", "Voice input must preserve recognized text.");
  assert(transcriptPost.data.type === "rabilink.observation", "Voice input must identify the record-first observation payload.");
  assert(transcriptPost.data.deliveryMode === "observe", "Voice input must not request direct Agent delivery.");
  assert(transcriptPost.data.sessionId === "session-a" && transcriptPost.data.sequence === 7, "Voice input must preserve session ordering metadata.");
  assert(inputResponse.status === "accepted" && !Object.hasOwn(inputResponse, "taskId"), "Voice input acknowledgement must not expose a task lifecycle.");

  await assertRejects(() => api.publishRabiLinkVoiceInput(config, { text: " " }), "Transcript text is empty.");

  await api.getRabiLinkMessageStream(config, "out-10", 1200);
  const messagesGet = mock.requests.at(-1);
  assert(messagesGet.method === "GET", "Downlink stream must use GET.");
  assert(messagesGet.url === "https://relay.example.com/rokid/rabilink/messages?after=out-10&stream=1&waitMs=1200", "Downlink stream must carry cursor, stream flag, and bounded wait time.");
  assert(messagesGet.timeout >= 6200, "Downlink stream timeout must outlive the Relay wait window.");

  await api.getRabiLinkMessageStream(config, "", 0);
  const backlogGet = mock.requests.at(-1);
  assert(
    backlogGet.url === "https://relay.example.com/rokid/rabilink/messages?after=&stream=1&waitMs=0",
    "A first connection must request the retained app backlog instead of skipping offline messages at the current tail."
  );

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
