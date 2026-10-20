<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useRoleStore, mutateRole, roleRequest, type RoleDetail } from "../stores/roleStore";
import { roleConfigPath } from "../roleScopedNavigation";
const roles = useRoleStore();
const router = useRouter();
const creating = ref(false);
const archiving = ref(false);
const title = ref("");
const roleId = ref("");
const busy = ref(false);
const error = ref("");
function openCreate() { title.value = ""; roleId.value = `role-${crypto.randomUUID().slice(0, 8)}`; error.value = ""; creating.value = true; }
async function create() {
  busy.value = true; error.value = "";
  try {
    const data = await roleRequest<RoleDetail>("/api/roles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId: roleId.value, title: title.value }) });
    creating.value = false;
    roles.sourceDeviceId = "";
    await roles.loadCatalog();
    await router.push(roleConfigPath(data.roleId));
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { busy.value = false; }
}
async function archive() {
  if (!roles.detail) return;
  busy.value = true; error.value = "";
  try {
    await mutateRole(roles.selectedRoleId, "archive", { expectedRevision: roles.detail.revision }, roles.sourceDeviceId);
    archiving.value = false;
    await roles.load();
    await roles.loadCatalog();
  } catch (failure) { error.value = failure instanceof Error ? failure.message : String(failure); }
  finally { busy.value = false; }
}
</script>
<template>
  <v-btn prepend-icon="mdi-account-plus-outline" variant="tonal" @click="openCreate">新建角色</v-btn>
  <v-btn v-if="roles.detail && !roles.archived" prepend-icon="mdi-archive-outline" variant="tonal" :disabled="roles.dirty" @click="archiving = true; error = ''">归档角色</v-btn>
  <v-btn v-if="roles.archived" :to="{ path: '/settings/archived-roles', query: roles.sourceDeviceId ? { source: roles.sourceDeviceId } : {} }" variant="tonal">已归档角色</v-btn>
  <v-dialog v-model="creating" max-width="520" :persistent="busy">
    <v-card title="新建角色">
      <v-card-text>
        <v-text-field v-model="title" label="角色名称" autofocus />
        <v-text-field v-model="roleId" label="角色 ID" hint="用于目录和引用，创建后保持不变。" persistent-hint />
        <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn :disabled="busy" @click="creating = false">取消</v-btn><v-btn color="primary" :loading="busy" :disabled="!title.trim() || !roleId.trim()" @click="create">创建</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
  <v-dialog v-model="archiving" max-width="620" :persistent="busy">
    <v-card title="归档角色">
      <v-card-text>
        <p>归档 {{ roles.selectedRoleId }} 后，将暂停新消息、定时任务和脚本。资料与路由引用保留，已经开始的任务允许完成。</p>
        <p class="mt-3">关联路由：{{ roles.detail?.routes.map(route => route.name).join('、') || '无' }}</p>
        <p>运行中或待核对任务：{{ roles.detail?.runningWork || 0 }}</p>
        <v-alert v-if="error" type="error" class="mt-3">{{ error }}</v-alert>
      </v-card-text>
      <v-card-actions><v-spacer /><v-btn :disabled="busy" @click="archiving = false">取消</v-btn><v-btn color="primary" :loading="busy" @click="archive">归档</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
