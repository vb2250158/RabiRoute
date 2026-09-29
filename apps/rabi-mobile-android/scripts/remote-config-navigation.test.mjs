import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../app/src/main/java/com/rabi/link/MainActivity.kt', import.meta.url), 'utf8');
const chinese = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const english = readFileSync(new URL('../README_en.md', import.meta.url), 'utf8');
const tools = source.slice(source.indexOf('private fun toolsCard()'), source.indexOf('private fun conversationCard()'));
const navigation = source.slice(source.indexOf('private fun openRemoteConfig()'), source.indexOf('private fun refreshStatus('));

test('settings entry explains the Relay login and target-computer selection', () => {
  assert.match(tools, /secondary\("电脑与 Agent 设置"\) \{ openRemoteConfig\(\) \}/);
  for (const text of ['先登录 Relay 管理', '选择目标电脑', '进入其 WebGUI', 'Agent 模型、会话', '不会直接打开当前电脑']) assert.ok(tools.includes(text));
  assert.ok(!tools.includes('打开远程配置'));
});

test('Skill and MCP claims require the actual host and do not imply mobile management', () => {
  assert.ok(tools.includes('Skill / MCP 需实际 Agent 宿主支持并确认加载'));
  assert.ok(tools.includes('手机当前不提供直接管理'));
});

test('navigation remains the unchanged public manage entry without target or credential interpolation', () => {
  assert.match(navigation, /val url = relayBaseUrl\(\)/);
  assert.ok(navigation.includes('android.net.Uri.parse("$url/manage")'));
  assert.ok(navigation.includes('if (url.isBlank()) return showGuidance('));
  assert.equal((navigation.match(/startActivity\(/g) || []).length, 1);
  assert.doesNotMatch(navigation, /selectedPc|username|workerId|putExtra|appendQueryParameter|mobile\/webgui/);
  assert.doesNotMatch(navigation, /Uri\.parse\([^\n]*(?:token|Token)/);
});

test('both readmes state navigation, capability and acceptance boundaries', () => {
  for (const document of [chinese, english]) {
    assert.ok(document.includes('“电脑与 Agent 设置”'));
    assert.ok(document.includes('`/manage`'));
    assert.ok(document.includes('Skill / MCP'));
  }
  assert.ok(chinese.includes('尚未完成本轮 APK 构建和真机页面验收'));
  assert.ok(english.includes('APK build and physical-device page acceptance for this change remain pending'));
});
