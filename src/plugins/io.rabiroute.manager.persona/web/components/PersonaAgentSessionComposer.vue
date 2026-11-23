<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { WEB_CHAT_ATTACHMENT_COUNT, WEB_CHAT_ATTACHMENT_MAX_BYTES, WEB_CHAT_ATTACHMENTS_MAX_BYTES } from '@shared/agentWebChat';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { chatComposerAction, readChatComposerShortcuts } from '../../../../../ribiwebgui/src/chatComposerShortcuts';
import { usePersonaService } from '../persona/personaServiceClient';
import { canAttachToWebChat, createAgentWebChatClient, createWebChatIntent, type WebChatIntent, type WebChatTarget } from '../persona/agentWebChatClient';

const props = defineProps<{ target?: WebChatTarget }>();
const emit = defineEmits<{ sent: [key: string] }>();
const { t } = useI18n();
const client = createAgentWebChatClient(usePersonaService().fetch);
const picker = ref<HTMLInputElement>();
type Draft = { text: string; files: File[]; busy: boolean; status: 'editing' | 'uncertain' | 'retry'; message: string; intent?: WebChatIntent };
const drafts = reactive(new Map<string, Draft>());
const draft = computed(() => {
  const key = props.target?.key;
  return key ? drafts.get(key) : undefined;
});
const canAttach = computed(() => props.target ? canAttachToWebChat(props.target.agent) : false);

function draftFor(key: string) {
  if (!drafts.has(key)) drafts.set(key, { text: '', files: [], busy: false, status: 'editing', message: '' });
  return drafts.get(key)!;
}

function edit(value: string) {
  if (!props.target) return;
  const current = draftFor(props.target.key);
  current.text = value;
  current.message = '';
}

function addFiles(files: File[]) {
  if (!props.target || !canAttach.value || !files.length) return;
  const current = draftFor(props.target.key);
  if (current.busy || current.status !== 'editing') return;
  const combined = [...current.files, ...files];
  if (combined.length > WEB_CHAT_ATTACHMENT_COUNT || combined.some(file => file.size > WEB_CHAT_ATTACHMENT_MAX_BYTES)
    || combined.reduce((sum, file) => sum + file.size, 0) > WEB_CHAT_ATTACHMENTS_MAX_BYTES) {
    current.message = '最多 8 个附件，单个不超过 10 MiB，合计不超过 25 MiB。';
    return;
  }
  current.files = combined;
  current.message = '';
}

function pickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  addFiles(Array.from(input.files ?? []));
  input.value = '';
}

function pasteFiles(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (canAttach.value && files.length) addFiles(files);
}

async function submit() {
  const target = props.target;
  if (!target) return;
  const current = draftFor(target.key);
  if (current.busy || (!current.text.trim() && !current.files.length)) return;
  current.busy = true;
  current.message = '';
  try {
    const intent = current.intent ?? await createWebChatIntent(current.text, current.files);
    current.intent = intent;
    const result = current.status === 'uncertain' ? await client.receipt(target, intent) : await client.send(target, intent);
    if (result.state === 'accepted') {
      drafts.delete(target.key);
      emit('sent', target.key);
      return;
    }
    current.status = result.state === 'failed' ? 'editing' : result.state;
    if (result.state === 'failed') current.intent = undefined;
    current.message = result.message ?? t({ failed: '消息发送失败。', uncertain: '发送结果待确认，可以查询原回执。', retry: '确认消息尚未送达，可以重试原消息。' }[result.state]);
  } catch {
    current.message = t('无法读取附件。');
  } finally { current.busy = false; }
}

function handleKey(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  const action = chatComposerAction(event, readChatComposerShortcuts());
  event.preventDefault();
  if (!action || event.repeat) return;
  if (action === 'send') {
    void submit();
    return;
  }
  const input = event.target;
  if (input instanceof HTMLTextAreaElement && !input.readOnly
    && (input.maxLength < 0 || input.value.length - (input.selectionEnd - input.selectionStart) < input.maxLength)) {
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
</script>

<template>
  <form v-if="target" class="session-composer" @submit.prevent="submit">
    <div v-if="draft?.files.length" class="composer-files">
      <v-chip v-for="(file,index) in draft.files" :key="`${index}:${file.name}`" :closable="!draft.busy && draft.status === 'editing'" size="small" :title="file.name" @click:close="draft.files.splice(index,1)">
        <span class="composer-filename" data-no-i18n>{{ file.name }}</span>
      </v-chip>
    </div>
    <div class="composer-row">
      <input ref="picker" type="file" multiple hidden @change="pickFiles" />
      <v-btn icon="mdi-paperclip" variant="text" size="small" :aria-label="t('添加附件')" :title="t(canAttach ? '添加附件' : '此 Agent 端仅支持发送文字。')" :disabled="!canAttach || draft?.busy || !!draft?.intent" @click="picker?.click()" />
      <v-textarea :model-value="draft?.text || ''" @update:model-value="edit" @keydown="handleKey" @paste="pasteFiles" :aria-label="t('发送消息到此会话')" :placeholder="t('发送消息到此会话')" :readonly="draft?.busy || !!draft?.intent" :maxlength="200000" rows="1" max-rows="5" auto-grow density="compact" variant="outlined" hide-details />
      <v-btn type="submit" :icon="draft?.status === 'uncertain' ? 'mdi-receipt-text-check-outline' : 'mdi-send'" color="secondary" variant="text" :aria-label="t(draft?.status === 'uncertain' ? '查询发送回执' : draft?.status === 'retry' ? '重试原消息' : '发送消息')" :title="t(draft?.status === 'uncertain' ? '查询发送回执' : draft?.status === 'retry' ? '重试原消息' : '发送消息')" :loading="draft?.busy" :disabled="draft?.busy || (!draft?.text.trim() && !draft?.files.length)" />
    </div>
    <p v-if="draft?.message" class="text-caption text-medium-emphasis" role="status">{{ t(draft.message) }}</p>
  </form>
</template>

<style scoped>
.session-composer{flex:none;min-width:0;padding:8px 12px;border-top:1px solid rgba(var(--v-theme-on-surface),.12);background:rgb(var(--v-theme-background));}
.composer-row{display:flex;align-items:flex-end;gap:4px;}
.composer-row :deep(.v-input){min-width:0;}
.composer-files{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;}
.composer-filename{display:block;max-width:min(210px,50vw);overflow:hidden;text-overflow:ellipsis;}
</style>
