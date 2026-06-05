<script setup lang="ts">
import { computed } from "vue";
import { useGatewayStore } from "../stores/gatewayStore";
import type { MessageAdapterType } from "../types";
import { adapterLabel, applyAdapterDefaults, gatewayAdapterTypes, roleMessageDataDirFor, routeConfigPathFor, setGatewayAdapters } from "../utils/gatewayHelpers";

const store = useGatewayStore();
const adapterChoices: Array<{ type: MessageAdapterType; title: string; note: string; icon: string }> = [
  { type: "napcat", title: "NapCat / OneBot", note: "接收 QQ 群聊和私聊实时消息", icon: "mdi-message-badge-outline" },
  { type: "heartbeat", title: "定时触发", note: "按间隔主动生成内部消息", icon: "mdi-timer-outline" },
  { type: "webhook", title: "Webhook", note: "接收外部系统 POST 事件", icon: "mdi-webhook" },
  { type: "disabled", title: "禁用消息端", note: "保留配置但不接收消息", icon: "mdi-pause-circle-outline" }
];

const gateway = computed(() => store.selectedGateway);
const adapters = computed(() => gateway.value ? gatewayAdapterTypes(gateway.value) : []);
const codexCwdOptions = computed(() => {
  const values = new Set<string>();
  store.gateways.forEach(item => {
    if (item.codexCwd) values.add(item.codexCwd);
  });
  return [...values];
});

function toggleAdapter(type: MessageAdapterType): void {
  if (!gateway.value) return;
  if (type === "disabled") {
    setGatewayAdapters(gateway.value, adapters.value.includes("disabled") ? ["napcat"] : ["disabled"]);
  } else {
    const next = new Set(adapters.value);
    next.delete("disabled");
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setGatewayAdapters(gateway.value, [...next] as MessageAdapterType[]);
  }
  applyAdapterDefaults(gateway.value);
  store.touch();
}

function touch(): void {
  if (gateway.value) applyAdapterDefaults(gateway.value);
  store.touch();
}
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">路由配置</h1>
        <div class="page-subtitle">配置消息入口、Agent 投递目标和本地数据目录。</div>
      </div>
      <div class="d-flex ga-2 flex-wrap" v-if="gateway">
        <v-switch v-model="gateway.enabled" label="启用" color="success" hide-details @update:model-value="touch" />
        <v-btn prepend-icon="mdi-file-cog-outline" variant="tonal" @click="store.openConfigFile('routes', gateway.id, gateway.agentRoleId || '')">
          打开路由配置
        </v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息适配端</div>
            <div class="section-note">多个消息入口可以并存，定时触发会直接路由给 Agent。</div>
          </div>
          <v-chip color="secondary" variant="tonal">{{ adapters.map(adapterLabel).join(" + ") }}</v-chip>
        </div>

        <div class="adapter-grid mb-4">
          <div
            v-for="choice in adapterChoices"
            :key="choice.type"
            class="adapter-card"
            :class="{ active: adapters.includes(choice.type) }"
            @click="toggleAdapter(choice.type)"
          >
            <div class="d-flex justify-space-between align-start">
              <v-icon color="secondary">{{ choice.icon }}</v-icon>
              <v-icon :color="adapters.includes(choice.type) ? 'secondary' : 'grey-lighten-1'">
                {{ adapters.includes(choice.type) ? "mdi-check-circle" : "mdi-circle-outline" }}
              </v-icon>
            </div>
            <div class="font-weight-bold mt-3">{{ choice.title }}</div>
            <div class="section-note mt-1">{{ choice.note }}</div>
          </div>
        </div>

        <div class="form-grid" v-if="!adapters.includes('disabled')">
          <template v-if="adapters.includes('napcat')">
            <v-text-field v-model.number="gateway.gatewayPort" type="number" label="NapCat WebSocket 端口" @update:model-value="touch" />
            <v-text-field v-model="gateway.napcatHttpUrl" label="NapCat HTTP 地址" @update:model-value="touch" />
            <v-text-field v-model="gateway.napcatAccessToken" class="full-span" label="NapCat Access Token" placeholder="可选" @update:model-value="touch" />
          </template>
          <template v-if="adapters.includes('heartbeat')">
            <v-text-field v-model.number="gateway.heartbeatIntervalSeconds" type="number" label="定时触发间隔（秒）" @update:model-value="touch" />
            <v-text-field v-model="gateway.heartbeatMessage" label="定时触发消息" @update:model-value="touch" />
          </template>
          <template v-if="adapters.includes('webhook')">
            <v-text-field v-model.number="gateway.webhookPort" type="number" label="Webhook 端口" @update:model-value="touch" />
            <v-text-field v-model="gateway.webhookPath" label="Webhook 路径" placeholder="/webhook" @update:model-value="touch" />
          </template>
        </div>
        <v-alert v-else type="warning" variant="tonal">当前路由不接收任何消息入口。</v-alert>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">Agent 端</div>
            <div class="section-note">配置接收消息的会话、工作目录和处理端。</div>
          </div>
        </div>
        <div class="form-grid">
          <v-select
            v-model="gateway.agentAdapters"
            :items="[
              { title: 'Codex Desktop', value: 'codexDesktop' },
              { title: 'Codex App', value: 'codexApp' }
            ]"
            label="Agent 配置"
            multiple
            chips
            @update:model-value="touch"
          />
          <v-text-field v-model="gateway.codexThreadName" label="Agent 会话线程名" @update:model-value="touch" />
          <v-combobox
            v-model="gateway.codexCwd"
            class="full-span"
            :items="codexCwdOptions"
            label="Agent 工作目录"
            placeholder="C:/Path/To/Project"
            @update:model-value="touch"
          />
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">通用配置</div>
            <div class="section-note">显示名称、数据目录和配置文件位置。</div>
          </div>
        </div>
        <div class="form-grid">
          <v-text-field v-model="gateway.name" label="显示名称" @update:model-value="touch" />
          <v-text-field v-model="gateway.configName" label="配置名" @update:model-value="touch" />
          <v-text-field v-model="gateway.dataDir" label="数据目录" :placeholder="roleMessageDataDirFor(gateway)" @update:model-value="touch" />
          <v-text-field v-model="gateway.rolesDir" label="角色目录" placeholder="./data/roles" @update:model-value="touch" />
        </div>
        <div class="status-row mt-3"><span>路由配置文件</span><b>{{ routeConfigPathFor(gateway) }}</b></div>
        <div class="status-row"><span>路由根目录</span><b>{{ store.configFiles.routeRoot || store.configFiles.manager || "data/route" }}</b></div>
      </v-card>
    </template>
  </div>
</template>
