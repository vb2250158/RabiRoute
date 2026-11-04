<script setup lang="ts">
import { userFacingError } from "../userFacingError";
import { computed, ref } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import type { AgentAdapterType } from "../types";
import type { AgentAdapterCardContext } from './agentAdapterCardContext';

const props = defineProps<{ context: AgentAdapterCardContext }>();

const store = useGatewayStore();

const gateway = computed(() => store.selectedGateway?.id === props.context.routeId ? store.selectedGateway : undefined);

const agentScan = computed(() => props.context.scanState);

const agent = { type: "marvis" as AgentAdapterType };

function touch(): void { props.context.touch(); }

async function runAgentScan(): Promise<void> { await props.context.refreshScan(); }

const openingMarvis = ref(false);

const marvisOpenResult = ref<{ ok: boolean; message: string } | null>(null);

async function openMarvis(): Promise<void> {
  if (openingMarvis.value) return;
  openingMarvis.value = true;
  marvisOpenResult.value = null;
  try {
    const resp = await fetch("/api/agent/marvis-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: gateway.value?.marvisAppId })
    });
    const body = await resp.json().catch(() => ({}));
    marvisOpenResult.value = {
      ok: resp.ok && body.ok !== false,
      message: body.message || (resp.ok ? "已尝试打开 Marvis。" : "打开 Marvis 失败。")
    };
  } catch (e: unknown) {
    marvisOpenResult.value = { ok: false, message: userFacingError(e) };
  } finally {
    openingMarvis.value = false;
  }
}
</script>
<template>
  <div v-if="gateway">
<v-alert type="info" variant="tonal" density="compact" class="mb-2">
                    当前 Marvis 适配器不会列出会话，也不会创建或复用线程；它只负责打开目标 App 并把 prompt 放到剪贴板。
                  </v-alert><div class="catalog-param-grid">
                    <v-combobox v-model="gateway.marvisAppId" :items="agentScan.marvisAppIds" label="应用 ID" placeholder="Tencent.Marvis" hint="留空使用默认 Tencent.Marvis" persistent-hint @update:model-value="touch">
                      <template #append-inner>
                        <v-progress-circular v-if="agentScan.loading" size="16" width="2" indeterminate />
                        <v-icon v-else-if="agentScan.marvisAppIds.length === 0" icon="mdi-magnify" size="18" class="scan-btn" @click.stop="runAgentScan" title="扫描" />
                      </template>
                    </v-combobox>
                  </div><div class="agent-action-bar mt-2">
                    <div class="agent-action-status">
                      <span class="section-note">可先打开 Marvis 确认桌面端可用；真正消息会在路由触发时复制为 prompt。</span>
                    </div>
                    <div class="d-flex ga-2 flex-wrap">
                      <v-btn
                        size="small"
                        variant="tonal"
                        color="primary"
                        prepend-icon="mdi-open-in-app"
                        :loading="openingMarvis"
                        :disabled="openingMarvis"
                        @click="openMarvis"
                      >
                        打开 Marvis
                      </v-btn>
                      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :loading="agentScan.loading" @click="runAgentScan">
                        重新扫描
                      </v-btn>
                    </div>
                  </div><v-alert
                    v-if="marvisOpenResult"
                    :type="marvisOpenResult.ok ? 'success' : 'error'"
                    variant="tonal"
                    density="compact"
                    class="mt-2"
                  >
                    {{ marvisOpenResult.message }}
                  </v-alert>
  </div>
</template>
