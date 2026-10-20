<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useRoleStore, roleRequest, mutateRole, type RoleSummary, type RoleDetail } from "../stores/roleStore";
import { bootstrapRemotePersonaService, remotePersonaServicePath } from "../persona/remotePersonaReference";
const roles = useRoleStore();
const items = ref<RoleSummary[]>([]);
const query = ref("");
const cursor = ref<string | null>(null);
const loading = ref(false);
const error = ref("");
const selected = ref<RoleDetail | null>(null);
const references = ref<string[]>([]);
const confirmation = ref("");
const dialog = ref(false);
const action = ref<"inspect" | "restore" | "delete">("inspect");
const route = useRoute();
const source = typeof route.query.source === "string" ? route.query.source : roles.sourceDeviceId;
function url(path: string) { return source ? remotePersonaServicePath(source, path) : path; }
async function load(more = false) {
  loading.value = true; error.value = "";
  try {
    if (source) await bootstrapRemotePersonaService(source);
    const result = await roleRequest<{ roles: RoleSummary[]; nextCursor: string | null }>(url(`/api/roles?scope=archived&limit=50&query=${encodeURIComponent(query.value)}${more && cursor.value ? `&cursor=${encodeURIComponent(cursor.value)}` : ""}`));
    items.value = more ? [...items.value, ...result.roles] : result.roles;
    cursor.value = result.nextCursor;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
}
async function inspect(item: RoleSummary, requested: typeof action.value) {
  loading.value = true; error.value = ""; confirmation.value = "";
  try {
    const base = `/api/roles/${encodeURIComponent(item.roleId)}`;
    const [detail, impact] = await Promise.all([roleRequest<RoleDetail>(url(`${base}/configuration`)), roleRequest<{ references: string[] }>(url(`${base}/references`))]);
    selected.value = detail; references.value = impact.references; action.value = requested; dialog.value = true;
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
}
async function submit() {
  if (!selected.value || action.value === "inspect") return;
  loading.value = true; error.value = "";
  try {
    await mutateRole(selected.value.roleId, action.value, { expectedRevision: selected.value.revision, confirmationId: confirmation.value }, source);
    dialog.value = false;
    await roles.loadCatalog();
    await load();
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { loading.value = false; }
}
onMounted(() => { void load(); });
</script>
<template>
  <div class="page-shell">
    <div class="page-header"><h1 class="page-title">已归档角色</h1><v-btn to="/settings" variant="tonal" prepend-icon="mdi-arrow-left">返回设置</v-btn></div>
    <v-alert v-if="source" type="info">来源 PC：{{ source }}</v-alert>
    <div class="d-flex ga-3 my-4"><v-text-field v-model="query" label="搜索角色名称或 ID" hide-details @keyup.enter="load()" /><v-btn :loading="loading" @click="load()">搜索</v-btn></div>
    <v-alert v-if="error" type="error" class="mb-3">{{ error }}</v-alert>
    <v-card v-for="item in items" :key="item.roleId" class="app-card section-card mb-3">
      <div class="d-flex align-center ga-3 flex-wrap">
        <div class="flex-grow-1"><strong>{{ item.title }}</strong><div>{{ item.roleId }} · {{ item.archivedAt ? new Date(item.archivedAt).toLocaleString() : '状态待核对' }}</div><div v-if="item.error">{{ item.error }}</div></div>
        <v-btn variant="text" :disabled="loading || !!item.error" @click="inspect(item, 'inspect')">查看</v-btn>
        <v-btn variant="tonal" :disabled="loading || !!item.error" @click="inspect(item, 'restore')">恢复</v-btn>
        <v-btn color="error" variant="text" :disabled="loading || !!item.error" @click="inspect(item, 'delete')">彻底删除</v-btn>
      </div>
    </v-card>
    <p v-if="!loading && !items.length && !error">暂无已归档角色</p>
    <v-btn v-if="cursor" :loading="loading" @click="load(true)">加载更多</v-btn>
    <v-dialog v-model="dialog" max-width="680" :persistent="loading">
      <v-card :title="action === 'delete' ? '彻底删除角色' : action === 'restore' ? '恢复角色' : '已归档角色'">
        <v-card-text v-if="selected">
          <p>{{ selected.roleId }} · 归档于 {{ selected.archivedAt }}</p>
          <p class="mt-3">关联路由：{{ selected.routes.map(route => route.name).join('、') || '无' }}</p>
          <p>运行中或待核对任务：{{ selected.runningWork }}</p>
          <v-alert v-if="action === 'restore'" type="info" class="mt-3">原先启用的路由和自动化将恢复接收新任务；归档期间错过的任务不会自动补发。</v-alert>
          <template v-if="action === 'delete'">
            <v-alert type="warning" class="my-3">将永久删除角色目录中的配置、正文、计划、记忆、聊天记录、专属附件和备份，无法撤销。外部会话、共享资源及外部备份保留。</v-alert>
            <v-alert v-if="references.length" type="error" class="mb-3">请先解除引用：{{ references.join('；') }}</v-alert>
            <v-text-field v-model="confirmation" :label="`输入角色 ID：${selected.roleId}`" />
          </template>
          <v-alert v-if="error" type="error">{{ error }}</v-alert>
        </v-card-text>
        <v-card-actions><v-spacer /><v-btn :disabled="loading" @click="dialog = false">关闭</v-btn><v-btn v-if="action !== 'inspect'" :color="action === 'delete' ? 'error' : 'primary'" :loading="loading" :disabled="action === 'delete' && (confirmation !== selected?.roleId || references.length > 0 || (selected?.runningWork || 0) > 0)" @click="submit">{{ action === 'delete' ? '彻底删除' : '恢复' }}</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
