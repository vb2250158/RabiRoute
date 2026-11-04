<script setup lang="ts">
import { computed, ref } from 'vue';
import type { QqGroupMember } from '@shared/qqConversationHistory';
import { useI18n } from '../i18n';
import QqAvatar from './QqAvatar.vue';
import QqReadNotice from './QqReadNotice.vue';
const props = defineProps<{ members:QqGroupMember[]; loading:boolean; error:string }>();
defineEmits<{ refresh:[] }>();
const {t}=useI18n();
const search=ref(''),limit=ref(40);
const ranks:Record<string,number>={owner:0,admin:1};
const visible=computed(()=>{
  const query=search.value.trim().toLocaleLowerCase();
  return props.members.filter(member=>!query||`${member.name} ${member.id}`.toLocaleLowerCase().includes(query)).slice().sort((a,b)=>(ranks[a.role??'']??2)-(ranks[b.role??'']??2));
});
</script>
<template>
  <section class="qq-group-members" :aria-label="t('群成员')">
    <header class="qq-member-header"><strong>{{ t('群成员') }}<span v-if="!loading&&!error"> {{ members.length }}</span></strong><v-btn icon="mdi-refresh" size="x-small" variant="text" :loading="loading" :aria-label="t('刷新群成员')" @click="$emit('refresh')" /></header>
    <v-text-field v-model="search" class="qq-member-search" :placeholder="t('搜索群成员')" :aria-label="t('搜索群成员')" prepend-inner-icon="mdi-magnify" density="compact" variant="plain" clearable hide-details @update:model-value="limit=40" />
    <QqReadNotice v-if="error" summary="群成员暂时无法更新，已有信息仍可查看。" :detail="error" @retry="$emit('refresh')" />
    <div class="qq-member-scroll">
      <ul class="qq-member-list">
        <li v-for="member in visible.slice(0,limit)" :key="member.id" class="qq-member-row" :title="`${member.name} · ${member.id}`" data-no-i18n>
          <QqAvatar :id="member.id" :name="member.name" :size="24" />
          <span class="qq-member-name">{{ member.name }}</span>
          <span v-if="member.role==='owner'||member.role==='admin'" class="qq-member-badge" :class="{'qq-owner':member.role==='owner'}">{{ t(member.role==='owner'?'群主':'管理员') }}</span>
        </li>
      </ul>
      <p v-if="!loading&&!error&&!visible.length" class="qq-member-empty">{{ t('暂无匹配成员。') }}</p>
      <v-btn v-if="limit<visible.length" block variant="text" size="small" @click="limit+=40">{{ t('更多成员') }}</v-btn>
    </div>
  </section>
</template>
<style scoped>
.qq-group-members {display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden;}
.qq-member-header {display:flex;align-items:center;justify-content:space-between;padding:12px 12px 4px;flex:none;font-size:14px;}
.qq-member-header strong {font-weight:500;}
.qq-member-search {flex:none;padding:0 12px 8px;font-size:12px;}
.qq-member-search :deep(.v-field__input) {font-size:12px;min-height:32px;padding-top:0;}
.qq-member-search :deep(.v-field__prepend-inner),.qq-member-search :deep(.v-field__clearable) {padding-top:3px;}
.qq-member-scroll {overflow-y:auto;overflow-x:hidden;min-height:0;scrollbar-gutter:stable;overscroll-behavior:contain;}
.qq-member-list {list-style:none;padding:0 8px 8px;margin:0;}
.qq-member-row {display:flex;align-items:center;gap:8px;min-height:34px;font-size:13px;padding:3px 4px;border-radius:4px;}
.qq-member-row:hover {background:rgba(var(--v-theme-on-surface),.05);}
.qq-member-name {min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qq-member-badge {flex:none;font-size:10px;line-height:16px;padding:0 3px;border-radius:3px;color:rgb(var(--v-theme-secondary));background:rgba(var(--v-theme-secondary),.12);}
.qq-member-badge.qq-owner {color:#e9a45c;background:rgba(233,164,92,.12);}
.qq-member-empty {padding:12px;color:rgba(var(--v-theme-on-surface),.6);font-size:12px;}
</style>
