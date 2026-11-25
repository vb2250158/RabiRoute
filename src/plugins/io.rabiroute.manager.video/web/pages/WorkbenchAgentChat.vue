<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import {
  loadWorkbenchAgentHistory, sendWorkbenchAgentMessage,
  type WorkbenchAgentMessage, type WorkbenchAgentSelection,
} from "./workbenchAgentCatalog";

const props = defineProps<{ selection?: WorkbenchAgentSelection; conversation?: { role: string; text: string }[]; multiTurn?: boolean }>();
const emit = defineEmits<{ append: [text: string] }>();
const messages = ref<WorkbenchAgentMessage[]>([]);
const draft = ref("");
const loading = ref(false);
const sending = ref(false);
const error = ref("");
const receipt = ref("");
const cursor = ref<string | null>(null);
let flight = 0, disposed = false, controller: AbortController | undefined;

const targetKey = computed(() => (props.selection?.kind === "session" ? `${props.selection.provider}:${props.selection.threadId}` : ""));
const isSession = computed(() => props.selection?.kind === "session");
const sessionSelection = computed(() => (props.selection?.kind === "session" ? props.selection : undefined));
const trimmed = computed(() => draft.value.trim());
const canSend = computed(() => Boolean(isSession.value && trimmed.value && !sending.value && !loading.value));
const localMessages = computed(() => (Array.isArray(props.conversation) ? props.conversation : []).filter(row => row && typeof row.text === "string" && row.text.trim()));
const canAppend = computed(() => Boolean(!isSession.value && props.multiTurn === true && trimmed.value));

function reset() {
  messages.value = [];
  cursor.value = null;
  error.value = "";
  receipt.value = "";
}

async function load(older = false) {
  if (!isSession.value) { loading.value = false; reset(); return; }
  const key = targetKey.value, token = ++flight;
  controller?.abort();
  controller = new AbortController();
  loading.value = true;
  error.value = "";
  try {
    const page = await loadWorkbenchAgentHistory(props.selection, older ? cursor.value ?? undefined : undefined, 30, controller.signal);
    if (disposed || token !== flight || key !== targetKey.value) return;
    messages.value = older ? [...new Map([...page.messages, ...messages.value].map(row => [row.id, row])).values()] : page.messages;
    cursor.value = page.cursor;
  } catch (cause) {
    if (disposed || token !== flight || (cause as Error)?.name === "AbortError") return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === flight && !disposed) loading.value = false;
  }
}

function appendLocal() {
  if (!canAppend.value) return;
  emit("append", trimmed.value);
  draft.value = "";
}

async function send() {
  if (!canSend.value) return;
  const text = trimmed.value, token = ++flight;
  sending.value = true;
  error.value = "";
  receipt.value = "";
  try {
    const result = await sendWorkbenchAgentMessage(props.selection, text, browserUuid());
    if (disposed || token !== flight) return;
    draft.value = "";
    const status = result?.data?.statusCode ?? result?.statusCode;
    receipt.value = status === 202 || result?.status === "accepted" ? "已投递，等待对方回复。" : "已发送。";
    messages.value = [...messages.value, { id: `local:${browserUuid()}`, role: "user", text }];
  } catch (cause) {
    if (!disposed && token === flight) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (token === flight && !disposed) sending.value = false;
  }
}

onMounted(() => { void load(); });
watch(targetKey, () => { void load(); });
onBeforeUnmount(() => { disposed = true; flight++; controller?.abort(); });
</script>

<template>
  <section class="agent-chat" aria-label="Agent 对话">
    <header>
      <strong>对话</strong>
      <small v-if="sessionSelection?.deviceName">{{ sessionSelection.deviceName }}</small>
      <button type="button" :disabled="loading || sending" @click="load()">{{ loading ? '读取中…' : '刷新' }}</button>
    </header>
    <p v-if="!isSession && !multiTurn" class="hint">先在上面选择一个已接入的 Agent 会话，这里会显示它的真实对话；CLI 节点可在节点设置里打开“多轮迭代”保留本地对话。</p>
    <template v-else-if="!isSession">
      <div class="messages" role="log">
        <p v-if="!localMessages.length" class="hint">还没有对话。加入第一条后，运行时会按节点设置把这段上下文带上。</p>
        <article v-for="(message, index) in localMessages" :key="index" :class="message.role">
          <span class="role">{{ message.role === 'assistant' ? 'Agent' : '我' }}</span>
          <p>{{ message.text }}</p>
        </article>
      </div>
      <div class="composer">
        <textarea v-model="draft" rows="3" maxlength="20000" placeholder="加入下一轮要带给 Agent 的内容…" aria-label="加入节点对话的内容" @keydown.ctrl.enter.prevent="appendLocal"/>
        <button type="button" class="send" :disabled="!canAppend" @click="appendLocal">加入对话</button>
      </div>
    </template>
    <template v-else>
      <p v-if="receipt" class="hint ok">{{ receipt }}</p>
      <p v-if="error" class="hint error">{{ error }}</p>
      <div class="messages" role="log">
        <p v-if="!loading && !messages.length && !error" class="hint">这个会话还没有可读取的消息。</p>
        <article v-for="message in messages" :key="message.id" :class="message.role">
          <span class="role">{{ message.role === 'user' ? '我' : (sessionSelection?.agentName || 'Agent') }}</span>
          <p>{{ message.text }}</p>
          <time v-if="message.time">{{ new Date(message.time).toLocaleString() }}</time>
        </article>
        <button v-if="cursor" class="older" type="button" :disabled="loading" @click="load(true)">读取更早的消息</button>
      </div>
      <div class="composer">
        <textarea v-model="draft" rows="3" maxlength="20000" placeholder="继续对 Agent 说…" aria-label="要发送给 Agent 的消息" @keydown.ctrl.enter.prevent="send"/>
        <button type="button" class="send" :disabled="!canSend" @click="send">{{ sending ? '发送中…' : '发送' }}</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-chat { display:grid; gap:10px; color:var(--wb-text,#edf3f7); }
header { display:flex; align-items:center; gap:8px; }
header strong { font-size:12px; font-weight:550; }
header small { color:var(--wb-muted,#aebdca); font-size:11px; }
header button { margin-left:auto; border:1px solid var(--wb-border,#405363); background:transparent; color:inherit; border-radius:6px; padding:4px 9px; font:inherit; font-size:11px; }
.hint { margin:0; color:var(--wb-muted,#aebdca); font-size:11px; line-height:1.7; }
.hint.error { color:#e9958a; }
.hint.ok { color:var(--wb-accent,#80cecc); }
.messages { max-height:320px; overflow:auto; display:grid; gap:8px; padding:8px; border:1px solid var(--wb-border,#405363); border-radius:8px; background:#0d1720; }
article { display:grid; gap:4px; padding:8px 10px; border-radius:8px; background:#16232c; }
article.user { background:#1b2c33; }
article .role { font-size:10px; letter-spacing:1px; color:var(--wb-muted,#aebdca); }
article p { margin:0; font-size:13px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; }
article time { font-size:10px; color:#7f939f; }
.older { justify-self:center; border:0; background:transparent; color:var(--wb-accent,#80cecc); font-size:11px; }
.composer { display:grid; gap:8px; }
textarea { width:100%; padding:9px 10px; background:var(--wb-input,#192630); border:1px solid var(--wb-border,#405363); border-radius:6px; color:inherit; font:inherit; font-size:13px; resize:vertical; }
.send { justify-self:end; border:1px solid var(--wb-accent,#80cecc); background:transparent; color:var(--wb-accent,#80cecc); border-radius:6px; padding:6px 14px; font:inherit; font-size:12px; }
.send:disabled { opacity:.45; }
</style>
