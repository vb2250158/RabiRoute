<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';

type Choice = { value:string; title:string; subtitle?:string; props?:{disabled?:boolean} };
const props=defineProps<{
  label:string; source:string; selected:string; modelLabel?:string; sources:Choice[]; disabled?:boolean; setupHref?:string;
  loadModels:(source:string)=>Promise<Choice[]>|Choice[];
  choose:(model:string)=>Promise<boolean|void>;
}>();

const open=ref(false),source=ref(props.source),models=ref<Choice[]>([]),loading=ref(false),saving=ref(false),error=ref('');
const search=ref(''),shownLabel=ref('');
let generation=0;
const selection=computed(()=>source.value===props.source?props.selected:'');
const selectedLabel=computed(()=>props.modelLabel||shownLabel.value);
const term=computed(()=>search.value.trim().toLocaleLowerCase());
const matchingSources=computed(()=>props.sources.filter(matches));
const visibleSources=computed(()=>matchingSources.value.length?matchingSources.value:props.sources);
const visibleModels=computed(()=>term.value&&matchingSources.value.some(item=>item.value===source.value)
  ? models.value : models.value.filter(matches));

function matches(item:Choice) {
  return [item.title,item.subtitle].some(value=>value?.toLocaleLowerCase().includes(term.value));
}

async function load() {
  const version=++generation;
  models.value=[];error.value='';loading.value=Boolean(source.value);
  if(!source.value)return;
  try {
    const rows=await props.loadModels(source.value);
    if(version!==generation)return;
    models.value=rows;
    if(selection.value)shownLabel.value=rows.find(item=>item.value===selection.value)?.title||'';
  }catch(cause){
    if(version===generation)error.value=cause instanceof Error?cause.message:'读取模型失败，请重试。';
  }finally{ if(version===generation)loading.value=false; }
}

function changeSource(row:Choice) {
  if(saving.value||props.disabled||row.props?.disabled)return;
  search.value='';
  if(source.value===row.value&&!error.value)return;
  source.value=row.value;
  void load();
}

function changeSearch(value:string) {
  search.value=value||'';
  open.value=true;
}

async function selectModel(row:Choice) {
  if(props.disabled||saving.value||loading.value||row.props?.disabled)return;
  saving.value=true;error.value='';
  try {
    if(await props.choose(row.value)===false){error.value='无法保存选择，请重试。';return;}
    shownLabel.value=row.title;
    open.value=false;
  }catch(cause){error.value=cause instanceof Error?cause.message:'无法保存选择，请重试。';}
  finally{saving.value=false;}
}

watch(open,value=>{
  if(value){source.value=props.source||props.sources.find(row=>!row.props?.disabled)?.value||'';void load();}
  else{++generation;search.value='';loading.value=false;error.value='';}
});
watch(()=>[props.source,props.selected],()=>{if(!saving.value)shownLabel.value='';});
onBeforeUnmount(()=>{++generation;});
</script>

<template>
  <v-menu v-model="open" :open-on-click="false" :close-on-content-click="false" :capture-focus="false" :persistent="saving"
    location="bottom start" :offset="4" :max-width="660" :disabled="disabled && !open">
    <template #activator="{props: activator}">
      <v-text-field v-bind="activator" :label="label" :model-value="open ? search : selectedLabel" :placeholder="open ? '搜索模型' : '选择模型'"
        role="combobox" autocomplete="off" variant="outlined" density="compact" hide-details :disabled="disabled || saving"
        :append-inner-icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="open = true" @click:append-inner.stop="open = !open"
        @update:model-value="changeSearch" />
    </template>
    <v-card class="assistant-model-options" :aria-label="label">
      <div class="assistant-model-levels">
        <v-list class="assistant-model-sources assistant-model-list" density="compact" bg-color="transparent" aria-label="模型分组">
          <v-list-item v-for="row in visibleSources" :key="row.value" :title="row.title" :subtitle="row.subtitle"
            :active="source === row.value" :disabled="disabled || saving || row.props?.disabled"
            color="secondary" rounded="lg" append-icon="mdi-chevron-right" @click="changeSource(row)" />
        </v-list>
        <section class="assistant-model-results" aria-label="可选模型" :aria-busy="loading">
          <v-progress-linear v-if="loading" indeterminate />
          <v-list class="assistant-model-list" density="compact" bg-color="transparent">
            <v-list-item v-for="row in visibleModels" :key="row.value" :title="row.title" :subtitle="row.subtitle"
              :active="selection === row.value" :disabled="disabled || saving || loading || row.props?.disabled"
              color="secondary" rounded="lg" :append-icon="selection === row.value ? 'mdi-check' : undefined" @click="selectModel(row)" />
            <v-list-item v-if="!loading && !visibleModels.length && !error" :title="search ? '没有匹配的模型' : '没有可选模型'" />
          </v-list>
          <v-alert v-if="error" class="ma-2" type="error" density="compact" variant="tonal">{{ error }}</v-alert>
        </section>
      </div>
      <v-divider v-if="setupHref" />
      <v-btn v-if="setupHref" :href="setupHref" variant="text" size="small" class="ma-2">前往模型服务配置</v-btn>
    </v-card>
  </v-menu>
</template>

<style scoped>
.assistant-model-options { width: min(640px, calc(100vw - 24px)); max-height: min(560px, calc(100dvh - 24px)); overflow-y: auto; }
.assistant-model-levels { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); }
.assistant-model-sources { background: rgba(var(--v-theme-on-surface), .025); }
.assistant-model-results { min-width: 0; border-inline-start: 1px solid var(--rr-border); }
.assistant-model-list { max-height: min(400px, 54vh); min-width: 0; padding: 6px; overflow-y: auto; overscroll-behavior: contain; }
.assistant-model-list :deep(.v-list-item-title) { white-space: normal; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .assistant-model-levels { grid-template-columns: 1fr; }
  .assistant-model-sources { max-height: 150px; }
  .assistant-model-results { border-inline-start: 0; border-block-start: 1px solid var(--rr-border); }
  .assistant-model-results .assistant-model-list { max-height: 32vh; }
}
</style>
