<script setup lang="ts">
import { computed, ref } from "vue";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
import { useRouter } from "vue-router";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import { applyAdapterDefaults, configNameFor } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { routeScopedRuntimePath } from "../../../../../ribiwebgui/src/routeScopedNavigation";
import MessageEndpointDependencyPanel from "../../../../../ribiwebgui/src/messageEndpoints/MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const router = useRouter();

const runtime = computed(() => store.selectedRuntime);

const weixinLoginBusy = ref(false);

const weixinLoginError = ref("");
const bindingMode = ref<"owner" | "other">("owner");
const verificationPin = ref("");

const gateway = computed(() => store.selectedGateway);

const weixinState = computed(() => runtime.value.gatewayStatus?.messageAdapters?.weixin || {} as Record<string, any>);

async function requestWeixinAction(action: "login" | "pin" | "logout"): Promise<void> {
  if (!gateway.value || weixinLoginBusy.value) return;
  weixinLoginBusy.value = true;
  weixinLoginError.value = "";
  try {
    const body = action === "login" ? { mode: bindingMode.value }
      : action === "pin" ? { pin: verificationPin.value.trim(), attemptId: weixinState.value.loginAttemptId } : {};
    verificationPin.value = "";
    const response = await fetch(`/api/message/weixin/routes/${encodeURIComponent(gateway.value.id)}/${action}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
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
const endpointProps = defineProps<{ context?: import("../../../../../ribiwebgui/src/messageEndpoints/messageEndpointCardContext").MessageEndpointCardContext }>();
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
                            <v-text-field v-model="gateway.weixinBaseUrl" class="full-span" label="微信机器人 iLink API" placeholder="https://ilinkai.weixin.qq.com" @update:model-value="touch" />
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
                      <v-img :src="weixinState.qrCodeDataUrl" width="320" max-width="100%" aspect-ratio="1" alt="微信机器人二维码" />
                      <span class="section-note">{{ weixinState.qrStatus === "real_name_required" ? "请用本人微信完成实名授权。" : "请使用手机微信扫码。" }}</span>
                      <form v-if="String(weixinState.qrStatus || '').includes('need_verifycode')" class="d-flex ga-2 align-center"
                        @submit.prevent="requestWeixinAction('pin')">
                        <v-text-field v-model="verificationPin" label="手机微信验证码" type="password" inputmode="numeric" hide-details autocomplete="one-time-code" />
                        <v-btn type="submit" :loading="weixinLoginBusy" :disabled="!verificationPin.trim()">提交</v-btn>
                      </form>
                    </div>
                    <v-alert v-if="weixinState.lastError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinState.lastError }}
                    </v-alert>
                    <v-alert v-if="weixinLoginError" type="error" variant="tonal" density="compact" class="mt-2 full-span">
                      {{ weixinLoginError }}
                    </v-alert>
                    <div class="agent-action-bar full-span mt-2">
                      <v-select v-if="weixinState.loginRequired && !weixinState.qrCodeDataUrl" v-model="bindingMode"
                        :items="[{ title: '绑定本人微信', value: 'owner' }, { title: '邀请他人绑定', value: 'other' }]"
                        label="绑定方式" density="compact" hide-details />
                      <div class="d-flex ga-2 flex-wrap">
                        <v-btn
                          v-if="weixinState.loginRequired && !weixinState.qrCodeDataUrl"
                          size="small"
                          color="warning"
                          variant="tonal"
                          prepend-icon="mdi-qrcode"
                          :loading="weixinLoginBusy"
                          @click="requestWeixinAction('login')"
                        >
                          生成登录二维码
                        </v-btn>
                        <v-btn v-if="runtime.running && weixinState.credentialsRetained" size="small" variant="text"
                          :loading="weixinLoginBusy" @click="requestWeixinAction('logout')">退出登录</v-btn>
                        <v-btn size="small" variant="tonal" prepend-icon="mdi-refresh" @click="store.load">刷新状态</v-btn>
                        <v-btn size="small" variant="text" prepend-icon="mdi-text-box-search-outline" @click="openRuntimeLog">打开日志</v-btn>
                      </div>
                    </div>
                  </template>
  </template>
</template>
