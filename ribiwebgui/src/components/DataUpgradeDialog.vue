<script setup lang="ts">
import { computed } from "vue";
import type { DataUpgradeView } from "../dataUpgradeClient";
import { upgradeQuantity } from "../dataUpgradeClient";
import { useI18n } from "../i18n/index";
const props = defineProps<{ view: DataUpgradeView }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
const { t: translate, isEnglish } = useI18n();
const english: Record<string, string> = {
  "数据升级": "Data upgrade", "发现可升级的数据。确认后由服务在后台处理，关闭页面后仍会继续。": "Data upgrades are available. After confirmation, the service continues processing even if this page closes.",
  "本次升级需要通过 Host 重启服务，连接将短暂中断，恢复后继续显示升级结果。": "This upgrade requires a service restart through Host. The connection will briefly close, then show the result when restored.",
  "请求结果尚待确认，请保留原操作并查看服务状态，避免重复升级。": "The request outcome is unconfirmed. Check the original operation in the service before submitting again.",
  "升级已准备好，将在下次正常启动时完成。": "The upgrade is prepared and will complete at the next normal startup.",
  "待升级": "Pending", "已是最新": "Up to date", "升级中": "Upgrading", "升级完成": "Upgrade complete", "升级失败": "Upgrade failed", "升级已中断": "Upgrade interrupted",
  "等待下次启动完成": "Awaiting next startup", "数据数量": "Records", "数据大小": "Size", "未知": "Unknown", "关闭": "Close", "稍后": "Later", "升级数据": "Upgrade data", "确认升级并重启": "Upgrade and restart", "继续升级并重启": "Continue upgrade and restart"
};
const t = (text: string) => isEnglish.value ? english[text] || translate(text) : translate(text);
const running = computed(() => props.view.pending || props.view.status?.state === "running");
const awaitingRestart = computed(() => props.view.status?.state === "awaiting-restart" && Boolean(props.view.status.operation));
const canUpgrade = computed(() => !running.value && !props.view.uncertain && (awaitingRestart.value || props.view.status?.items.some(item => item.state === "pending" || item.state === "failed")));
const stateLabels: Record<string, string> = { pending: "待升级", current: "已是最新", running: "升级中", succeeded: "升级完成", failed: "升级失败", interrupted: "升级已中断", "awaiting-restart": "等待下次启动完成" };
</script>

<template>
  <v-dialog :model-value="view.open" max-width="720" scrollable @update:model-value="value => { if (!value) emit('close'); }">
    <v-card>
      <v-card-title>{{ t("数据升级") }}</v-card-title>
      <v-card-text>
        <p class="mb-4">{{ t("发现可升级的数据。确认后由服务在后台处理，关闭页面后仍会继续。") }}</p>
        <v-alert v-if="view.status?.restartRequired" type="info" variant="tonal" class="mb-3">{{ t("本次升级需要通过 Host 重启服务，连接将短暂中断，恢复后继续显示升级结果。") }}</v-alert>
        <v-alert v-if="view.error" type="error" variant="tonal" class="mb-3">{{ t(view.error) }}</v-alert>
        <v-alert v-if="view.uncertain" type="warning" variant="tonal" class="mb-3">{{ t("请求结果尚待确认，请保留原操作并查看服务状态，避免重复升级。") }}</v-alert>
        <v-alert v-if="view.status?.state === 'awaiting-restart'" type="info" variant="tonal" class="mb-3">{{ t("升级已准备好，将在下次正常启动时完成。") }}</v-alert>
        <div v-if="view.status?.operation" role="status" class="mb-3">
          {{ t(stateLabels[view.status.operation.state] || view.status.operation.state) }}
          {{ view.status.operation.completedItems }} / {{ view.status.operation.totalItems }}
          <v-progress-linear v-if="running" :model-value="view.status.operation.totalItems ? view.status.operation.completedItems / view.status.operation.totalItems * 100 : 0" :indeterminate="!view.status.operation.totalItems" class="mt-2" />
          <p v-if="view.status.operation.error">{{ t(view.status.operation.error) }}</p>
        </div>
        <v-list lines="three">
          <v-list-item v-for="item in view.status?.items" :key="item.id" class="px-0">
            <v-list-item-title class="text-wrap">{{ t(item.title) }} · {{ t(stateLabels[item.state] || item.state) }}</v-list-item-title>
            <div class="text-body-2 text-wrap">{{ t(item.description) }}</div>
            <div class="text-body-2">{{ t("数据数量") }}：{{ t(upgradeQuantity(item.recordCount)) }} · {{ t("数据大小") }}：{{ t(upgradeQuantity(item.bytes, true)) }}</div>
            <div v-if="item.fromVersion || item.toVersion" class="text-body-2 text-wrap">{{ item.fromVersion || t("未知") }} → {{ item.toVersion || t("未知") }}</div>
            <div v-if="item.error" class="text-error text-wrap">{{ t(item.error) }}</div>
          </v-list-item>
        </v-list>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="emit('close')">{{ t(running ? "关闭" : "稍后") }}</v-btn>
        <v-btn v-if="canUpgrade" color="primary" :loading="view.pending" @click="emit('confirm')">{{ t(awaitingRestart ? "继续升级并重启" : view.status?.restartRequired ? "确认升级并重启" : "升级数据") }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
