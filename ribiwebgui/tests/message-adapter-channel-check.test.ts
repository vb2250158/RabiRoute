import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const pageSource = fs.readFileSync(new URL("../src/pages/RouteConfigPage.vue", import.meta.url), "utf8");
const styleSource = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("message configuration exposes channel status and real Agent delivery tests", () => {
  const button = pageSource.indexOf('prepend-icon="mdi-connection"');
  const folderButton = pageSource.indexOf('prepend-icon="mdi-folder-open-outline"');
  assert.ok(button >= 0 && button < folderButton, "channel check belongs in the page header before file operations");
  assert.match(pageSource, /async function runChannelCheck\(\): Promise<void> \{[\s\S]*const scanAgents = runAgentScan;[\s\S]*Promise\.all\(\[runMessageAdapterScan\(\), scanAgents\(\)\]\)/);
  assert.match(pageSource, /function openChannelCheckDialog\(\): void \{[\s\S]*channelCheckDialogOpen\.value = true;[\s\S]*void runChannelCheck\(\);/);
  assert.match(pageSource, /<v-dialog v-model="channelCheckDialogOpen" max-width="1180" scrollable>/);
  assert.match(pageSource, /class="channel-topology"/);
  assert.match(pageSource, /class="channel-topology-column channel-topology-messages"/);
  assert.match(pageSource, /class="channel-topology-node channel-topology-manager-node"/);
  assert.match(pageSource, /class="channel-topology-column channel-topology-agents"/);
  assert.match(pageSource, /点击 Agent 节点的“投递测试”会发送一条带测试编号的真实消息/);
  assert.match(pageSource, /v-for="item in channelCheckItems"/);
  assert.match(pageSource, /v-for="agent in channelCheckAgentItems"/);
  assert.match(pageSource, /function enabledChannelCheckScans\(\)[\s\S]*filter\(item => !isAdapterDisabled/);
  assert.match(pageSource, /@click="openChannelCheckDetails\(item\.type\)"/);
  assert.match(pageSource, /async function runAgentDeliveryTest\(type: AgentAdapterType\): Promise<void>/);
  assert.match(pageSource, /store\.testAgentDelivery\(gateway\.value\.id, type\)/);
  assert.match(pageSource, /@click="runAgentDeliveryTest\(agent\.type\)"/);
  assert.match(pageSource, /@click="openChannelCheckAgentDetails\(agent\.type\)"/);
  assert.match(pageSource, /目标 Agent 已收到测试消息/);
  assert.match(styleSource, /\.channel-topology \{[\s\S]*grid-template-columns: minmax\(240px, 1fr\) 56px minmax\(180px, \.7fr\) 56px minmax\(240px, 1fr\)/);
  assert.match(styleSource, /@media \(max-width: 960px\) \{[\s\S]*\.channel-topology \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styleSource, /\.channel-topology-manager-node \{[\s\S]*grid-template-columns: 1fr/);
  assert.match(styleSource, /\.channel-topology-node-actions \{/);
  assert.match(styleSource, /\.channel-delivery-test-details \{/);
});
