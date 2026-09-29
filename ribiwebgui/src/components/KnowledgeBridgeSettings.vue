<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import { knowledgeBridgeDraft, knowledgeBridgePatch, readKnowledgeIdentity, saveKnowledgeIdentity, knowledgeToolNames } from '../knowledgeBridgeClient';
const draft = ref(knowledgeBridgeDraft(null));
const loaded = ref(false), busy = ref(false), tokenConfigured = ref(false), uncertain = ref(false);
const message = ref(''), runtime = ref('尚未检查连接能力');
let disposed = false;
onBeforeUnmount(() => { disposed = true; draft.value.token = ''; });
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  try {
    const snapshot = await readKnowledgeIdentity();
    if (disposed) return;
    draft.value = knowledgeBridgeDraft(snapshot.bridge); tokenConfigured.value = snapshot.tokenConfigured; loaded.value = true; uncertain.value = false;
    message.value = '已读取保存配置；不代表服务已经连接。';
    const response = await fetch('/meta', { credentials: 'same-origin', cache: 'no-store' });
    const meta = await response.json();
    if (disposed) return;
    const capabilities = meta.rabiLinkRelayRuntime?.capabilities;
    runtime.value = response.ok && meta.rabiLinkRelayRuntime?.knowledgeBridgeReady === true && Array.isArray(capabilities) && capabilities.includes('knowledgebridge') ? '已报告知识桥能力，仍需实际工具调用验证' : '当前状态接口未确认知识桥能力，请在 Relay 在线 PC 中核对 knowledgebridge';
  } catch { if (!disposed) message.value = '读取失败；未改变服务器配置。'; }
  finally { if (!disposed) busy.value = false; }
}
async function save() {
  if (!loaded.value || busy.value || uncertain.value) return;
  let patch;
  try { patch = knowledgeBridgePatch(draft.value, tokenConfigured.value); }
  catch { message.value = '配置校验失败：请检查本机地址、标识、授权 JSON 和密钥长度。'; return; }
  busy.value = true;
  try {
    const snapshot = await saveKnowledgeIdentity(patch);
    if (disposed) return;
    draft.value.token = ''; tokenConfigured.value = snapshot.tokenConfigured;
    message.value = '保存已确认；请刷新核对连接能力。写权限还受设备授权与 MCP 服务限制。';
    runtime.value = '保存成功不等于连接就绪';
  } catch { if (!disposed) { uncertain.value = true; message.value = '保存结果未确认，已停止重发。请刷新权威配置核对。'; } }
  finally { if (!disposed) { draft.value.token = ''; busy.value = false; } }
}
</script>
<template>
  <v-expansion-panels class="mt-3" variant="accordion">
    <v-expansion-panel title="本机知识 MCP 安全设置">
      <v-expansion-panel-text>
        <p class="section-note">仅本机或已认证远程 WebGUI 管理用户使用。设备配置不能读取此密钥。不会启动服务或执行知识业务。</p>
        <v-btn variant="tonal" :disabled="busy" @click="refresh">读取／刷新配置（覆盖未保存编辑）</v-btn>
        <v-alert v-if="message" class="my-3" density="compact" variant="tonal">{{ message }}</v-alert>
        <p class="section-note">{{ runtime }}</p>
        <fieldset :disabled="!loaded || busy || uncertain" class="knowledge-fields">
          <v-switch v-model="draft.enabled" label="启用知识桥（默认关闭）" hide-details />
          <v-text-field v-model="draft.url" label="本机 MCP 地址" placeholder="http://127.0.0.1:端口/mcp" />
          <v-text-field v-model="draft.token" type="password" autocomplete="new-password" label="连接密钥（只写入）" :hint="tokenConfigured ? '已配置；留空保留，不返回原密钥' : '尚未配置；至少32字符，来自已配置的本机服务'" persistent-hint />
          <v-textarea v-model="draft.roles" label="允许的角色 ID（换行或逗号分隔）" rows="2" />
          <v-textarea v-model="draft.tools" label="允许的工具（换行或逗号分隔）" :hint="knowledgeToolNames.join(', ')" persistent-hint rows="3" />
          <v-switch v-model="draft.allowWrites" label="允许写入（默认关闭；近期详情阅读标记也算写入）" hide-details />
          <v-textarea v-model="draft.grants" label="设备授权 JSON 数组" hint="每项只含 appId、deviceBindingId、ownerAccountId；必须与实际设备归属一致" persistent-hint rows="5" />
          <v-btn color="primary" :disabled="!loaded || busy || uncertain" @click="save">保存知识桥设置</v-btn>
        </fieldset>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>
</template>
<style scoped>.knowledge-fields { border: 0; padding: 0; min-width: 0; }</style>
