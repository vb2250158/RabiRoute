import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const pagePath = path.join(projectRoot, "pages", "home", "index.ink");
const source = fs.readFileSync(pagePath, "utf8");
const apiSource = fs.readFileSync(path.join(projectRoot, "utils", "rabilink-api.js"), "utf8");
const storeSource = fs.readFileSync(path.join(projectRoot, "utils", "rabilink-store.js"), "utf8");
const voiceSource = fs.readFileSync(path.join(projectRoot, "utils", "voice-command.js"), "utf8");
const voiceRuntimeSource = fs.readFileSync(path.join(projectRoot, "utils", "voice-runtime.js"), "utf8");
const craftRelease = JSON.parse(fs.readFileSync(path.join(projectRoot, "craft-release.json"), "utf8"));
const style = source.match(/<style>([\s\S]*?)<\/style>/i)?.[1] || "";
const definitionText = source.match(/<script[^>]*\bdef\b[^>]*>([\s\S]*?)<\/script>/i)?.[1] || "{}";
const definition = JSON.parse(definitionText);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseRules(css) {
  const rules = new Map();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2];
    for (const rawSelector of match[1].split(",")) {
      const selector = rawSelector.trim();
      if (!selector) continue;
      rules.set(selector, `${rules.get(selector) || ""}\n${body}`);
    }
  }
  return rules;
}

const rules = parseRules(style);

function blockFor(selector) {
  return rules.get(selector) || "";
}

function hasDeclaration(selector, property, expected) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*${expected}\\s*;`, "m").test(blockFor(selector));
}

function pxValue(selector, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = blockFor(selector).match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:\\s*([^;]+);`, "m"))?.[1] || "";
  const values = [...value.matchAll(/([0-9.]+)px/g)].map((match) => Number(match[1]));
  return values[0] || 0;
}

assert(!source.includes("<scroll-view"), "AIUI page must avoid Ink 0.13 scroll-view nodes during Craft card-to-immersive resize.");
assert(source.includes('<view class="pageScroll">'), "AIUI page must use a stable bounded root view.");
assert(hasDeclaration(".pageScroll", "width", "var\\(--app-width,\\s*480px\\)"), "AIUI surface must follow the 480px host width token.");
assert(hasDeclaration(".pageScroll", "height", "var\\(--rabilink-surface-height,\\s*352px\\)"), "AIUI surface must cap itself to the 352px Craft/glasses viewport.");
assert(hasDeclaration(".pageScroll", "max-height", "var\\(--rabilink-surface-height,\\s*352px\\)"), "AIUI surface max-height must not inherit the taller 380px theme maximum.");
assert(!/\.pageScroll\s*\{[^}]*height\s*:\s*var\(--app-height-max/is.test(style), "AIUI surface height must not use the host theme max-height token.");
assert(hasDeclaration(".page", "width", "var\\(--app-width,\\s*480px\\)"), "Inner page must match the 480px host width token.");
assert(hasDeclaration(".page", "color", "var\\(--color-text-primary,\\s*#40ff5e\\)"), "AIUI page must use the green monochrome text token.");
assert(hasDeclaration(".page", "background-color", "var\\(--color-background,\\s*#000000\\)"), "AIUI page must keep pure black as the base background.");

for (const selector of [
  ".modeHeader",
  ".modeSwitch",
  ".modeSwitchOption",
  ".hudInfoRow",
  ".assistantStatusRow",
  ".deviceFooter",
  ".deviceReadout",
  ".batteryIcon",
  ".batteryBody"
]) {
  assert(hasDeclaration(selector, "display", "flex"), `${selector} must use flex layout.`);
  assert(hasDeclaration(selector, "flex-direction", "row"), `${selector} must declare an explicit row direction for Ink.`);
}
for (const selector of [".unifiedModeHud", ".assistantConversation"]) {
  assert(hasDeclaration(selector, "display", "flex"), `${selector} must use flex layout.`);
  assert(hasDeclaration(selector, "flex-direction", "column"), `${selector} must remain a vertical HUD surface.`);
}

const toolSchema = definition.schema?.data;
assert(typeof definition.description === "string" && definition.description.trim(), "AIUI page tool must declare a description.");
assert(toolSchema?.type === "object", "AIUI page tool must declare schema.data as an object.");
assert(toolSchema?.properties?.token?.type === "string", "AIUI page tool must expose the bound token input.");
assert(toolSchema?.properties?.mode?.type === "string", "AIUI page tool must expose the dual-mode selector.");
assert(toolSchema?.properties?.surface?.type === "string", "AIUI page tool must expose a surface selector.");
assert(toolSchema?.properties?.panel?.type === "string", "AIUI page tool must expose a configuration panel selector.");
assert(toolSchema?.properties?.intent?.type === "string", "AIUI page tool must preserve the user intent.");
assert(Array.isArray(toolSchema?.required) && !toolSchema.required.includes("token"), "AIUI page tool must render before the platform token is bound.");
assert(!/ink:(?:if|elif|else)\b/.test(source), "AIUI must avoid structural conditions that can spin Craft's Ink apply_ops loop.");
assert(!/<\/?block\b/.test(source), "AIUI must keep a stable mounted view tree without conditional block nodes.");
assert(source.includes('class="unifiedModeHud {{modeFrameRelayout'), "AIUI must render one stable immersive HUD shared by both product modes.");
assert(!source.includes("transcriptionHud") && !source.includes("configurationAssistantHud"), "Mode-specific legacy HUD trees must not remain in the page.");
assert(!source.includes('class="configurationModeHost {{isConfigurationMode'), "The old manual configuration dashboard must not remain selectable.");
assert(!source.includes('class="legacyConfigurationModeHost'), "The old manual configuration markup must be removed from the AIX page.");
assert(!source.includes('Token {{maskedToken}}'), "The assistant HUD must not expose the old token editor or credential status row.");
assert(!source.includes("saveSettings({ token })"), "The current AIUI must not persist the injected RabiLink token in local page storage.");
assert(source.includes("tokenStorageKey(this.data.token)"), "Durable AIUI queues and cursors must be scoped by an opaque token fingerprint.");
assert(!source.includes("agentCursorTokenKey: maskToken") && !source.includes("saveAgentMessageQueue(next, maskToken"), "Durable AIUI state must not persist token prefix or suffix fragments.");
assert(storeSource.includes("transcriptQueueStorageKey") && storeSource.includes("tokenStorageKey"), "Offline observations must be isolated by token fingerprint before synchronization.");
assert((source.match(/class="unifiedModeHud \{\{modeFrameRelayout/g) || []).length === 1, "AIUI must render exactly one shared HUD tree across card and immersive sizes.");
assert(!source.includes('class="compactCard {{modeFrameRelayout'), "A second compact tree must not be mounted during Craft card-to-immersive resize.");
assert(/@media\s*\(max-height:\s*180px\)/.test(style), "AIUI must reserve the Craft card action strip without replacing the shared HUD tree.");
assert(!source.includes("modeHidden"), "Mode switching must not toggle parallel trees through display:none.");
assert(source.includes("commitModeFrame") && hasDeclaration(".modeFrameRelayout", "padding-right", "1px"), "The single HUD must use a bounded one-pixel relayout to force complete Ink repainting.");
assert(!hasDeclaration(".modeFrameRelayout", "opacity", "0"), "Mode relayout must never blank the whole HUD; ordinary state updates must remain flicker-free.");
assert(source.includes("hudVisibleSnapshot") && source.includes("...this.hudVisibleSnapshot()"), "Unmasking must replay every visible HUD binding so Ink cannot retain a partial tree.");
assert(pxValue(".unifiedModeHud", "width") === 424, "The shared HUD must respect the 448px card safe width after resize.");
assert(pxValue(".compactMainText", "width") === 424, "Shared HUD text must respect the 448px card safe width.");
assert(pxValue(".compactHeader", "width") === 424, "Shared HUD header must stay inside the 448px clipped host width.");
assert(pxValue(".compactDeviceFooter", "width") === 424, "Shared device footer must stay inside the 448px clipped host width.");
for (const [selector, height] of [
  [".compactHeader", 16],
  [".compactModeSwitch", 20],
  [".compactStatusRow", 14],
  [".compactMainText", 16],
  [".compactDeviceFooter", 13],
  [".modeHeader", 16],
  [".assistantStatusRow", 14],
  [".assistantConversation", 16]
]) {
  assert(pxValue(selector, "height") === height, `${selector} must have a fixed ${height}px height so host font metrics cannot overlap adjacent rows.`);
  assert(pxValue(selector, "max-height") === height, `${selector} must cap itself at ${height}px.`);
  assert(hasDeclaration(selector, "overflow", "hidden"), `${selector} must clip oversized glyphs instead of painting into another row.`);
}
for (const selector of [".unifiedModeHud", ".modeHeader", ".modeSwitch", ".hudInfoRow", ".deviceFooter", ".assistantStatusRow"]) {
  assert(hasDeclaration(selector, "display", "flex"), `${selector} must use stable flex layout.`);
}
assert(hasDeclaration(".unifiedModeHud", "justify-content", "flex-end"), "The shared mode HUD must grow upward from the lower field of view.");
assert(hasDeclaration(".unifiedModeHud", "position", "absolute") && hasDeclaration(".unifiedModeHud", "bottom", "16px"), "The shared HUD must be anchored below the central field of view.");
assert(pxValue(".unifiedModeHud", "height") === 87 && hasDeclaration(".unifiedModeHud", "overflow", "hidden"), "The shared HUD must keep one 87px geometry across host resize.");
assert(hasDeclaration(".modeHeader", "width", "100%") && hasDeclaration(".modeHeader", "box-sizing", "border-box"), "The mode rail header must keep a stable bounded width.");
assert(hasDeclaration(".deviceFooter", "max-width", "100%") && hasDeclaration(".deviceFooter", "box-sizing", "border-box"), "Clock and battery readouts must remain inside the HUD safe width.");
assert(hasDeclaration(".assistantConversation", "overflow", "hidden"), "Assistant conversation text must stay inside the AR HUD budget.");
assert(source.includes("assistantUserText") && source.includes("assistantReplyText") && source.includes("assistantStatus"), "Configuration mode must show the user's request, assistant reply, and current state.");
assert(source.includes("executeConfigurationIntent") && source.includes('"native-agent"'), "Configuration mode must execute intents normalized by the glasses native Agent.");
assert(source.includes("assistantListeningDesired") && source.includes("assistantListening"), "Configuration mode must expose explicit page-owned listening intent and live state.");
assert(source.includes("handleConfigurationSpeechResult") && source.includes("interpretConfigurationSpeech"), "Configuration mode must send direct AIUI ASR results through native semantic understanding.");
assert(source.includes("LanguageModel.availability") && source.includes("LanguageModel.create") && source.includes("session.prompt"), "Configuration mode must use the AIUI native LanguageModel instead of pretending that keyword matching is an assistant.");
assert(source.includes('addEventListener("toolcall"') && voiceSource.includes('execute_configuration_action'), "Native LanguageModel intent must cross a whitelisted tool-call boundary before page actions run.");
assert(source.includes("assistantModelBusy") && source.includes("assistantModelState"), "The HUD must expose native-model progress without starting a competing ASR round.");
assert(source.includes('this.recognitionPurpose = purpose') && source.includes('purpose === "configuration"'), "The shared one-round recognizer must distinguish configuration and transcription ownership.");
assert(!source.includes("submitAssistantIntent") && !source.includes("pollAssistantMessages") && !source.includes("assistantTaskId"), "Configuration mode must not own a Relay task lifecycle.");
assert(
  hasDeclaration(".assistantConversation", "background-color", "(?:#000000|var\\(--color-surface,\\s*#000000\\))"),
  "The shared conversation surface must use the transparent-display black surface token."
);
assert(source.includes("连接对话") && source.includes("配置助手"), "Both product modes must remain visibly labeled with the agreed names.");
assert(source.includes("publishRabiLinkVoiceInput") && source.includes("pollAgentMessages") && source.includes("getRabiLinkMessageStream"), "Connection conversation must publish input events and consume one continuous downlink stream.");
assert(!source.includes("trackAgentTask") && !source.includes("agentPendingTaskIds") && !source.includes("agentPendingCount"), "Connection conversation must not expose per-task state.");
assert(apiSource.includes('"/rokid/rabilink/input"') && !apiSource.includes('"/rokid/rabilink/tasks"'), "The AIUI API must publish message input without using the task endpoint.");
assert(source.includes("persistAgentMessages") && source.includes("drainAgentMessageQueue") && source.includes("agentReplyText") && source.includes("agentSpeech: true"), "Agent downlink text must be persisted before its cursor advances, then reach the visible conversation surface and TTS path.");
assert(source.includes("loadAgentMessageQueue") && source.includes("saveAgentMessageQueue"), "An interrupted Agent TTS queue must survive page hide or recreation.");
assert(!source.includes("getRabiLinkMessageStreamCursor") && !apiSource.includes("tail=1"), "A first glasses connection must consume retained offline downlinks instead of skipping to the current tail.");
assert((source.match(/class="modeSwitch(?:\s|\")/g) || []).length === 1, "The shared HUD must render one two-position track across card and immersive sizes.");
assert(source.includes("modeSwitchThumbRight") && hasDeclaration(".modeSwitchThumbRight", "left", "118px"), "The selected mode thumb must move to the right-hand configuration position.");
assert(source.includes('bindtap="selectTranscriptionMode"') && source.includes('bindtap="selectConfigurationMode"'), "Both rail positions must remain directly selectable without button chrome.");
assert(source.includes("滑动切换"), "The mode rail must retain a small physical swipe affordance.");
assert(!source.includes("<button"), "The glasses happy path must not present phone-style rectangular buttons.");
assert(!source.includes("transcriptButton"), "Legacy same-level mode/action buttons must be removed.");
assert(source.includes("toggleModePrimaryAction") && source.includes("retryModeAction"), "Pause and retry must remain available to the touchpad state machine without adding a competing control row.");
assert(source.includes("currentTime") && source.includes("clockIcon") && source.includes("deviceReadout"), "Every HUD must expose the current time at the lower left with a clock icon.");
assert(source.includes("batteryText") && source.includes("batteryIcon") && source.includes("batteryFillClass"), "Every HUD must expose battery state at the lower right with a battery icon.");
assert(source.includes('const RABILINK_RELEASE_VERSION = "__RABILINK_RELEASE_VERSION__"'), "The visible release version must be injected from craft-release.json at build time.");
assert((source.match(/class="releaseVersion"/g) || []).length === 1, "The shared HUD must show the release version immediately left of battery state.");
assert(source.includes("appVersion: this.data.releaseVersion"), "Runtime proof must report the visible Craft release version instead of a stale development package version.");
assert(source.includes("AGENT_TTS_MAX_ATTEMPTS = 3"), "A permanently failing TTS item must have a bounded retry budget.");
assert(source.includes("TTS 失败，单击重试"), "A retained TTS failure must expose a touchpad-accessible retry state instead of blocking the queue silently.");
assert(source.includes("if (this.hasBlockedAgentMessages()) this.retryModeAction();"), "A touchpad click must recover a blocked TTS queue before requesting another review.");
assert(source.includes('mode: "enqueue"') && voiceRuntimeSource.includes("synthesis.speak(utterance, mode)"), "Native TTS must use the AIUI-documented enqueue mode through the voice adapter.");
assert(source.includes("createAiuiAsrInputAdapter") && source.includes("createAiuiTtsOutputAdapter"), "The page must consume AIUI native voice capabilities through the shared adapter boundary.");
assert(!source.includes("new SpeechSynthesisUtterance") && !source.includes("speechSynthesis.speak("), "The page must not bypass the native TTS adapter.");
assert(source.includes("this.speechPlaybackWatchdogMs(item.text)"), "ASR/TTS handoff must not depend on unavailable utterance lifecycle events.");
assert(/^\d+\.\d+\.\d+$/.test(String(craftRelease.version || "")), "The visible Craft release version must use semantic versioning.");
assert(hasDeclaration(".releaseVersion", "text-align", "right"), "The release version must remain visually attached to the battery readout.");
assert(source.includes("batteryCharging") && source.includes("chargingMark"), "Battery UI must expose the CXR-reported charging state.");
assert(source.includes("applyRelayBatteryState") && source.includes('"relay-cxr"'), "Battery status must accept a fresh phone-side CXR glasses report.");
assert(!source.includes("navigator.getBattery") && !source.includes("getBatteryInfoSync") && !source.includes("getSystemInfoSync"), "Phone, browser, or generic host battery values must not be mislabeled as glasses battery.");
assert(source.includes('batteryStatusLabel: "电量不可用"') && source.includes('batteryText: "--"'), "Missing public battery data must render an explicit unknown state rather than a fabricated percentage.");
assert(hasDeclaration(".clockIcon", "position", "relative"), "The clock glyph must be built as a stable icon, not a text instruction.");
assert(hasDeclaration(".batteryBody", "position", "relative"), "The battery glyph must provide a stable frame for fill and charge state.");
assert(hasDeclaration(".deviceFooter", "justify-content", "space-between"), "Time and battery must be anchored to opposite lower corners.");

const assistantHudHeight = pxValue(".modeHeader", "height")
  + pxValue(".compactModeSwitch", "height")
  + pxValue(".assistantStatusRow", "height")
  + pxValue(".assistantConversation", "height")
  + pxValue(".compactDeviceFooter", "height")
  + 8;
assert(assistantHudHeight === 87, `Shared card/immersive HUD must keep its exact 87px budget: ${assistantHudHeight}px.`);

for (const requiredHandler of ["onShow", "onHide", "onVoiceWakeup", "onKeyDown", "onKeyUp", "startTranscription", "scheduleTranscriptionRestart", "executeConfigurationIntent"]) {
  assert(source.includes(requiredHandler), `AIUI page must keep ${requiredHandler}.`);
}
for (const key of ["arrowright", "arrowleft", "arrowup", "arrowdown", "backspace", "enter", "globalhook"]) {
  assert(source.includes(`"${key}"`), `AIUI key handler must include ${key}.`);
}
assert(source.includes('code === "arrowdown" || code === "arrowright"'), "Transcription mode must map physical down/right input to the configuration assistant.");
assert(!source.includes('code === "arrowdown" || code === "arrowright" || code === "backspace"'), "Transcription mode must leave Backspace to the host return/close behavior.");
assert(source.includes('code === "arrowup" || code === "arrowleft" || code === "backspace"'), "Configuration UI must map physical up/forward and left/back input to transcription mode.");
assert(!source.includes("startVoiceCommand") && !source.includes("toggleVoiceCommand"), "Configuration mode must share the bounded AIUI recognizer instead of reviving the removed legacy voice-command controller.");
assert(!source.includes("finishToConfigurationAssistant") && !source.includes("this.finish()"), "Mode switching must keep the same Interactive InkView alive.");
assert(source.includes("normalizeInputCode(event)"), "Touchpad input must normalize Ink, browser, and Android key event shapes.");
assert(voiceRuntimeSource.includes("recognition.continuous = false"), "AIUI foreground ASR must use documented one-round recognition semantics.");
assert(source.includes("TRANSCRIPTION_RESTART_DELAY_MS"), "AIUI foreground ASR must explicitly restart completed recognition rounds.");
assert(source.includes("speechSynthesis"), "AIUI page must keep speechSynthesis result feedback support.");
assert(source.includes("this.stopRecognition(false)") && source.includes("agentSpeaking: true") && source.includes("onEnd: () => finishSpeech()"), "Agent TTS must own the microphone while speaking and release it through an explicit completion callback.");
assert(source.includes("this.scheduleTranscriptionRestart(TRANSCRIPTION_RESTART_DELAY_MS)"), "Agent TTS completion must restore foreground ASR when the conversation remains active.");

const hexColors = [...style.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0].toLowerCase());
const allowedHexColors = new Set(["#000000", "#40ff5e"]);
const unexpectedHexColors = [...new Set(hexColors.filter((color) => !allowedHexColors.has(color)))];
assert(unexpectedHexColors.length === 0, `AIUI design should stay monochrome green/black; unexpected colors: ${unexpectedHexColors.join(", ")}`);
assert(!/\b(?:gradient|bokeh|blob|orb|orbs)\b/i.test(style), "AIUI HUD should not use decorative gradients, blobs, bokeh, or orbs.");
assert(!/letter-spacing:\s*-\d/i.test(style), "AIUI HUD must not use negative letter spacing.");

console.log(`RabiLink AIUI design audit passed (assistant lower HUD ${assistantHudHeight}px / 210px).`);
