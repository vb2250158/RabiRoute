<script setup lang="ts">
import { computed, onMounted, ref, onBeforeUnmount, watch } from "vue";
import { userFacingError } from "../userFacingError";
import { useGatewayStore } from "../stores/gatewayStore";
import { useSpeechStore } from "../stores/speechStore";
import PersonaAvatar from "../components/PersonaAvatar.vue";
import { hotDeliveryEnabled, speechPushModeForHotDelivery } from "../speech/speechDeliveryMode";
import { configNameFor, isAdapterDisabled } from "../utils/gatewayHelpers";
import { applySpeechRouteVariableDefaults } from "@shared/speechControlContract";
import MessageEndpointDependencyPanel from "./MessageEndpointDependencyPanel.vue";

const store = useGatewayStore();

const speech = useSpeechStore();

const runtime = computed(() => store.selectedRuntime);

const personaAvatarUrl = computed(() => (runtime.value.roleInfo?.options || [])
  .find(option => option.value === store.selectedGateway?.agentRoleId)?.avatarUrl || "");

const speechDefaultVariables = applySpeechRouteVariableDefaults(undefined);

const speechAdapterActionBusy = ref(false);

const speechAdapterActionError = ref("");

let speechConfigSaveTimer = 0;
let disposed = false;

onMounted(() => { void speech.refreshPersonas().catch(() => undefined); });

const gateway = computed(() => store.selectedGateway);

const speechPersonaConfig = computed(() => speech.personas.find(item => item.id === gateway.value?.agentRoleId));

const personaConfigRoute = computed(() => gateway.value
  ? `/persona/${encodeURIComponent(configNameFor(gateway.value))}`
  : "/persona");

async function persistAndSyncSpeechAdapter(routeId = gateway.value?.id): Promise<void> {
  if (disposed || !routeId || gateway.value?.id !== routeId) return;
  speechAdapterActionBusy.value = true;
  speechAdapterActionError.value = "";
  try {
    await store.save(routeId);
    await speech.reconcileMicrophone();
  } catch (cause) {
    speechAdapterActionError.value = userFacingError(cause);
  } finally {
    speechAdapterActionBusy.value = false;
  }
}

function scheduleSpeechConfigSave(): void {
  window.clearTimeout(speechConfigSaveTimer);
  if (!gateway.value || isAdapterDisabled(gateway.value, "speech")) return;
  const routeId = gateway.value.id;
  speechConfigSaveTimer = window.setTimeout(() => void persistAndSyncSpeechAdapter(routeId), 700);
}

function speechVariable(name: string, fallback = ""): string {
  return String(gateway.value?.routeVariables?.[name] ?? fallback);
}

function setSpeechVariable(name: string, value: unknown): void {
  if (!gateway.value) return;
  gateway.value.routeVariables = gateway.value.routeVariables ?? {};
  gateway.value.routeVariables[name] = String(value ?? "");
  store.touch();
  scheduleSpeechConfigSave();
}

function setSpeechHotDelivery(value: unknown): void {
  if (!gateway.value) return;
  gateway.value.speechPushMode = speechPushModeForHotDelivery(value === true);
  store.touch();
  scheduleSpeechConfigSave();
}

function setSpeechAutoPlay(value: unknown): void {
  if (!gateway.value) return;
  const enabled = value === true;
  setSpeechVariable("speechAutoPlay", String(enabled));
  gateway.value.pipeline = { ...gateway.value.pipeline, ttsPlay: enabled };
  store.touch();
}
watch(() => gateway.value?.id, () => { window.clearTimeout(speechConfigSaveTimer); });
onBeforeUnmount(() => { disposed = true; window.clearTimeout(speechConfigSaveTimer); });

defineExpose({ onEnabledChange: () => persistAndSyncSpeechAdapter() });

const endpointProps = defineProps<{ context?: import("./messageEndpointCardContext").MessageEndpointCardContext }>();
const context = computed(() => endpointProps.context);

</script>
<template>
  <template v-if="gateway">
    <MessageEndpointDependencyPanel :scan="context?.scan" :loading="context?.scanLoading" :error="context?.scanError" @refresh="context?.refreshScan?.()"  />
<div class="catalog-param-grid">
                    <v-alert v-if="speechAdapterActionError" class="full-span" type="error" variant="tonal" density="compact">
                      {{ speechAdapterActionError }}
                    </v-alert>
                    <div class="full-span">
                      <v-switch
                        :model-value="hotDeliveryEnabled(gateway.speechPushMode)"
                        color="primary"
                        label="热投递"
                        hint="开启（hot）：每段 ASR 立即投递。关闭（keyword）：未命中关键词时只记录，命中当前角色关键词时才投递。"
                        persistent-hint
                        @update:model-value="setSpeechHotDelivery"
                      />
                      <v-alert
                        v-if="!hotDeliveryEnabled(gateway.speechPushMode) && !(gateway.speechTriggerKeywords || []).length"
                        class="mt-2"
                        type="warning"
                        variant="tonal"
                        density="compact"
                      >
                        <div>当前角色没有语音唤醒关键词。关闭热投递后，转写仍会记录，但不会唤醒 Agent。</div>
                        <v-btn
                          class="mt-2"
                          size="small"
                          variant="tonal"
                          prepend-icon="mdi-account-cog-outline"
                          :to="personaConfigRoute"
                        >
                          配置角色关键词
                        </v-btn>
                      </v-alert>
                    </div>
                    <div class="full-span persona-speech-summary">
                      <div>
                        <PersonaAvatar :role-id="gateway.agentRoleId || ''" :avatar-url="personaAvatarUrl" :size="42" />
                        <span>角色</span>
                        <b>{{ gateway.agentRoleId || "未选择" }}</b>
                      </div>
                      <div>
                        <span>TTS 模型</span>
                        <b>{{ speechPersonaConfig?.defaultModel || "由角色 voice-profile 配置" }}</b>
                      </div>
                      <div>
                        <span>语言</span>
                        <b>{{ speechPersonaConfig?.language || "由角色 voice-profile 配置" }}</b>
                      </div>
                      <div>
                        <span>声音风格</span>
                        <b>{{ speechPersonaConfig?.voiceStyleSummary || speechPersonaConfig?.instructions || "尚未配置" }}</b>
                      </div>
                    </div>
                    <v-alert class="full-span" type="info" variant="tonal" density="compact">
                      当前 Route 只负责订阅主机 ASR 广播、热投递/角色关键词策略和是否播放回复。ASR 模型、麦克风、VAD 与切句参数属于整台电脑，请到“语音服务”统一设置；TTS 模型、声线、语言、语速和发声说明归当前角色的 <code>voice/voice-profile.json</code> 管理。
                    </v-alert>
                    <v-switch
                      color="primary"
                      label="Agent 回复自动排队播放"
                      :model-value="speechVariable('speechAutoPlay', speechDefaultVariables.speechAutoPlay) !== 'false'"
                      @update:model-value="setSpeechAutoPlay"
                    />
                    <v-alert class="full-span" type="warning" variant="tonal" density="compact">
                      主机只做一次 ASR，再把同一份文字广播给订阅 Route；不会为每个角色重复占用麦克风或重复跑识别模型。
                    </v-alert>
                  </div>
  </template>
</template>
