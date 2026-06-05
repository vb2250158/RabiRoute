<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import type { AgentAdapterType, MessageAdapterType } from "../types";
import { adapterLabel, defaultHeartbeatMessage, gatewayAdapterTypes } from "../utils/gatewayHelpers";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();

const store = useGatewayStore();
const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const activeStep = ref(1);
const form = reactive({
  adapters: ["napcat"] as MessageAdapterType[],
  agentAdapters: ["codexDesktop"] as AgentAdapterType[],
  agentRoleId: "Rabi",
  codexThreadName: "QQ 消息监听",
  codexCwd: "",
  gatewayPort: 8790,
  napcatHttpUrl: "http://127.0.0.1:3000",
  heartbeatIntervalSeconds: 900,
  heartbeatMessage: defaultHeartbeatMessage(),
  webhookPort: 8790,
  webhookPath: "/webhook"
});

const adapterChoices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> = [
  { type: "napcat", title: "NapCat / OneBot", note: "QQ 群聊、私聊实时入口", icon: "mdi-message-badge-outline" },
  { type: "heartbeat", title: "定时触发", note: "按固定间隔投递内部提醒", icon: "mdi-timer-outline" },
  { type: "webhook", title: "Webhook", note: "接收外部系统 POST 事件", icon: "mdi-webhook" },
  { type: "disabled", title: "暂不启用", note: "先保存 Agent 和人格配置", icon: "mdi-pause-circle-outline" }
];

const messageReady = computed(() => {
  if (form.adapters.includes("disabled")) return true;
  if (form.adapters.includes("napcat") && (!form.gatewayPort || !form.napcatHttpUrl.trim())) return false;
  if (form.adapters.includes("heartbeat") && !form.heartbeatIntervalSeconds) return false;
  if (form.adapters.includes("webhook") && (!form.webhookPort || !form.webhookPath.trim())) return false;
  return form.adapters.length > 0;
});

const agentReady = computed(() => Boolean(form.codexThreadName.trim() && form.codexCwd.trim() && form.agentAdapters.length));
const personaReady = computed(() => Boolean(form.agentRoleId.trim()));
const canSave = computed(() => messageReady.value && agentReady.value && personaReady.value);
const completedSteps = computed(() => [messageReady.value, agentReady.value, personaReady.value].filter(Boolean).length);

const steps = computed(() => [
  {
    value: 1,
    title: "消息入口",
    note: form.adapters.map(adapterLabel).join(" + "),
    done: messageReady.value,
    icon: "mdi-numeric-1"
  },
  {
    value: 2,
    title: "Agent 绑定",
    note: form.codexThreadName || "选择会话线程和工作目录",
    done: agentReady.value,
    icon: "mdi-numeric-2"
  },
  {
    value: 3,
    title: "人格与保存",
    note: form.agentRoleId || "确认默认人格",
    done: personaReady.value,
    icon: "mdi-numeric-3"
  }
]);

function syncFromGateway() {
  const gateway = store.selectedGateway;
  form.adapters = gateway ? gatewayAdapterTypes(gateway) : ["napcat"];
  form.agentAdapters = Array.isArray(gateway?.agentAdapters) && gateway.agentAdapters.length
    ? [...gateway.agentAdapters]
    : ["codexDesktop"];
  form.agentRoleId = gateway?.agentRoleId || "Rabi";
  form.codexThreadName = gateway?.codexThreadName || "QQ 消息监听";
  form.codexCwd = gateway?.codexCwd || "";
  form.gatewayPort = Number(gateway?.gatewayPort || 8790);
  form.napcatHttpUrl = gateway?.napcatHttpUrl || "http://127.0.0.1:3000";
  form.heartbeatIntervalSeconds = Number(gateway?.heartbeatIntervalSeconds || 900);
  form.heartbeatMessage = gateway?.heartbeatMessage || defaultHeartbeatMessage();
  form.webhookPort = Number(gateway?.webhookPort || gateway?.gatewayPort || 8790);
  form.webhookPath = gateway?.webhookPath || "/webhook";
}

watch(
  () => [open.value, store.selectedGateway?.id] as const,
  ([visible]) => {
    if (visible) {
      syncFromGateway();
      activeStep.value = messageReady.value ? (agentReady.value ? 3 : 2) : 1;
    }
  },
  { immediate: true }
);

function toggleAdapter(type: MessageAdapterType) {
  if (type === "disabled") {
    form.adapters = form.adapters.includes("disabled") ? ["napcat"] : ["disabled"];
    return;
  }

  const next = new Set(form.adapters.filter(adapter => adapter !== "disabled"));
  if (next.has(type)) next.delete(type);
  else next.add(type);
  form.adapters = next.size ? [...next] : ["napcat"];
}

function goNext() {
  if (activeStep.value < 3) activeStep.value += 1;
}

async function apply() {
  store.applyQuickSetup(form);
  await store.save();
  open.value = false;
}
</script>

<template>
  <v-dialog v-model="open" max-width="1040" persistent>
    <v-card class="app-card quick-setup-card">
      <v-card-title class="quick-setup-title">
        <v-avatar rounded="lg" size="44">
          <v-img src="/assets/rabiroute-icon.png" alt="RabiRoute" />
        </v-avatar>
        <div class="min-w-0">
          <div class="section-title">快速配置 RabiRoute</div>
          <div class="section-note">按消息入口、Agent 绑定、人格确认三步完成首次配置。</div>
        </div>
        <v-spacer />
        <v-chip color="secondary" variant="tonal" size="small">
          {{ completedSteps }}/3 已完成
        </v-chip>
      </v-card-title>

      <v-card-text>
        <div class="quick-setup-layout">
          <aside class="quick-setup-rail">
            <v-timeline align="start" side="end" density="compact" truncate-line="both" class="quick-setup-timeline">
              <v-timeline-item
                v-for="step in steps"
                :key="step.value"
                :dot-color="step.done ? 'success' : activeStep === step.value ? 'secondary' : 'grey-lighten-1'"
                :icon="step.done ? 'mdi-check' : step.icon"
                fill-dot
                size="small"
              >
                <button class="quick-step-button" :class="{ active: activeStep === step.value }" @click="activeStep = step.value">
                  <span>{{ step.title }}</span>
                  <small>{{ step.note }}</small>
                </button>
              </v-timeline-item>
            </v-timeline>

            <div class="quick-setup-summary">
              <div class="status-row"><span>当前路由</span><b>{{ store.selectedGateway ? store.configNameFor(store.selectedGateway) : "新建配置" }}</b></div>
              <div class="status-row"><span>版本</span><b>v{{ store.meta.version }}</b></div>
            </div>
          </aside>

          <section class="quick-setup-main">
            <v-window v-model="activeStep">
              <v-window-item :value="1">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">选择消息入口</div>
                    <div class="section-note">可以组合多个入口；禁用入口时仍可先保存 Agent 和人格配置。</div>
                  </div>
                </div>

                <div class="adapter-grid mb-4">
                  <div
                    v-for="choice in adapterChoices"
                    :key="choice.type"
                    class="adapter-card compact"
                    :class="{ active: form.adapters.includes(choice.type) }"
                    @click="toggleAdapter(choice.type)"
                  >
                    <div class="d-flex justify-space-between align-start">
                      <v-icon color="secondary">{{ choice.icon }}</v-icon>
                      <v-icon :color="form.adapters.includes(choice.type) ? 'secondary' : 'grey-lighten-1'">
                        {{ form.adapters.includes(choice.type) ? "mdi-check-circle" : "mdi-circle-outline" }}
                      </v-icon>
                    </div>
                    <div class="font-weight-bold mt-3">{{ choice.title }}</div>
                    <div class="section-note mt-1">{{ choice.note }}</div>
                  </div>
                </div>

                <div class="form-grid" v-if="!form.adapters.includes('disabled')">
                  <template v-if="form.adapters.includes('napcat')">
                    <v-text-field v-model.number="form.gatewayPort" type="number" label="NapCat WebSocket 端口" />
                    <v-text-field v-model="form.napcatHttpUrl" label="NapCat HTTP 地址" />
                  </template>
                  <template v-if="form.adapters.includes('heartbeat')">
                    <v-text-field v-model.number="form.heartbeatIntervalSeconds" type="number" label="定时触发间隔（秒）" />
                    <v-text-field v-model="form.heartbeatMessage" label="定时触发消息" />
                  </template>
                  <template v-if="form.adapters.includes('webhook')">
                    <v-text-field v-model.number="form.webhookPort" type="number" label="Webhook 端口" />
                    <v-text-field v-model="form.webhookPath" label="Webhook 路径" />
                  </template>
                </div>
                <v-alert v-else type="info" variant="tonal">你可以先完成 Agent 绑定，稍后再回到“路由配置”启用消息入口。</v-alert>
              </v-window-item>

              <v-window-item :value="2">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">绑定 Agent 会话</div>
                    <div class="section-note">RabiRoute 会把命中的消息投递到这个会话和工作目录。</div>
                  </div>
                </div>
                <div class="form-grid">
                  <v-select
                    v-model="form.agentAdapters"
                    :items="[
                      { title: 'Codex Desktop', value: 'codexDesktop' },
                      { title: 'Codex App', value: 'codexApp' }
                    ]"
                    label="Agent 处理端"
                    multiple
                    chips
                  />
                  <v-text-field v-model="form.codexThreadName" label="Agent 会话线程名" />
                  <v-text-field v-model="form.codexCwd" class="full-span" label="Agent 工作目录" placeholder="C:/Path/To/Project" />
                </div>
              </v-window-item>

              <v-window-item :value="3">
                <div class="section-title-row">
                  <div>
                    <div class="section-title">确认人格与配置</div>
                    <div class="section-note">保存后会写入与旧 WebGUI 相同的 gateway 数据结构。</div>
                  </div>
                </div>
                <v-text-field v-model="form.agentRoleId" label="默认人格 ID" class="mb-4" />
                <div class="quick-review">
                  <div class="status-row"><span>消息入口</span><b>{{ form.adapters.map(adapterLabel).join(" + ") }}</b></div>
                  <div class="status-row"><span>Agent</span><b>{{ form.agentAdapters.join(" + ") }}</b></div>
                  <div class="status-row"><span>线程</span><b>{{ form.codexThreadName || "未填写" }}</b></div>
                  <div class="status-row"><span>工作目录</span><b>{{ form.codexCwd || "未填写" }}</b></div>
                  <div class="status-row"><span>人格</span><b>{{ form.agentRoleId || "未填写" }}</b></div>
                </div>
                <v-alert v-if="!canSave" class="mt-4" type="warning" variant="tonal">
                  还有必要字段没有填写，请回到对应步骤补全。
                </v-alert>
              </v-window-item>
            </v-window>
          </section>
        </div>
      </v-card-text>

      <v-card-actions class="px-6 pb-5">
        <v-btn variant="text" :disabled="activeStep === 1" @click="activeStep -= 1">上一步</v-btn>
        <v-spacer />
        <v-btn variant="text" @click="open = false">稍后再配</v-btn>
        <v-btn v-if="activeStep < 3" color="primary" variant="tonal" @click="goNext">下一步</v-btn>
        <v-btn v-else color="primary" :disabled="!canSave" :loading="store.saving" @click="apply">保存配置</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
