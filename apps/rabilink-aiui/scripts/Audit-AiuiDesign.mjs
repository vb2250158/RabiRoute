import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const pagePath = path.join(projectRoot, "pages", "home", "index.ink");
const source = fs.readFileSync(pagePath, "utf8");
const style = source.match(/<style>([\s\S]*?)<\/style>/i)?.[1] || "";

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

const rules = parseRules(style.replace(/\/\*[\s\S]*?\*\//g, ''));

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


  assert(/<view class="pageScroll"(?:\s|>)/.test(source), 'A bounded root is required.');
  for (const selector of ['.pageScroll', '.page', '.unifiedModeHud', '.hudAgentReplyCard', '.agentProfileStatus']) assert(hasDeclaration(selector, 'overflow', 'hidden'), selector+' must bound paint.');
  assert(hasDeclaration('.unifiedModeHud', 'height', '100%') && hasDeclaration('.unifiedModeHud', 'top', '0'), 'HUD must occupy the bounded surface, not the retired 87px container.');
  assert(pxValue('.hudTopBar','left') >= 12 && pxValue('.hudBottomArea','left') >= 12, 'HUD needs safe horizontal insets.');
  assert(pxValue('.hudTopBar','width') <= 416 && pxValue('.hudBottomArea','width') <= 416, 'HUD widths must fit both surfaces.');
  assert(hasDeclaration('.hudBottomArea','flex-direction','column'), 'Reply, controls and profile need separate rows.');
  assert(hasDeclaration('.agentProfileStatus','flex','none') && !hasDeclaration('.agentProfileStatus','text-align','right'), 'Profile status must not inherit version compression.');
  assert((source.match(/class="releaseVersion"/g)||[]).length===1, 'One visible version required.');
  assert(source.includes('class="hudTopBar"') && source.includes('class="hudBottomArea"') && source.includes('class="agentProfileStatus"'), 'Required HUD regions missing.');
  assert(/@media\s*\(max-height:\s*180px\)/.test(style), 'Compact layout required.');
  assert(!source.includes('<scroll-view') && !source.includes('<button') && !/ink:(?:if|elif|else)\b/.test(source), 'Stable single HUD required.');
  for (const handler of ['onShow','onHide','onKeyDown','onKeyUp','cleanupChatModel','refreshAgentAndApiTools']) assert(source.includes(handler), handler+' required.');
  assert(!source.includes('saveSettings({ token })'), 'Do not persist raw token in settings.');
  assert(!source.includes('单击请 Agent 审阅') && !source.includes('单击打断 / 审阅'), 'Retired observer review must not remain in device Agent HUD instructions.');
  assert(source.includes('单击接收设备消息') && source.includes('单击打断 / 接收'), 'Device Agent HUD must describe its actual idle reception and active interruption actions.');
  console.log('AIUI current HUD structural audit passed; real region/edge/fault checks run in Smoke-RabiLinkAiuiInkRuntime.mjs.');
