<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { managerEventSource } from "../managerApi";
import { useGatewayStore } from "../stores/gatewayStore";
import { getTimeoutMs } from "../timeoutSettingsClient";
import { isLoopbackHostname } from "../webguiLanRedirect";

const store = useGatewayStore();
const accountPath = "/api/rabilink/host-account";
const account = ref<{ id: string; username: string } | null>(null);
const avatar = ref("");
const avatarUnavailable = ref("");
const draft = ref("");
const dialog = ref<"login" | "register" | "avatar" | "configure" | null>(null);
const serverUrl = ref("");
const username = ref("");
const password = ref("");
const confirmation = ref("");
const error = ref("");
const busy = ref(false);
const choosingImage = ref(false);
const menu = ref(false);
const configuredServer = computed(() => store.meta.rabiLinkRelay?.url?.trim() || "");
let events: EventSource | undefined;
let request: AbortController | undefined;
let imageRevision = 0;
let disposed = false;

async function refreshAccount() {
  if (disposed || busy.value) return;
  request?.abort();
  const controller = new AbortController();
  request = controller;
  try {
    const response = await fetch(accountPath, { cache: "no-store", signal: controller.signal });
    if (!response.ok || controller.signal.aborted) return;
    const { account: next } = await response.json();
    if (controller.signal.aborted) return;
    if (account.value?.id !== next?.id) avatar.value = avatarUnavailable.value = "";
    account.value = next;
    if (!next) return;
    const picture = await fetch(`${accountPath}/avatar`, { cache: "no-store", signal: controller.signal });
    if (controller.signal.aborted) return;
    if (picture.status === 404) {
      const reason = await picture.json().catch(() => null);
      if (!controller.signal.aborted && account.value?.id === next.id) {
        avatarUnavailable.value = reason?.code === "RABILINK_RELAY_AVATAR_UNAVAILABLE" ? "当前服务器版本暂不支持头像。" : "当前主机版本暂不支持头像。";
      }
      return;
    }
    if (!picture.ok) return;
    const profile = await picture.json();
    if (!controller.signal.aborted && profile.accountId === account.value?.id) {
      avatarUnavailable.value = "";
      avatar.value = avatarUrl(profile.avatar);
    }
  } catch { /* A saved session can still be used when an avatar read is unavailable. */ }
}

function avatarUrl(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? `data:image/png;base64,${value}` : "";
}

function open(target: NonNullable<typeof dialog.value>) {
  menu.value = false;
  dialog.value = target;
  error.value = "";
}

function openAccount() {
  if (configuredServer.value) { open("login"); return; }
  serverUrl.value = "";
  open("configure");
}

async function saveServer() {
  if (busy.value || !serverUrl.value.trim()) return;
  error.value = "";
  busy.value = true;
  try {
    const url = new URL(serverUrl.value.trim());
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))) {
      throw new Error("请填写有效的 HTTPS 服务器地址。");
    }
    const response = await fetch("/api/rabi/identity", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rabiLinkRelay: { enabled: true, url: url.href } })
    });
    const body = await response.json();
    if (!response.ok || body.code !== 0 || !body.data?.rabiLinkRelay?.enabled || !body.data.rabiLinkRelay.url) {
      throw new Error(body.message || "未能保存服务器地址，请检查后重试。");
    }
    const { token: _token, ...relay } = body.data.rabiLinkRelay;
    store.meta.rabiLinkRelay = relay;
    open("login");
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "未能保存服务器地址，请重试。";
  } finally {
    busy.value = false;
    void refreshAccount();
  }
}

watch(dialog, () => {
  password.value = confirmation.value = draft.value = "";
  imageRevision += 1;
  choosingImage.value = false;
});

async function submit(action: "login" | "register" | "logout" | "avatar") {
  if (busy.value) return;
  error.value = "";
  if (action === "register" && password.value !== confirmation.value) {
    error.value = "两次输入的密码不一致。";
    return;
  }
  if (action === "avatar" && !draft.value) return;
  request?.abort();
  const deadline = AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000));
  busy.value = true;
  try {
    const response = await fetch(action === "avatar" ? `${accountPath}/avatar` : accountPath, {
      method: "POST",
      signal: deadline,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "avatar" ? { accountId: account.value?.id, avatar: draft.value.split(",")[1] }
        : action === "logout" ? { action } : { action, username: username.value.trim(), password: password.value })
    });
    const data = await response.json().catch(failure => {
      deadline.throwIfAborted();
      if (response.ok) throw failure;
      return null;
    });
    if (!response.ok) throw new Error(data?.message || "账号操作失败，请重试。");
    if (action === "avatar") {
      if (data.accountId !== account.value?.id) throw new Error("账号已更改，请重试。");
      avatar.value = avatarUrl(data.avatar);
    }
    else {
      if (account.value?.id !== data.account?.id) avatar.value = avatarUnavailable.value = "";
      account.value = data.account;
    }
    dialog.value = null;
    menu.value = false;
  } catch (failure) {
    error.value = deadline.aborted ? "账号操作响应超时，请核对左下角的登录状态。"
      : failure instanceof Error ? failure.message : "账号操作失败，请重试。";
  } finally {
    busy.value = false;
    if (deadline.aborted || action === "login" || action === "register") void refreshAccount();
  }
}

async function selectImage(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  const revision = ++imageRevision;
  draft.value = error.value = "";
  if (!file) { choosingImage.value = false; return; }
  choosingImage.value = true;
  try {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 8 * 1024 * 1024) {
      throw new Error("请选择不超过 8 MB 的 PNG、JPEG、WebP 或 GIF 图片。");
    }
    const image = await createImageBitmap(file);
    try {
      if (revision !== imageRevision) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 160;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法处理这张图片。");
      const side = Math.min(image.width, image.height);
      context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 160, 160);
      draft.value = canvas.toDataURL("image/png");
    } finally { image.close(); }
  } catch (failure) {
    if (revision === imageRevision) error.value = failure instanceof Error && /^请选择|^浏览器/.test(failure.message)
      ? failure.message : "无法读取图片，请换一张。";
  } finally {
    if (revision === imageRevision) choosingImage.value = false;
  }
}

onMounted(() => {
  events = managerEventSource("/api/events");
  events.addEventListener("rabilink_account_changed", refreshAccount);
  events.addEventListener("open", refreshAccount);
  window.addEventListener("focus", refreshAccount);
  void refreshAccount();
});
watch(() => [store.meta.applicationGenerationId, store.meta.rabiLinkRelay?.url, store.meta.rabiLinkRelay?.enabled], () => void refreshAccount());
onBeforeUnmount(() => {
  disposed = true;
  request?.abort();
  events?.close();
  window.removeEventListener("focus", refreshAccount);
  imageRevision += 1;
});
</script>

<template>
  <div class="rabi-account-dock">
    <v-menu v-if="account" v-model="menu" location="top start" :offset="8" :close-on-content-click="false">
      <template #activator="{ props }">
        <v-btn v-bind="props" block variant="tonal" class="sidebar-footer-btn rabi-account-trigger">
          <v-avatar size="28" color="secondary" variant="tonal" class="mr-2">
            <img v-if="avatar" :src="avatar" alt="">
            <template v-else>{{ Array.from(account.username)[0] }}</template>
          </v-avatar>
          <span class="rabi-account-name" data-no-i18n>{{ account.username }}</span>
          <v-icon icon="mdi-chevron-up" size="17" class="ml-auto" />
        </v-btn>
      </template>
      <v-list density="comfortable" min-width="190">
        <v-list-item prepend-icon="mdi-account-edit-outline" title="更换头像" :subtitle="avatarUnavailable || undefined" @click="open('avatar')" />
        <v-list-item prepend-icon="mdi-logout" title="退出登录" :disabled="busy" @click="submit('logout')" />
        <p v-if="error" role="alert" class="text-error px-3 pb-2">{{ error }}</p>
      </v-list>
    </v-menu>
    <v-btn v-else block color="secondary" variant="tonal" prepend-icon="mdi-account-outline" class="sidebar-footer-btn rabi-account-trigger" @click="openAccount">
      登录 Rabi 账号
    </v-btn>

    <v-dialog :model-value="dialog === 'login' || dialog === 'register'" max-width="440" :persistent="busy"
      :aria-label="dialog === 'register' ? '注册 Rabi 账号' : '登录 Rabi 账号'" @update:model-value="value => { if (!value) dialog = null; }">
      <v-card>
        <v-card-title class="d-flex align-center justify-space-between">
          {{ dialog === "register" ? "注册 Rabi 账号" : "登录 Rabi 账号" }}
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" :disabled="busy" @click="dialog = null" />
        </v-card-title>
        <v-card-text>
          <p class="mb-4">{{ dialog === "register" ? "注册成功后，这台电脑会自动登录。" : "在另一台电脑登录同一服务器上的同一账号，即可自动连接。" }}</p>
          <v-btn v-if="!store.meta.rabiLinkRelay?.enabled" variant="text" color="primary" class="mb-2"
            @click="serverUrl = configuredServer; open('configure')">启用服务器连接</v-btn>
          <form @submit.prevent="submit(dialog === 'register' ? 'register' : 'login')">
            <v-text-field v-model="username" label="账号" name="username" autocomplete="username" :disabled="busy" autofocus />
            <v-text-field v-model="password" label="密码" name="password" type="password" :autocomplete="dialog === 'register' ? 'new-password' : 'current-password'" :disabled="busy" />
            <v-text-field v-if="dialog === 'register'" v-model="confirmation" label="确认密码" type="password" autocomplete="new-password" :disabled="busy" />
            <p v-if="error" role="alert" class="text-error mb-3">{{ error }}</p>
            <v-btn type="submit" block color="primary" :loading="busy" :disabled="!username.trim() || !password || (dialog === 'register' && !confirmation)">
              {{ dialog === "register" ? "注册并登录" : "登录" }}
            </v-btn>
          </form>
          <div class="text-center mt-2">
            <v-btn variant="text" color="primary" :disabled="busy" @click="open(dialog === 'register' ? 'login' : 'register')">
              {{ dialog === "register" ? "返回登录" : "注册账号" }}
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="dialog === 'avatar'" max-width="440" :persistent="busy" aria-label="更换头像"
      @update:model-value="value => { if (!value) dialog = null; }">
      <v-card title="更换头像">
        <v-card-text>
          <p v-if="avatarUnavailable" role="status">{{ avatarUnavailable }}</p>
          <p v-else class="mb-4">头像保存在 Rabi 服务器，同一账号的其他电脑也可以看到。</p>
          <div v-if="!avatarUnavailable" class="d-flex align-center ga-3">
            <v-avatar size="56" color="secondary" variant="tonal">
              <img v-if="draft || avatar" :src="draft || avatar" alt="头像预览">
              <template v-else>{{ Array.from(account?.username || "?")[0] }}</template>
            </v-avatar>
            <label class="rabi-avatar-file">选择图片
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" :disabled="busy" @change="selectImage">
            </label>
          </div>
          <p v-if="error" role="alert" class="text-error mt-3">{{ error }}</p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn :disabled="busy" @click="dialog = null">取消</v-btn>
          <v-btn v-if="!avatarUnavailable" color="primary" variant="flat" :loading="busy" :disabled="!draft || choosingImage" @click="submit('avatar')">保存头像</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog :model-value="dialog === 'configure'" max-width="440" :persistent="busy" aria-label="配置服务器地址"
      @update:model-value="value => { if (!value) dialog = null; }">
      <v-card title="配置服务器地址">
        <form @submit.prevent="saveServer">
          <v-card-text>
            <v-text-field v-model="serverUrl" label="服务器地址" type="url" placeholder="https://…" :disabled="busy" autofocus />
            <p v-if="error" role="alert" class="text-error">{{ error }}</p>
          </v-card-text>
          <v-card-actions>
            <v-spacer />
            <v-btn :disabled="busy" @click="dialog = null">取消</v-btn>
            <v-btn type="submit" color="primary" variant="flat" :loading="busy" :disabled="!serverUrl.trim()">保存并继续</v-btn>
          </v-card-actions>
        </form>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.rabi-account-trigger :deep(.v-btn__content) { flex: 1; min-width: 0; }
.rabi-account-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-avatar img { width: 100%; height: 100%; object-fit: cover; }
.rabi-avatar-file { min-width: 0; }
.rabi-avatar-file input { display: block; max-width: 100%; margin-top: 6px; }
</style>
