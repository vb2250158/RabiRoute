<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../userFacingError";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import { applyAdapterDefaults, configNameFor } from "../utils/gatewayHelpers";
import { routeScopedRuntimePath } from "../routeScopedNavigation";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const router = useRouter();

const runtime = computed(() => store.selectedRuntime);

const weixinLoginBusy = ref(false);

const weixinLoginError = ref("");

const gateway = computed(() => store.selectedGateway);

const weixinState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.weixin || {} as Record<string, any>);

async function requestPersonalWeixinLogin(): Promise<void> {
  if (!gateway.value || weixinLoginBusy.value) return;
  weixinLoginBusy.value = true;
  weixinLoginError.value = "";
  try {
    const response = await fetch(`/gateways/${encodeURIComponent(gateway.value.id)}/weixin-login`, { method: "POST" });
    const payload = await response.json().catch(() => ({})) as { message?: string };
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    await store.load();
  } catch (error) {
    weixinLoginError.value = userFacingError(error);
  } finally {
    weixinLoginBusy.value = false;
  }
}

function weixinSessionPhaseLabel(value: unknown): string {
  const labels: Record<string, string> = {
    never_logged_in: "从未登录",
    restoring: "正在恢复",
    restored: "已恢复",
    temporarily_unreachable: "暂时不可达（凭据保留）",
    invalid: "会话已失效"
  };
  return labels[String(value || "")] || "未知";
}

function touch(): void { if (gateway.value) applyAdapterDefaults(gateway.value); store.touch(); }

function openRuntimeLog(): void {
  const name = store.selectedGateway ? configNameFor(store.selectedGateway) : "";
  void router.push(routeScopedRuntimePath(name));
}
const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-expansion-panels class="full-span" variant="accordion">
                      <v-expansion-panel>
                        <v-expansion-panel-title>高级设置（通常无需修改）</v-expansion-panel-title>
                        <v-expansion-panel-text>
                          <div class="catalog-param-grid">
                            <v-text-field v-model="gateway.weixinBaseUrl" class="full-span" label="个人微信 iLink API" placeholder="https://ilinkai.weixin.qq.com" @update:model-value="touch" />
                            <v-text-field v-model="gateway.weixinBotType" label="Bot Type" placeholder="3" @update:model-value="touch" />
                          </div>
                        </v-expansion-panel-text>
                      </v-expansion-panel>
                    </v-expansion-panels>
                  </div>
<template v-if="runtime.running !== undefined">
                    <div class="status-row"><span>运行状态</span><b>{{ runtime.running ? "运行中" : "已停止" }}</b></div>
                    <div class="status-row"><span>会话</span><b :class="weixinState.loggedIn ? 'text-success' : 'text-warning'">{{ weixinState.message || "状态未知" }}</b></div>
                    <div class="status-row"><span>恢复状态</span><b>{{ weixinSessionPhaseLabel(weixinState.sessionPhase) }}</b></div>
                    <div class="status-row"><span>凭据保留</span><b>{{ weixinState.credentialsRetained ? "是" : "否" }}</b></div>
                    <div class="status-row"><span>扫码状态</span><b>{{ weixinState.qrStatus || "-" }}</b></div>
                    <div class="status-row"><span>最近消息</span><b>{{ weixinState.lastMessageAt || "-" }}</b></div>
                    <div class="status-row"><span>消息数</span><b>{{ weixinState.messageCount ?? 0 }}</b></div>
                    <div v-if="!weixinState.loggedIn && weixinState.qrCodeDataUrl" class="full-span d-flex flex-column align-center ga-2 mt-2">
                      <v-img :src="weixinState.qrCodeDataUrl" width="320" max-width="100%" aspect-ratio="1" alt="个人微信登录二维码" />
                      <span class="section-note">请使用手机微信扫码；二维码约 5 分钟后自动刷新。</span>
                    </div>
                    <v-alert v-if="weixinState.lastError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinState.lastError }}
                    </v-alert>
                    <v-alert v-if="weixinLoginError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinLoginError }}
                    </v-alert>
                    <div class="agent-action-bar full-span mt-2">
                      <div class="agent-action-status"><span class="section-note">登录态只保存在当前 Route 的运行期 data 目录，不写进公开配置。</span></div>
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          v-if="weixinState.loginRequired && !weixinState.qrCodeDataUrl"
                          size="small"
                          color="warning"
                          variant="tonal"
                          prepend-icon="mdi-qrcode"
                          :loading="weixinLoginBusy"
                          @click="requestPersonalWeixinLogin"
                        >
                          生成登录二维码
                        </v-btn>
                        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" @click="store.load">刷新状态</v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">打开日志</v-btn>
                      </div>
                    </div>
                  </template>
  </template>
</template>
