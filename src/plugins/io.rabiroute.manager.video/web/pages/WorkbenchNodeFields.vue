<script setup lang="ts">
import { computed } from "vue";
import { configFields, configValue, changeConfig, type ConfigField } from "./workbenchEditor";
const props=defineProps<{kind:string;modelValue:Record<string,any>;fields?:ConfigField[]}>();
const emit=defineEmits<{"update:modelValue":[value:Record<string,any>]}>();
const fields = computed(() => (props.fields?.length ? props.fields : (configFields[props.kind] || [])).filter(field => {
  // The Agent picker owns the target once a CLI or an exact session is bound; a session still needs its source task.
  if (props.modelValue.cli) return !/^(agentBindingKey|target\.|source\.)/.test(field.path);
  if (props.modelValue.target?.threadId) return !/^(agentBindingKey|target\.)/.test(field.path);
  return true;
}));
const parameters = computed(() => (Array.isArray(props.modelValue.parameterSchema) ? props.modelValue.parameterSchema : [])
  .filter(param => !props.modelValue.cli || param.name !== "model"));
function display(field:ConfigField){const value=configValue(props.modelValue,field.path);return field.type==='lines'?(Array.isArray(value)?value.join('\n'):value==null?'':String(value)):value??'';}
function parameter(param:Record<string,any>){return Object.hasOwn(props.modelValue.parameterValues||{},param.name)?props.modelValue.parameterValues[param.name]:param.default;}
function updateParameter(param:Record<string,any>,value:string|boolean){if(param.kind==='check'&&!props.modelValue.checkParameterSink)return;const values={...(props.modelValue.parameterValues||{})};if(value==='')delete values[param.name];else values[param.name]=param.type==='number'?Number(value):value;emit('update:modelValue',{...props.modelValue,parameterValues:values});}
function resetParameter(name:string){const values={...(props.modelValue.parameterValues||{})};delete values[name];emit('update:modelValue',{...props.modelValue,parameterValues:values});}
</script>
<template>
  <div class="node-fields">
    <label v-for="field in fields" :key="field.path">
      <template v-if="field.type==='boolean'"><input type="checkbox" :checked="configValue(modelValue,field.path)===true" @change="emit('update:modelValue',changeConfig(props.modelValue,field,($event.target as HTMLInputElement).checked))"/>{{field.label}}</template>
      <template v-else>{{field.label}}
        <select v-if="field.type==='select'" :value="configValue(modelValue,field.path)||''" @change="emit('update:modelValue',changeConfig(props.modelValue,field,($event.target as HTMLSelectElement).value))"><option value="">选择位置或类型</option><option v-for="option in field.options" :key="option" :value="option">{{option}}</option></select>
        <textarea v-else-if="field.type==='lines'||field.type==='textarea'" :value="display(field)" rows="3" @input="emit('update:modelValue',changeConfig(props.modelValue,field,($event.target as HTMLTextAreaElement).value))"/>
        <input v-else :type="field.type==='number'?'number':'text'" :value="configValue(modelValue,field.path)??''" @input="emit('update:modelValue',changeConfig(props.modelValue,field,($event.target as HTMLInputElement).value))"/>
      </template>
    </label>
    <fieldset v-if="parameters.length"><legend>工作流参数</legend><label v-for="param in parameters" :key="param.name">{{param.label||param.name}}<small v-if="param.kind==='check'&&!modelValue.checkParameterSink">检查阈值由工具配置管理</small><input v-if="param.type==='flag'" type="checkbox" :checked="parameter(param)===true" :disabled="param.kind==='check'&&!modelValue.checkParameterSink" @change="updateParameter(param,($event.target as HTMLInputElement).checked)"/><select v-else-if="Array.isArray(param.options)" :value="parameter(param)" :disabled="param.kind==='check'&&!modelValue.checkParameterSink" @change="updateParameter(param,($event.target as HTMLSelectElement).value)"><option v-for="option in param.options" :key="String(option)" :value="option">{{option}}</option></select><input v-else :type="param.type==='number'?'number':'text'" :min="param.min" :max="param.max" :value="parameter(param)??''" :disabled="param.kind==='check'&&!modelValue.checkParameterSink" @input="updateParameter(param,($event.target as HTMLInputElement).value)"/><button v-if="Object.hasOwn(modelValue.parameterValues||{},param.name)" class="reset-param" @click="resetParameter(param.name)">恢复默认</button></label></fieldset>
  </div>
</template>
<style scoped>.node-fields label{display:block;margin:14px 0;color:var(--wb-muted,#b5c4d1);font-size:12px}.node-fields input,.node-fields textarea,.node-fields select{display:block;width:100%;padding:9px 10px;margin-top:6px;background:var(--wb-input,#192630);border:1px solid var(--wb-border,#405363);border-radius:6px;color:var(--wb-text,#edf3f7);font:inherit;font-size:14px}.node-fields input[type=checkbox]{display:inline-block;width:auto;margin-right:8px}.node-fields textarea{resize:vertical}.node-fields fieldset{border:0;border-top:1px solid var(--wb-border);padding:12px 0}.node-fields legend{font-size:12px;padding-right:10px}.node-fields small{display:block;color:#d6bd87;margin-top:5px}.node-fields :disabled{opacity:.55}.reset-param{font-size:11px;color:var(--wb-accent);margin-top:5px}</style>
