<script setup lang="ts">
import AutomationParameterHelp from "./AutomationParameterHelp.vue";
import { computed } from "vue";
import type { GatewayDefinition, MessageEndpointType } from "../../../../../ribiwebgui/src/types";
import { useGatewayStore } from "../../../../../ribiwebgui/src/stores/gatewayStore";
import {
  adapterDefaultWebhookPath,
  applyAdapterDefaults,
  isAdapterDisabled,
  messageAdapterPolicyFor,
  setGatewayAdapters,
  setMessageAdapterPolicy,
  toggleAdapterDisabled
} from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { messageAdapterUsesAutomaticGrouping, type MessageGroupingMode, type NapCatInstanceDefinition } from "@shared/gatewayConfigModel";
import { hotDeliveryEnabled, speechPushModeForHotDelivery } from "../../../io.rabiroute.manager.speech/web/speech/speechDeliveryMode";

const props = defineProps<{ gateway: GatewayDefinition; endpoint: MessageEndpointType; expanded?: boolean }>();
const emit = defineEmits<{ removed: []; speechChanged: [] }>();
const store = useGatewayStore();
const configured = computed(() => (props.gateway.messageAdapters ?? [props.gateway.messageAdapterType ?? "napcat"]).includes(props.endpoint));
const policy = computed(() => messageAdapterPolicyFor(props.gateway, props.endpoint));
const napcat = computed(() => props.gateway.napcatInstances?.find(instance => instance.enabled !== false) ?? props.gateway.napcatInstances?.[0]);
const groupFields = [
  { field: "settleSeconds", label: "普通停顿（秒）" },
  { field: "incompleteSettleSeconds", label: "未说完等待（秒）" },
  { field: "maxWaitSeconds", label: "最长等待（秒）" }
] as const;
const reviewFields = [
  { field: "initialMessageCount", label: "首次核对消息数", min: 1 },
  { field: "maxIncrementalMessages", label: "增量返回上限", min: 2 }
] as const;

function updateRoute<Key extends keyof GatewayDefinition>(key: Key, value: GatewayDefinition[Key]): void {
  props.gateway[key] = value;
  store.touch();
}

function updateNumber(key: "qqbotCallbackPort" | "qqbotIntents" | "feishuWebhookPort" | "webhookPort", raw: unknown, max: number): void {
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 0 && value <= max) updateRoute(key, value);
}

function setEnabled(enabled: boolean | null): void {
  if ((enabled === true) === !isAdapterDisabled(props.gateway, props.endpoint)) return;
  toggleAdapterDisabled(props.gateway, props.endpoint);
  store.touch();
  if (props.endpoint === "speech") emit("speechChanged");
}

function removeEndpoint(): void {
  const configured = props.gateway.messageAdapters ?? [props.gateway.messageAdapterType ?? "napcat"];
  setGatewayAdapters(props.gateway, configured.filter(type => type !== props.endpoint));
  applyAdapterDefaults(props.gateway);
  store.touch();
  if (props.endpoint === "speech") emit("speechChanged");
  emit("removed");
}

const groupingModes = [{ title: "逐条处理", value: "off" }, { title: "仅合并到消息处理 Agent", value: "pool" },
  { title: "合并后按规则投递", value: "all" }];
const groupingMode = computed(() => policy.value.messageGrouping.mode ?? (policy.value.messageGrouping.enabled ? "pool" : "off"));

function setGroupingMode(mode: MessageGroupingMode): void {
  setMessageAdapterPolicy(props.gateway, props.endpoint, { messageGrouping: { ...policy.value.messageGrouping, mode } });
  store.touch();
}

function setGrouping(field: typeof groupFields[number]["field"], raw: unknown): void {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 300) return;
  setMessageAdapterPolicy(props.gateway, props.endpoint, { messageGrouping: { ...policy.value.messageGrouping, [field]: value } });
  store.touch();
}

function setReviewEnabled(enabled: boolean | null): void {
  setMessageAdapterPolicy(props.gateway, props.endpoint, { conversationReview: { ...policy.value.conversationReview, enabled: enabled === true } });
  store.touch();
}

function setReview(field: typeof reviewFields[number], raw: unknown): void {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < field.min || value > 500) return;
  setMessageAdapterPolicy(props.gateway, props.endpoint, { conversationReview: { ...policy.value.conversationReview, [field.field]: value } });
  store.touch();
}

function setTextConfirmationThreshold(raw: unknown): void {
  const threshold = Number(raw);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 200_000) return;
  setMessageAdapterPolicy(props.gateway, props.endpoint, { textConfirmationThreshold: threshold });
  store.touch();
}

function setNapcat<Key extends keyof NapCatInstanceDefinition>(key: Key, value: NapCatInstanceDefinition[Key]): void {
  if (!napcat.value) return;
  napcat.value[key] = value;
  store.touch();
}

function setNapcatPort(raw: unknown): void {
  const value = Number(raw);
  if (Number.isSafeInteger(value) && value >= 0 && value <= 65535) setNapcat("gatewayPort", value);
}

function setSpeechHotDelivery(enabled: boolean | null): void {
  updateRoute("speechPushMode", speechPushModeForHotDelivery(enabled === true));
  emit("speechChanged");
}

function setSpeechAutoPlay(value: boolean | null): void {
  const enabled = value === true;
  props.gateway.routeVariables = { ...props.gateway.routeVariables, speechAutoPlay: String(enabled) };
  updateRoute("pipeline", { ...props.gateway.pipeline, ttsPlay: enabled });
  emit("speechChanged");
}
</script>

<template>
  <details :open="expanded || undefined" class="mb-4">
    <summary class="text-body-2">消息端设置</summary>
    <div class="mt-3">
      <template v-if="configured">
        <div class="d-flex align-center ga-2 flex-wrap">
          <v-switch v-if="endpoint !== 'rabilink'" :model-value="!isAdapterDisabled(gateway, endpoint)" label="启用消息端"
            color="primary" density="compact" hide-details @update:model-value="setEnabled" >
            <template #append><AutomationParameterHelp text="开启后，这条路线会处理此消息端的入站消息。关闭后仍保留连接配置。" /></template>
          </v-switch>
          <v-btn variant="text" color="error" size="small" @click="removeEndpoint">移除消息端</v-btn>
        </div>

        <div v-if="messageAdapterUsesAutomaticGrouping(endpoint)" class="mt-3">
          <v-select :model-value="groupingMode" :items="groupingModes" label="连发消息处理" density="compact" hide-details
            @update:model-value="setGroupingMode" >
            <template #append-inner><AutomationParameterHelp text="逐条处理会立即按规则判断。合并可以只用于消息处理 Agent，也可以先合并，再投给命中规则的各个目标。" /></template>
          </v-select>
          <details v-if="groupingMode !== 'off'" class="mb-3">
            <summary class="text-body-2 mb-2">消息合并时间</summary>
            <div class="catalog-param-grid">
              <v-text-field v-for="field in groupFields" :key="field.field" :model-value="policy.messageGrouping[field.field]"
                :label="field.label" type="number" :min="1" :max="300" density="compact" hide-details
                @update:model-value="value => setGrouping(field.field, value)" >
                <template #append-inner><AutomationParameterHelp :text="field.field === 'settleSeconds' ? '收到最后一条完整消息后等待这段时间再合并投递。' : field.field === 'incompleteSettleSeconds' ? '末句看起来还没说完时，使用这个等待时间。' : '同一批消息最多等待的时间。'" /></template>
              </v-text-field>
            </div>
          </details>
        </div>

        <v-switch :model-value="policy.conversationReview.enabled" label="发送前核对聊天记录" density="compact"
          hide-details @update:model-value="setReviewEnabled" >
          <template #append><AutomationParameterHelp text="外发前读取最近聊天和新增消息，供 Agent 核对当前上下文。" /></template>
        </v-switch>
        <div v-if="policy.conversationReview.enabled" class="catalog-param-grid mb-3">
          <v-text-field v-for="field in reviewFields" :key="field.field" :model-value="policy.conversationReview[field.field]"
            :label="field.label" type="number" :min="field.min" :max="500" density="compact" hide-details
            @update:model-value="value => setReview(field, value)" >
            <template #append-inner><AutomationParameterHelp :text="field.field === 'initialMessageCount' ? '首次核对时最多读取的近期消息数。' : '增量核对时最多返回的新增消息数。'" /></template>
          </v-text-field>
        </div>

        <v-text-field v-if="endpoint === 'napcat'" :model-value="policy.textConfirmationThreshold"
          label="长消息确认阈值（字）" type="number" :min="0" :max="200000" density="compact" hide-details
          @update:model-value="setTextConfirmationThreshold" >
          <template #append-inner><AutomationParameterHelp text="超过此字数时按路线设置请求确认。填 0 关闭此阈值。" /></template>
        </v-text-field>

        <div v-if="endpoint === 'speech'" class="d-flex ga-4 flex-wrap">
          <v-switch :model-value="hotDeliveryEnabled(gateway.speechPushMode)" label="热投递" density="compact"
            hide-details @update:model-value="setSpeechHotDelivery" >
            <template #append><AutomationParameterHelp text="开启后符合当前触发规则的语音转写会即时交给 Agent。" /></template>
          </v-switch>
          <v-switch :model-value="gateway.routeVariables?.speechAutoPlay !== 'false'" label="自动播放回复"
            density="compact" hide-details @update:model-value="setSpeechAutoPlay" >
            <template #append><AutomationParameterHelp text="自动播放经这条路线合成的 Agent 回复。" /></template>
          </v-switch>
        </div>
      </template>

      <details v-if="['qqbot', 'weixin', 'wecom', 'feishu', 'webhook'].includes(endpoint) || (endpoint === 'napcat' && napcat)" class="mt-3">
        <summary class="text-body-2">接入参数</summary>
        <div class="catalog-param-grid mt-2">
          <template v-if="endpoint === 'qqbot'">
            <v-select :model-value="gateway.qqbotTransport || 'webhook'" :items="['webhook', 'websocket']"
              label="事件接收方式" density="compact" hide-details @update:model-value="value => updateRoute('qqbotTransport', value)" >
              <template #append-inner><AutomationParameterHelp text="选择用 WebSocket 或 HTTP 回调接收 QQ 官方机器人事件。" /></template>
            </v-select>
            <v-text-field v-if="gateway.qqbotTransport === 'websocket'" :model-value="gateway.qqbotIntents ?? 33554432"
              label="WebSocket 事件权限掩码" type="number" :min="0" :max="4294967295" density="compact" hide-details
              @update:model-value="value => updateNumber('qqbotIntents', value, 4294967295)" >
              <template #append-inner><AutomationParameterHelp text="控制订阅的事件类别，填写 QQ 开放平台要求的 intents 数值。" /></template>
            </v-text-field>
            <v-text-field v-else :model-value="gateway.qqbotCallbackPort ?? 0" label="回调端口" type="number"
              :min="0" :max="65535" density="compact" hide-details
              @update:model-value="value => updateNumber('qqbotCallbackPort', value, 65535)" >
              <template #append-inner><AutomationParameterHelp text="供对应平台向这条路线推送事件。填 0 由系统按路线分配。" /></template>
            </v-text-field>
            <v-switch :model-value="gateway.qqbotManagementEnabled !== false" label="允许 QQ 频道管理" density="compact"
              hide-details @update:model-value="value => updateRoute('qqbotManagementEnabled', value !== false)" >
              <template #append><AutomationParameterHelp text="允许此机器人通过已授权的 QQ 频道管理接口执行操作。" /></template>
            </v-switch>
          </template>
          <template v-else-if="endpoint === 'weixin'">
            <v-text-field :model-value="gateway.weixinBaseUrl" label="iLink API 地址" placeholder="https://ilinkai.weixin.qq.com"
              density="compact" hide-details @update:model-value="value => updateRoute('weixinBaseUrl', value)" >
              <template #append-inner><AutomationParameterHelp text="微信机器人的服务地址。普通扫码登录可沿用默认地址。" /></template>
            </v-text-field>
            <v-text-field :model-value="gateway.weixinBotType" label="Bot Type" placeholder="3" density="compact" hide-details
              @update:model-value="value => updateRoute('weixinBotType', value)" >
              <template #append-inner><AutomationParameterHelp text="用于 iLink 登录请求的机器人类型，普通微信机器人可沿用默认值。" /></template>
            </v-text-field>
          </template>
          <v-text-field v-else-if="endpoint === 'wecom'" :model-value="gateway.wecomWsUrl" label="WebSocket 地址"
            density="compact" hide-details @update:model-value="value => updateRoute('wecomWsUrl', value)" >
            <template #append-inner><AutomationParameterHelp text="企业微信机器人接收消息所用的 WebSocket 服务地址。" /></template>
          </v-text-field>
          <template v-else-if="endpoint === 'feishu'">
            <v-text-field :model-value="gateway.feishuWebhookPort ?? 0" label="回调端口" type="number"
              :min="0" :max="65535" density="compact" hide-details
              @update:model-value="value => updateNumber('feishuWebhookPort', value, 65535)" >
              <template #append-inner><AutomationParameterHelp text="供对应平台向这条路线推送事件。填 0 由系统按路线分配。" /></template>
            </v-text-field>
            <v-text-field :model-value="gateway.feishuWebhookPath" label="回调路径" :placeholder="adapterDefaultWebhookPath(endpoint)"
              density="compact" hide-details @update:model-value="value => updateRoute('feishuWebhookPath', value)" >
              <template #append-inner><AutomationParameterHelp text="填写飞书事件的 HTTP 回调路径，与开放平台填写的地址一致。" /></template>
            </v-text-field>
          </template>
          <template v-else-if="endpoint === 'napcat' && napcat">
            <v-switch :model-value="napcat.autoLoginOnRabiStart !== false" label="启动时自动登录"
              density="compact" hide-details @update:model-value="value => setNapcat('autoLoginOnRabiStart', value !== false)" >
              <template #append><AutomationParameterHelp text="RabiRoute 启动时尝试恢复此 NapCat 账号的登录。" /></template>
            </v-switch>
            <v-text-field :model-value="napcat.name" label="备注" density="compact" hide-details
              @update:model-value="value => setNapcat('name', value)" >
              <template #append-inner><AutomationParameterHelp text="用于在多个 NapCat 实例之间区分这个账号。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.gatewayPort" label="RabiRoute WS 端口" type="number" :min="0" :max="65535"
              density="compact" hide-details @update:model-value="setNapcatPort" >
              <template #append-inner><AutomationParameterHelp text="NapCat 的 OneBot 反向 WebSocket 连接到此端口。填 0 由系统分配。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.httpUrl" label="NapCat HTTP 地址" density="compact" hide-details
              @update:model-value="value => setNapcat('httpUrl', value)" >
              <template #append-inner><AutomationParameterHelp text="发送 QQ 消息时使用的 NapCat OneBot HTTP 地址。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.webuiUrl" label="NapCat 管理接口地址" density="compact" hide-details
              @update:model-value="value => setNapcat('webuiUrl', value)" >
              <template #append-inner><AutomationParameterHelp text="扫码与登录状态使用此 NapCat 管理接口。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.accessToken" label="OneBot HTTP 鉴权密钥" type="password" density="compact"
              hide-details @update:model-value="value => setNapcat('accessToken', value)" >
              <template #append-inner><AutomationParameterHelp text="与 NapCat 的 OneBot HTTP 服务中填写的密钥一致。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.launchCommand" label="启动命令" density="compact" hide-details
              @update:model-value="value => setNapcat('launchCommand', value)" >
              <template #append-inner><AutomationParameterHelp text="启动此 NapCat 实例时运行的命令。" /></template>
            </v-text-field>
            <v-text-field :model-value="napcat.workingDir" label="NapCat Shell 工作目录" density="compact" hide-details
              @update:model-value="value => setNapcat('workingDir', value)" >
              <template #append-inner><AutomationParameterHelp text="从这个目录运行上面的 NapCat 启动命令。" /></template>
            </v-text-field>
          </template>
          <template v-else>
            <v-text-field :model-value="gateway.webhookPort || gateway.gatewayPort || 8790" label="监听端口" type="number"
              :min="0" :max="65535" density="compact" hide-details
              @update:model-value="value => updateNumber('webhookPort', value, 65535)" >
              <template #append-inner><AutomationParameterHelp text="接收外部 Webhook 请求的端口。" /></template>
            </v-text-field>
            <v-text-field :model-value="gateway.webhookPath" label="监听路径" :placeholder="adapterDefaultWebhookPath(endpoint)"
              density="compact" hide-details @update:model-value="value => updateRoute('webhookPath', value)" >
              <template #append-inner><AutomationParameterHelp text="外部服务调用时使用的 Webhook 路径。" /></template>
            </v-text-field>
          </template>
        </div>
      </details>
    </div>
  </details>
</template>
