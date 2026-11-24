<script setup lang="ts">
import AutomationParameterHelp from "./AutomationParameterHelp.vue";
import { computed, ref } from "vue";
import type { PersonaAutomationRuleDefinition } from "../../../../../ribiwebgui/src/types";
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { routeKindLabels } from "../../../../../ribiwebgui/src/utils/gatewayHelpers";
import { automationEndpoints } from "../persona/automationEndpoints";
import QqAvatar from "./QqAvatar.vue";

type MessageTrigger = Extract<PersonaAutomationRuleDefinition["trigger"], { type: "message" }>;
type Condition = "targetUserId" | "targetGroupId" | "allowedSpeakerNames" | "regex";
type Contact = { title: string; value: string };

const props = defineProps<{
  endpoint: string;
  trigger: MessageTrigger;
  qqGroups: Contact[];
  qqContacts: Contact[];
  qqLoading: boolean;
}>();
const emit = defineEmits<{ patch: [patch: Partial<MessageTrigger>] }>();
const { t } = useI18n();

const endpointKinds = computed(() => automationEndpoints.find(item => item.value === props.endpoint)?.routeKinds ?? []);
const selectedKinds = computed(() => [...new Set(props.trigger.routeKinds ?? [])]);
const allKindsSelected = computed(() => props.endpoint !== "speech" && endpointKinds.value.length > 1
  && selectedKinds.value.length === endpointKinds.value.length
  && endpointKinds.value.every(kind => selectedKinds.value.includes(kind)));
const visibleKinds = computed(() => allKindsSelected.value ? [] : selectedKinds.value);
const availableKinds = computed(() => endpointKinds.value.filter(kind => !visibleKinds.value.includes(kind)));

function addScene(kind: string): void {
  emit("patch", { routeKinds: [...visibleKinds.value, kind] });
}

function restoreAllScenes(): void {
  emit("patch", { routeKinds: [...endpointKinds.value] });
}

function removeScene(kind: string): void {
  emit("patch", { routeKinds: selectedKinds.value.filter(item => item !== kind) });
}

const pending = ref<Condition[]>([]);
const conditionTypes = computed<Array<{ key: Condition; title: string; available: boolean }>>(() => {
  const qq = props.endpoint === "napcat";
  const speech = props.endpoint === "speech";
  const kinds = selectedKinds.value;
  const transcript = kinds.includes("voice_transcript");
  return [
    { key: "targetUserId", title: "QQ 私聊对象", available: qq && kinds.includes("private") },
    { key: "targetGroupId", title: "指定群聊", available: qq
      ? kinds.some(kind => endpointKinds.value.includes(kind) && kind !== "private")
      : kinds.some(kind => kind === "wecom_message" || kind === "feishu_message") },
    { key: "allowedSpeakerNames", title: "指定说话人", available: speech && transcript },
    { key: "regex", title: speech ? "转写内容匹配" : "消息内容匹配", available: !speech || transcript }
  ];
});
const activeConditions = computed(() => conditionTypes.value.filter(({ key }) =>
  pending.value.includes(key) || Boolean(props.trigger[key]?.length)));
const availableConditions = computed(() => {
  const active = new Set(activeConditions.value.map(item => item.key));
  return conditionTypes.value.filter(({ key, available }) => available && !active.has(key)
    && (key !== "targetUserId" || !active.has("targetGroupId"))
    && (key !== "targetGroupId" || !active.has("targetUserId")));
});

function addCondition(key: Condition): void {
  if (!pending.value.includes(key)) pending.value = [...pending.value, key];
}

function removeCondition(key: Condition): void {
  pending.value = pending.value.filter(item => item !== key);
  emit("patch", { [key]: key === "allowedSpeakerNames" ? [] : "" });
}

function updateQqTarget(key: "targetUserId" | "targetGroupId", value: unknown): void {
  const id = typeof value === "string" ? value.trim() : "";
  if (id && !/^[1-9]\d*$/.test(id)) return;
  if (!id) {
    emit("patch", { [key]: "" });
  } else if (key === "targetUserId") {
    pending.value = pending.value.filter(item => item !== "targetGroupId");
    emit("patch", { targetUserId: id, targetGroupId: "", routeKinds: ["private"] });
  } else {
    pending.value = pending.value.filter(item => item !== "targetUserId");
    emit("patch", { targetGroupId: id, targetUserId: "" });
  }
}
</script>

<template>
  <div class="message-filter-lists">
    <section :aria-label="t('触发场景')">
      <div class="filter-list-heading">
        <span>{{ t('触发场景') }}</span>
        <v-menu v-if="availableKinds.length || (endpoint !== 'speech' && visibleKinds.length && endpointKinds.length > 1)">
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" variant="text" color="secondary" size="small" prepend-icon="mdi-plus">{{ t('添加场景') }}</v-btn>
          </template>
          <v-list density="compact">
            <v-list-item v-if="endpoint !== 'speech' && visibleKinds.length && endpointKinds.length > 1" :title="t('全部场景')" @click="restoreAllScenes" />
            <v-list-item v-for="kind in availableKinds" :key="kind" :title="t(routeKindLabels[kind] || kind)" @click="addScene(kind)" />
          </v-list>
        </v-menu>
      </div>
      <ul class="filter-list">
        <li v-if="!visibleKinds.length" class="filter-row filter-scene">
          <span>{{ t(allKindsSelected ? '全部场景' : '所有收到的消息') }}</span>
        </li>
        <li v-for="kind in visibleKinds" :key="kind" class="filter-row filter-scene">
          <span>{{ t(routeKindLabels[kind] || kind) }}</span>
          <v-btn v-if="visibleKinds.length > 1" icon="mdi-close" variant="text" size="small" :aria-label="t('移除场景')"
            :title="t('移除场景')" @click="removeScene(kind)" />
        </li>
      </ul>
    </section>

    <section :aria-label="t('限定条件')">
      <div class="filter-list-heading">
        <span>{{ t('限定条件') }}</span>
        <v-menu>
          <template #activator="{ props: menuProps }">
            <v-btn v-bind="menuProps" variant="text" color="secondary" size="small" prepend-icon="mdi-plus"
              :disabled="!availableConditions.length">{{ t('添加限定条件') }}</v-btn>
          </template>
          <v-list density="compact">
            <v-list-item v-for="item in availableConditions" :key="item.key" :title="t(item.title)" @click="addCondition(item.key)" />
          </v-list>
        </v-menu>
      </div>
      <ul class="filter-list">
        <li v-if="!activeConditions.length" class="filter-row filter-scene">{{ t('无限定条件') }}</li>
        <li v-for="item in activeConditions" :key="item.key" class="filter-row" @focusin="addCondition(item.key)">
          <v-autocomplete v-if="item.key === 'targetUserId'" :model-value="trigger.targetUserId || null"
            :items="qqContacts" :loading="qqLoading" :label="t(item.title)"
            hide-details
            clearable density="compact" variant="outlined" @update:model-value="value => updateQqTarget('targetUserId', value)" >
            <template #append-inner><AutomationParameterHelp text="只处理该平台 ID 对应的私聊消息。" /></template>
          </v-autocomplete>
          <v-combobox v-else-if="item.key === 'targetGroupId' && endpoint === 'napcat'" :model-value="trigger.targetGroupId || null"
            :items="qqGroups" :return-object="false" :loading="qqLoading" :label="t(item.title)"
            :placeholder="t('搜索群名或群号，也可输入群号')" clearable density="compact" variant="outlined" hide-details
            @update:model-value="value => updateQqTarget('targetGroupId', value)">
            <template #append-inner><AutomationParameterHelp text="只处理该平台 ID 对应的群聊或频道消息。" /></template>
            <template #item="{ props: itemProps, item: contact }">
              <v-list-item v-bind="itemProps"><template #prepend><QqAvatar :id="String(contact.value || '')" kind="group" :name="contact.title" :size="32" class="mr-3" /></template></v-list-item>
            </template>
            <template #selection="{ item: contact }"><QqAvatar :id="String(contact.value || '')" kind="group" :name="contact.title" :size="24" class="mr-2" /><span class="text-truncate" data-no-i18n>{{ contact.title }}</span></template>
          </v-combobox>
          <v-text-field v-else-if="item.key === 'targetGroupId'" :model-value="trigger.targetGroupId" :label="t(item.title)"
            :placeholder="t('留空表示不限群')" density="compact" variant="outlined" hide-details
            @update:model-value="value => emit('patch', { targetGroupId: String(value || '') })" >
            <template #append-inner><AutomationParameterHelp text="只处理该平台 ID 对应的群聊或频道消息。" /></template>
          </v-text-field>
          <v-combobox v-else-if="item.key === 'allowedSpeakerNames'" :model-value="trigger.allowedSpeakerNames || []" :label="t(item.title)"
            :placeholder="t('输入说话人并按回车')" chips multiple closable-chips density="compact" variant="outlined" hide-details
            @update:model-value="value => emit('patch', { allowedSpeakerNames: Array.isArray(value) ? value.map(String) : [] })" >
            <template #append-inner><AutomationParameterHelp text="只处理这些名称对应的语音发言。" /></template>
          </v-combobox>
          <v-text-field v-else :model-value="trigger.regex" :label="t(item.title)"
            :placeholder="t('输入关键词或正则表达式')" density="compact" variant="outlined" hide-details
            @update:model-value="value => emit('patch', { regex: String(value || '') })" >
            <template #append-inner><AutomationParameterHelp text="按表达式匹配正文。有引用消息时也匹配引用内容。" /></template>
          </v-text-field>
          <v-btn icon="mdi-close" variant="text" size="small" :aria-label="t('删除条件')" :title="t('删除条件')" @click="removeCondition(item.key)" />
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.message-filter-lists {
  display: grid;
  gap: 12px;
}

.filter-list-heading,
.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-list-heading {
  justify-content: space-between;
}

.filter-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 6px;
}

.filter-row {
  justify-content: space-between;
  min-width: 0;
}

.filter-row > :first-child {
  flex: 1;
  min-width: 0;
}

.filter-scene {
  min-height: 36px;
  padding-inline: 12px 4px;
  border: 1px solid var(--rr-border-soft);
  border-radius: 8px;
}
</style>
