<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {qqAvatarUrl} from '../qqMessagePresentation';
const props=withDefaults(defineProps<{id?:string;name?:string;kind?:'group'|'private';size?:number}>(),{kind:'private',size:36});
const failed=ref(false);
const source=computed(()=>qqAvatarUrl(props.kind,props.id));
const initial=computed(()=>Array.from((props.name??'').trim())[0]?.toUpperCase());
watch(source,()=>{failed.value=false;});
</script>
<template>
  <v-avatar :size="size" color="secondary" variant="tonal" class="qq-avatar" aria-hidden="true">
    <img v-if="source&&!failed" :src="source" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="failed=true" />
    <span v-else-if="initial" data-no-i18n>{{ initial }}</span>
    <v-icon v-else :icon="kind==='group'?'mdi-account-group':'mdi-account'" />
  </v-avatar>
</template>
<style scoped>
.qq-avatar {flex:none;}
.qq-avatar img {width:100%;height:100%;object-fit:cover;}
.qq-avatar span {font-weight:600;}
</style>
