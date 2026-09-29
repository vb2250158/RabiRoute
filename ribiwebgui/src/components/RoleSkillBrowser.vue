<script setup lang="ts">
import { onBeforeUnmount, reactive, watch } from 'vue';
import { useI18n } from '../i18n';
import { createRoleSkillBrowser, type RoleSkillState } from '../roleSkillClient';
const props = defineProps<{ roleId: string }>();
const { isEnglish } = useI18n();
const state = reactive<RoleSkillState>({ roleId: '', items: [], detail: null, loading: false, detailLoading: false, error: false, detailError: false });
const browser = createRoleSkillBrowser(state);
watch(() => props.roleId, role => void browser.load(role), { immediate: true });
onBeforeUnmount(browser.dispose);
const label = (zh: string, en: string) => isEnglish.value ? en : zh;
</script>

<template>
  <v-card class="role-skill-browser">
    <v-card-title class="skill-heading">{{ label('角色 Skill 目录', 'Persona Skill catalog') }}</v-card-title>
    <v-card-text>
      <v-alert type="info" variant="tonal" class="mb-4">{{ label('这里展示人格保存的技能资料，仅供查看；不代表 Agent 已加载。此处不安装、启停或修改技能。', 'These are skill resources saved for the persona, not proof that the Agent has loaded them. This view does not install, enable, disable or edit skills.') }}</v-alert>
      <div class="skill-heading mb-3">
        <span>{{ state.roleId }}</span>
        <v-btn variant="text" prepend-icon="mdi-refresh" :disabled="!roleId" :loading="state.loading" @click="browser.load(roleId)">{{ label('刷新目录', 'Refresh catalog') }}</v-btn>
      </div>
      <v-alert v-if="!roleId" type="warning" variant="tonal">{{ label('当前路线尚未绑定人格。', 'This route has no bound persona.') }}</v-alert>
      <v-progress-linear v-else-if="state.loading" indeterminate :aria-label="label('正在读取技能目录', 'Loading skills')" />
      <v-alert v-else-if="state.error" type="error" variant="tonal" role="alert">{{ label('目录读取失败，请检查连接与访问权限后刷新。', 'Could not load the catalog. Check connection and access, then refresh.') }}</v-alert>
      <p v-else-if="!state.items.length">{{ label('此人格暂无可读取的技能。', 'No readable skills for this persona.') }}</p>
      <v-list v-else aria-label="Skills">
        <v-list-item v-for="item in state.items" :key="item.id" :title="item.title || item.id" :subtitle="item.summary" class="skill-item" @click="browser.select(item.id)">
          <template #append><v-icon icon="mdi-chevron-right" /></template>
        </v-list-item>
      </v-list>
      <section class="mt-4" aria-live="polite">
        <v-progress-linear v-if="state.detailLoading" indeterminate :aria-label="label('正在读取技能正文', 'Loading skill detail')" />
        <v-alert v-else-if="state.detailError" type="error" variant="tonal">{{ label('正文读取失败，请重新选择技能重试。', 'Could not load the detail. Select the skill again to retry.') }}</v-alert>
        <template v-else-if="state.detail">
          <h3>{{ state.detail.title }}</h3>
          <p>{{ label('资料状态（不是加载状态）：', 'Resource status (not loading status): ') }}{{ state.detail.status }}</p>
          <p>{{ state.detail.keywords.join(' · ') }}</p>
          <pre class="skill-content">{{ state.detail.content }}</pre>
        </template>
      </section>
    </v-card-text>
  </v-card>
</template>

<style scoped>
.skill-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; white-space: normal; overflow-wrap: anywhere; }
.skill-item { min-height: 48px; }
.skill-item :deep(.v-list-item-title), .skill-item :deep(.v-list-item-subtitle) { white-space: normal; overflow-wrap: anywhere; }
.skill-content { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 55vh; overflow: auto; }
.role-skill-browser { width: 100%; }
</style>
