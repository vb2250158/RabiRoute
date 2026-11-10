<script setup lang="ts">
import { useI18n } from "../../../../../ribiwebgui/src/i18n/index";
import { onBeforeUnmount, ref, watch } from "vue";
import { ComputerControlFiles, type ComputerFileCall, type ComputerFileProgress } from "./computerControlFiles";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { userFacingError } from "../../../../../ribiwebgui/src/userFacingError";
const { t } = useI18n();
const props = defineProps<{ call: ComputerFileCall; disabled?: boolean }>();
const lookupUploadId=ref("");
const path=ref(""); const selected=ref<File>(); const busy=ref(false); const error=ref(""); const progress=ref<ComputerFileProgress>(); const downloadUrl=ref("");
let controller: AbortController | undefined; let disposed=false;
function select(event:Event) { selected.value=(event.target as HTMLInputElement).files?.[0]; }
function publish(value:ComputerFileProgress) { if(!disposed) { progress.value=value; if(value.uploadId)lookupUploadId.value=value.uploadId; } }
async function upload() {
 if(!selected.value || busy.value) return; const uploadId=browserUuid();controller=new AbortController();busy.value=true;error.value="";
 // Keep the original transfer reference even if begin's reply is lost.
 lookupUploadId.value=uploadId;progress.value={uploadId,path:path.value,size:selected.value.size,offset:0,state:"submitted"};
 try{await new ComputerControlFiles(props.call).upload(selected.value,path.value,uploadId,controller.signal,publish);}catch(reason){if(!disposed)error.value=userFacingError(reason);}finally{if(!disposed)busy.value=false;}
}
async function download() { if(busy.value)return;controller=new AbortController();busy.value=true;error.value="";
 try{const blob=await new ComputerControlFiles(props.call).download(path.value,controller.signal,publish);if(!disposed && !controller.signal.aborted && !props.disabled){if(downloadUrl.value)URL.revokeObjectURL(downloadUrl.value);downloadUrl.value=URL.createObjectURL(blob);}}catch(reason){if(!disposed)error.value=userFacingError(reason);}finally{if(!disposed)busy.value=false;}
}
async function status() {if(!lookupUploadId.value)return;try{publish(await props.call({action:"upload.status",uploadId:lookupUploadId.value}) as ComputerFileProgress);}catch(reason){if(!disposed)error.value=userFacingError(reason);}}
async function cancel() {controller?.abort();if(!lookupUploadId.value)return;try{publish(await props.call({action:"upload.abort",uploadId:lookupUploadId.value}) as ComputerFileProgress);}catch(reason){if(!disposed)error.value=userFacingError(reason);}}
watch(()=>props.disabled,value=>{if(value)controller?.abort();});
onBeforeUnmount(()=>{disposed=true;controller?.abort();if(downloadUrl.value)URL.revokeObjectURL(downloadUrl.value);});
</script>
<template><div class="computer-files"><label>{{ t('本地文件') }}<input type="file" :disabled="disabled || busy" @change="select" /></label><v-text-field v-model="path" :label="t('目标电脑绝对路径')" :hint="t('上传使用原不覆盖协议；已存在文件不会被替换。')" persistent-hint density="compact" :disabled="busy" /><div class="file-buttons"><v-btn :disabled="disabled || !selected || !path" :loading="busy" variant="tonal" @click="upload">{{ t('上传') }}</v-btn><v-btn :disabled="disabled || !path || busy" variant="tonal" @click="download">{{ t('下载') }}</v-btn><v-btn :disabled="!lookupUploadId" variant="text" @click="status">{{ t('查询原传输') }}</v-btn><v-btn :disabled="!busy && !lookupUploadId" variant="text" @click="cancel">{{ t('取消传输') }}</v-btn><v-btn v-if="downloadUrl" :href="downloadUrl" :download="path.split(/[\\/]/).pop() || 'download'" variant="tonal">{{ t('保存已校验文件') }}</v-btn></div><details><summary>{{ t('查询已有上传') }}</summary><v-text-field v-model="lookupUploadId" :label="t('原传输标识')" density="compact" :hint="t('保留原标识查询或取消，不会重新创建上传。')" persistent-hint /></details><p v-if="progress" role="status">{{ progress.state }} · {{ progress.offset }} / {{ progress.size }}{{ t(' 字节') }}</p><v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert></div></template>
<style scoped>.computer-files{display:grid;gap:12px;padding:12px 0;min-width:0;}.computer-files label{display:grid;gap:8px;font-size:.9rem;}.computer-files input{max-width:100%;}.file-buttons{display:flex;flex-wrap:wrap;gap:8px;}</style>
