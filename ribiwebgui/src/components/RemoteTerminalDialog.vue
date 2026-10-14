<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { RemoteTerminalClient, type RemoteTerminal } from "../remoteTerminalClient";
import { userFacingError } from "../userFacingError";
import { browserUuid } from "../browserUuid";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ instanceId: string; name: string; token: string }>();
const emit = defineEmits<{ close: [] }>();
const client = new RemoteTerminalClient(props.instanceId, props.token);
const sessions = ref<RemoteTerminal[]>([]);
const shells = ref<string[]>([]);
const shell = ref("cmd"); const cwd = ref("");
const current = ref<RemoteTerminal>(); const error = ref(""); const busy = ref(false); const blocked = ref(true);
const container = ref<HTMLElement>();
let terminal: Terminal | undefined; let fit: FitAddon | undefined; let observer: ResizeObserver | undefined;
let stream: AbortController | undefined; let revision = 0; let disposed = false; let inputQueue = Promise.resolve(); let pendingBytes = 0;
const activeCount = computed(() => sessions.value.filter(item => ["starting", "running"].includes(item.state)).length);

async function query() {
  const result = await client.request<{ shells: string[]; sessions: RemoteTerminal[] }>();
  if (disposed) return;
  shells.value = result.shells; sessions.value = result.sessions;
}
async function refresh() {
  busy.value = true; error.value = "";
  try {
    await inputQueue;
    await query();
    if (current.value) {
      const latest = sessions.value.find(item => item.terminalId === current.value?.terminalId);
      if (latest) { current.value = latest; blocked.value = latest.state !== "running"; }
    }
  } catch (reason) { error.value = userFacingError(reason); } finally { busy.value = false; }
}
async function initialize() {
  if (terminal) return;
  const [{ Terminal: NativeTerminal }, { FitAddon: NativeFit }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  await nextTick(); if (disposed || !container.value) return;
  terminal = new NativeTerminal({ cursorBlink: true, scrollback: 2000, fontSize: 14, theme: { background: "#101820", foreground: "#dbe7ef" } });
  fit = new NativeFit(); terminal.loadAddon(fit); terminal.open(container.value); fit.fit();
  terminal.onData(data => {
    const selected = current.value; const generation = revision;
    if (!selected || blocked.value || selected.state !== "running") return;
    if (pendingBytes + data.length > 65536) { blocked.value = true; error.value = "输入积压，已停止发送。请查询会话状态；未自动重放输入。"; return; }
    const codepoints = Array.from(data);
    for (let offset = 0; offset < codepoints.length; offset += 2048) {
      const part = codepoints.slice(offset, offset + 2048).join(""); pendingBytes += part.length;
      inputQueue = inputQueue.catch(() => undefined).then(async () => {
        if (blocked.value || generation !== revision || disposed) return;
        try {
          const receipt = await client.request<RemoteTerminal>({ action: "input", terminalId: selected.terminalId, sequence: selected.nextInputSequence, data: part });
          if (generation === revision) selected.nextInputSequence = receipt.nextInputSequence;
        } catch (reason) { if (generation === revision) { blocked.value = true; error.value = `${userFacingError(reason)}；请查询会话状态，输入未自动重发。`; } }
      }).finally(() => { pendingBytes -= part.length; });
    }
  });
  terminal.onResize(size => {
    if (!current.value || blocked.value) return;
    void client.request({ action: "resize", terminalId: current.value.terminalId, ...size }).catch(reason => { error.value = userFacingError(reason); });
  });
  observer = new ResizeObserver(() => fit?.fit()); observer.observe(container.value);
}
async function attach(session: RemoteTerminal) {
  const generation = ++revision;
  stream?.abort(); blocked.value = true; current.value = session; error.value = "";
  await initialize();
  if (generation !== revision || disposed || !terminal) return;
  terminal.reset(); terminal.focus();
  const controller = new AbortController(); stream = controller;
  blocked.value = session.state !== "running";
  void client.events(session.terminalId, controller.signal, event => {
    if (generation !== revision || disposed) return;
    if (event.type === "output") terminal?.write(event.data || "");
    if (event.type === "gap") terminal?.writeln("\r\n[较早输出已超出缓存范围]\r\n");
    if (["exit", "disconnected"].includes(event.type)) {
      blocked.value = true; session.state = "exited";
      terminal?.writeln(`\r\n[${event.type === "exit" ? `终端已退出：${event.exitCode ?? "—"}` : "远端连接已断开"}]`);
    }
  }).then(() => {
    if (!controller.signal.aborted && generation === revision && session.state === "running") {
      blocked.value = true; error.value = "输出连接已结束；请查询会话并重新打开，不会自动重建终端。";
    }
  }).catch(reason => { if (!controller.signal.aborted && generation === revision) { blocked.value = true; error.value = userFacingError(reason); } });
  if (session.state === "running") await client.request({ action: "resize", terminalId: session.terminalId, cols: terminal.cols, rows: terminal.rows });
}
async function openTerminal() {
  busy.value = true; error.value = "";
  const terminalId = browserUuid();
  try {
    const session = await client.request<RemoteTerminal>({ action: "open", terminalId, shell: shell.value, ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}) });
    await query(); await attach(session);
  } catch (reason) { error.value = `${userFacingError(reason)}。可查询终端列表核对结果；未自动重建会话。`; }
  finally { busy.value = false; }
}
async function exitTerminal(session: RemoteTerminal) {
  busy.value = true; error.value = "";
  try { await client.request({ action: "close", terminalId: session.terminalId }); await query(); if (current.value?.terminalId === session.terminalId) blocked.value = true; }
  catch (reason) { error.value = userFacingError(reason); } finally { busy.value = false; }
}
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { disposed = true; revision++; stream?.abort(); observer?.disconnect(); terminal?.dispose(); });
</script>

<template>
  <v-dialog :model-value="true" max-width="1180" @update:model-value="value => { if (!value) emit('close'); }">
    <v-card>
      <v-card-title class="d-flex align-center justify-space-between"><span>{{ name }} · 远端终端</span><v-btn icon="mdi-close" variant="text" aria-label="关闭终端窗口" @click="emit('close')" /></v-card-title>
      <v-card-text>
        <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
        <div class="d-flex flex-wrap ga-3 align-start mb-3">
          <v-select v-model="shell" :items="shells.map(value => ({ title: value === 'cmd' ? 'CMD' : 'PowerShell', value }))" label="终端类型" hide-details density="compact" style="max-width: 180px" />
          <v-text-field v-model="cwd" label="远端工作目录（留空使用默认目录）" hide-details density="compact" style="min-width: 250px" />
          <v-btn :loading="busy" :disabled="!shells.length" color="primary" prepend-icon="mdi-plus" @click="openTerminal">新增终端</v-btn>
          <v-btn :loading="busy" variant="tonal" prepend-icon="mdi-refresh" @click="refresh">查询终端</v-btn>
        </div>
        <div class="terminal-layout">
          <v-list class="terminal-sessions" density="compact" border rounded>
            <v-list-subheader>会话 · {{ activeCount }} 个运行中</v-list-subheader>
            <v-list-item v-for="session in sessions" :key="session.terminalId" :active="current?.terminalId === session.terminalId" @click="attach(session).catch(reason => { error = userFacingError(reason); })">
              <v-list-item-title>{{ session.shell === 'cmd' ? 'CMD' : 'PowerShell' }} · {{ session.pid || '—' }}</v-list-item-title>
              <v-list-item-subtitle>{{ session.state === 'running' ? '运行中' : '已退出' }} · {{ session.cwd }}</v-list-item-subtitle>
              <template #append><v-btn v-if="session.state === 'running'" icon="mdi-stop-circle-outline" variant="text" size="small" title="退出终端并结束子程序" :disabled="busy" @click.stop="exitTerminal(session)" /></template>
            </v-list-item>
            <p v-if="!sessions.length" class="text-body-2 pa-3">暂无终端，选择类型后新增。</p>
          </v-list>
          <div><div ref="container" class="remote-terminal" /><p class="text-caption mt-2">关闭窗口保留会话；“退出终端”会结束该终端及其中启动的子程序。</p></div>
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>
<style scoped>
.terminal-layout { display: grid; grid-template-columns: 260px minmax(0,1fr); gap: 16px; }
.terminal-sessions { max-height: 500px; overflow: auto; }
.remote-terminal { height: 460px; padding: 12px; background: #101820; border-radius: 8px; overflow: hidden; }
@media(max-width:800px) { .terminal-layout { grid-template-columns: minmax(0,1fr); } .terminal-sessions { max-height: 160px; } }
</style>
