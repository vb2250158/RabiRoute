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
const draftName = ref("");
const nameUnavailable = ref("");
const nameError = ref("");
const nameBusy = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const dialog = ref<"login" | "register" | "profile" | "configure" | null>(null);
const serverUrl = ref("");
const username = ref("");
const password = ref("");
const confirmation = ref("");
const error = ref("");
const busy = ref(false);
const choosingImage = ref(false);
const menu = ref(false);
const configuredServer = computed(() => store.meta.rabiLinkRelay?.url?.trim() || "");
const previewAvatar = computed(() => draft.value || avatar.value);
const initial = computed(() => Array.from(account.value?.username || "?")[0] || "?");
const trimmedName = computed(() => draftName.value.trim());
const profileDirty = computed(() => Boolean(draft.value)
  || (!nameUnavailable.value && trimmedName.value !== (account.value?.username || "") && trimmedName.value.length > 0));
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
    const identity = await fetch(`${accountPath}/profile`, { cache: "no-store", signal: controller.signal });
    if (!identity.ok || controller.signal.aborted) return;
    const saved = await identity.json();
    const current = account.value;
    if (!controller.signal.aborted && current && saved.accountId === current.id && typeof saved.username === "string" && saved.username) {
      account.value = { ...current, username: saved.username };
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
  nameError.value = "";
  if (target === "profile") void loadProfile();
}

function openAccount() {
  if (configuredServer.value) { open("login"); return; }
  serverUrl.value = "";
  open("configure");
}

async function loadProfile() {
  const id = account.value?.id;
  draftName.value = account.value?.username || "";
  nameUnavailable.value = "";
  if (!id) return;
  nameBusy.value = true;
  try {
    const response = await fetch(`${accountPath}/profile`, { cache: "no-store" });
    if (account.value?.id !== id) return;
    if (response.status === 404) {
      const reason = await response.json().catch(() => null);
      nameUnavailable.value = reason?.code === "RABILINK_RELAY_PROFILE_UNAVAILABLE" ? "当前服务器版本暂不支持修改用户名。" : "当前主机版本暂不支持修改用户名。";
      return;
    }
    if (!response.ok) return;
    const saved = await response.json();
    if (account.value?.id !== id || saved.accountId !== id || typeof saved.username !== "string" || !saved.username) return;
    draftName.value = saved.username;
    if (account.value.username !== saved.username) account.value = { ...account.value, username: saved.username };
  } catch { /* Keep the locally known name; saving reports its own error. */ }
  finally { nameBusy.value = false; }
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

async function submit(action: "login" | "register" | "logout") {
  if (busy.value) return;
  error.value = "";
  if (action === "register" && password.value !== confirmation.value) {
    error.value = "两次输入的密码不一致。";
    return;
  }
  request?.abort();
  const deadline = AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000));
  busy.value = true;
  try {
    const response = await fetch(accountPath, {
      method: "POST",
      signal: deadline,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action === "logout" ? { action } : { action, username: username.value.trim(), password: password.value })
    });
    const data = await response.json().catch(failure => {
      deadline.throwIfAborted();
      if (response.ok) throw failure;
      return null;
    });
    if (!response.ok) throw new Error(data?.message || "账号操作失败，请重试。");
    if (account.value?.id !== data.account?.id) avatar.value = avatarUnavailable.value = "";
    account.value = data.account;
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

async function saveProfile() {
  const current = account.value;
  if (busy.value || choosingImage.value || !current) return;
  error.value = "";
  nameError.value = "";
  const rename = !nameUnavailable.value && trimmedName.value !== current.username;
  const uploadAvatar = Boolean(draft.value);
  if (!rename && !uploadAvatar) { dialog.value = null; return; }
  busy.value = true;
  try {
    if (rename) {
      const response = await fetch(`${accountPath}/profile`, {
        method: "POST",
        signal: AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: current.id, username: trimmedName.value })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 404) {
        nameUnavailable.value = data?.code === "RABILINK_RELAY_PROFILE_UNAVAILABLE" ? "当前服务器版本暂不支持修改用户名。" : "当前主机版本暂不支持修改用户名。";
        throw new Error(nameUnavailable.value);
      }
      if (!response.ok) {
        if (response.status === 400 || response.status === 409) {
          nameError.value = data?.message || "请检查用户名后重试。";
          return;
        }
        throw new Error(data?.message || "用户名保存失败，请重试。");
      }
      if (data?.accountId !== current.id || typeof data.username !== "string" || !data.username) throw new Error("账号已更改，请重试。");
      account.value = { ...current, username: data.username };
      draftName.value = data.username;
    }
    if (uploadAvatar) {
      const response = await fetch(`${accountPath}/avatar`, {
        method: "POST",
        signal: AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: account.value?.id, avatar: draft.value.split(",")[1] })
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.message || "头像保存失败，请重试。");
      if (data.accountId !== account.value?.id) throw new Error("账号已更改，请重试。");
      avatar.value = avatarUrl(data.avatar);
      draft.value = "";
      avatarUnavailable.value = "";
    }
    dialog.value = null;
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : "保存失败，请重试。";
  } finally {
    busy.value = false;
  }
}

function pickImage() {
  if (busy.value || choosingImage.value || avatarUnavailable.value) return;
  fileInput.value?.click();
}

function clearDraft() {
  draft.value = "";
  error.value = "";
  imageRevision += 1;
}

async function selectImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await applyImage(file);
}

function dropImage(event: DragEvent) {
  if (busy.value || choosingImage.value || avatarUnavailable.value) return;
  const file = event.dataTransfer?.files?.[0];
  if (file) void applyImage(file);
}

async function applyImage(file: File) {
  const revision = ++imageRevision;
  draft.value = error.value = "";
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
            <template v-else>{{ initial }}</template>
          </v-avatar>
          <span class="rabi-account-name" data-no-i18n>{{ account.username }}</span>
          <v-icon icon="mdi-chevron-up" size="17" class="ml-auto" />
        </v-btn>
      </template>
      <v-list density="comfortable" min-width="248" class="rabi-account-menu">
        <v-list-item class="px-3 py-2">
          <v-avatar size="40" color="secondary" variant="tonal">
            <img v-if="avatar" :src="avatar" alt="">
            <template v-else>{{ initial }}</template>
          </v-avatar>
          <div class="ml-3 rabi-account-menu-copy">
            <div class="rabi-account-menu-name" data-no-i18n>{{ account.username }}</div>
            <div class="text-caption text-medium-emphasis">Rabi 账号</div>
          </div>
        </v-list-item>
        <v-divider class="my-1" />
        <v-list-item prepend-icon="mdi-account-edit-outline" title="个人资料" subtitle="用户名与头像" @click="open('profile')" />
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

    <v-dialog :model-value="dialog === 'profile'" max-width="480" :persistent="busy" aria-label="个人资料"
      @update:model-value="value => { if (!value) dialog = null; }">
      <v-card>
        <div class="rabi-profile-head">
          <div class="rabi-profile-heading">
            <div class="text-subtitle-1 font-weight-medium">个人资料</div>
            <div class="text-caption text-medium-emphasis">用户名和头像保存在 Rabi 服务器，同一账号的其他电脑也能看到。</div>
          </div>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" :disabled="busy" @click="dialog = null" />
        </div>
        <v-card-text class="pt-1">
          <div class="rabi-profile-row">
            <button type="button" class="rabi-profile-avatar" :class="{ 'is-busy': choosingImage }"
              :disabled="busy || choosingImage || Boolean(avatarUnavailable)" aria-label="更换头像"
              @click="pickImage" @dragover.prevent @dragenter.prevent @drop.prevent="dropImage">
              <img v-if="previewAvatar" :src="previewAvatar" alt="">
              <span v-else class="rabi-profile-initial">{{ initial }}</span>
              <span class="rabi-profile-mask">
                <v-icon icon="mdi-camera-outline" size="18" />
                <span>{{ previewAvatar ? "更换" : "上传" }}</span>
              </span>
              <v-progress-circular v-if="choosingImage" indeterminate size="26" width="3" class="rabi-profile-spinner" />
            </button>
            <div class="rabi-profile-avatar-copy">
              <div class="text-body-2 font-weight-medium mb-1">头像</div>
              <p class="text-caption text-medium-emphasis mb-2">
                {{ avatarUnavailable || "点击头像选择图片，或把图片拖到这里。支持 PNG、JPEG、WebP、GIF，最大 8 MB，自动裁成正方形。" }}
              </p>
              <div class="d-flex flex-wrap ga-2">
                <v-btn size="small" variant="tonal" prepend-icon="mdi-image-outline"
                  :disabled="busy || choosingImage || Boolean(avatarUnavailable)" @click="pickImage">选择图片</v-btn>
                <v-btn v-if="draft" size="small" variant="text" :disabled="busy" @click="clearDraft">撤销更换</v-btn>
              </div>
            </div>
          </div>
          <input ref="fileInput" class="rabi-profile-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
            tabindex="-1" aria-hidden="true" @change="selectImage">
          <v-divider class="my-5" />
          <v-text-field v-model="draftName" label="用户名" :disabled="busy || nameBusy || Boolean(nameUnavailable)"
            :loading="nameBusy" maxlength="48" autocomplete="username" :error-messages="nameError ? [nameError] : []"
            @update:model-value="nameError = ''" />
          <p class="text-caption text-medium-emphasis mt-n1">
            {{ nameUnavailable || "3-48 位，可包含中文、字母、数字、下划线、点、@ 或短横线。用户名同时是登录名，改完后在其他电脑登录请使用新用户名。" }}
          </p>
          <p v-if="error" role="alert" class="text-error text-body-2 mt-3">{{ error }}</p>
        </v-card-text>
        <v-card-actions class="px-4 pb-3">
          <v-spacer />
          <v-btn :disabled="busy" @click="dialog = null">取消</v-btn>
          <v-btn color="primary" variant="flat" :loading="busy" :disabled="!profileDirty || choosingImage" @click="saveProfile">保存</v-btn>
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
.rabi-account-menu-copy { min-width: 0; }
.rabi-account-menu-name { font-size: 0.9rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-avatar img { width: 100%; height: 100%; object-fit: cover; }

.rabi-profile-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 8px 24px;
}
.rabi-profile-heading { min-width: 0; }
.rabi-profile-row { display: flex; align-items: flex-start; gap: 16px; }
.rabi-profile-avatar {
  position: relative;
  flex: 0 0 auto;
  width: 88px;
  height: 88px;
  padding: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 50%;
  overflow: hidden;
  display: grid;
  place-items: center;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface));
  background: rgba(var(--v-theme-secondary), 0.16);
  transition: box-shadow 0.18s ease;
}
.rabi-profile-avatar:hover:not(:disabled),
.rabi-profile-avatar:focus-visible:not(:disabled) { box-shadow: 0 0 0 4px rgba(var(--v-theme-primary), 0.18); }
.rabi-profile-avatar:disabled { cursor: default; }
.rabi-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
.rabi-profile-initial { font-size: 30px; font-weight: 600; line-height: 1; }
.rabi-profile-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  opacity: 0;
  transition: opacity 0.18s ease;
}
.rabi-profile-avatar:hover:not(:disabled) .rabi-profile-mask,
.rabi-profile-avatar:focus-visible .rabi-profile-mask { opacity: 1; }
.rabi-profile-spinner { position: absolute; color: #fff; }
.rabi-profile-avatar-copy { min-width: 0; flex: 1; }
.rabi-profile-file { display: none; }
</style>
