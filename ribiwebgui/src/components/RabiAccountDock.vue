<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { managerEventSource } from "../managerApi";
import { useGatewayStore } from "../stores/gatewayStore";
import { getTimeoutMs } from "../timeoutSettingsClient";
import { isLoopbackHostname } from "../webguiLanRedirect";

const store = useGatewayStore();
const accountPath = "/api/rabilink/host-account";
type Account = { id: string; username: string; nickname?: string | null };
const account = ref<Account | null>(null);
const avatar = ref("");
const avatarUnavailable = ref("");
const draft = ref("");
const draftNickname = ref("");
const originalNickname = ref("");
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
const displayName = computed(() => account.value?.nickname || account.value?.username || "");
const initial = computed(() => Array.from(displayName.value)[0] || "?");
const nicknameDirty = computed(() => !nameBusy.value && !nameUnavailable.value
  && draftNickname.value !== originalNickname.value);
const profileDirty = computed(() => Boolean(draft.value) || nicknameDirty.value);
let events: EventSource | undefined;
let request: AbortController | undefined;
let profileRequest: AbortController | undefined;
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
    account.value = next && account.value?.id === next.id ? { ...account.value, ...next } : next;
    if (!next) return;
    await Promise.allSettled([refreshAvatar(next.id, controller.signal), readProfile(next.id, controller.signal)]);
  } catch { /* Keep the last account snapshot when the local Manager is unavailable. */ }
}

async function refreshAvatar(id: string, signal: AbortSignal) {
  const picture = await fetch(`${accountPath}/avatar`, { cache: "no-store", signal });
  if (signal.aborted) return;
  if (picture.status === 404) {
    const reason = await picture.json().catch(() => null);
    if (!signal.aborted && account.value?.id === id) {
      avatarUnavailable.value = reason?.code === "RABILINK_RELAY_AVATAR_UNAVAILABLE" ? "当前服务器版本暂不支持头像。" : "当前主机版本暂不支持头像。";
    }
    return;
  }
  if (!picture.ok) return;
  const profile = await picture.json();
  if (!signal.aborted && profile.accountId === id && account.value?.id === id) {
    avatarUnavailable.value = "";
    avatar.value = avatarUrl(profile.avatar);
  }
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

function unavailableNickname(reason: unknown) {
  return reason === "RABILINK_RELAY_PROFILE_UNAVAILABLE" ? "更新服务器后可编辑昵称。" : "更新 RabiRoute 后可编辑昵称。";
}

function applyProfile(saved: { accountId?: unknown; username?: unknown; nickname?: unknown }, id: string) {
  if (!saved || saved.accountId !== id || account.value?.id !== id
    || typeof saved.username !== "string" || (saved.nickname !== null && typeof saved.nickname !== "string")) return false;
  account.value = { id, username: saved.username, nickname: saved.nickname };
  return true;
}

async function readProfile(id: string, signal: AbortSignal) {
  const response = await fetch(`${accountPath}/profile`, { cache: "no-store", signal });
  const saved = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (response.status === 404) return unavailableNickname(saved?.code);
  if (!response.ok) throw new Error(saved?.message || "暂时无法读取昵称，请重新打开个人资料。");
  if (saved?.nickname === undefined) return unavailableNickname(undefined);
  if (!applyProfile(saved, id)) throw new Error("账号已更改，请重新打开个人资料。");
  return "";
}

async function loadProfile() {
  const id = account.value?.id;
  draftNickname.value = originalNickname.value = account.value?.nickname ?? "";
  nameUnavailable.value = "";
  if (!id) return;
  profileRequest?.abort();
  const controller = new AbortController();
  profileRequest = controller;
  nameBusy.value = true;
  try {
    const unavailable = await readProfile(id, AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]));
    if (controller.signal.aborted || account.value?.id !== id) return;
    nameUnavailable.value = unavailable;
    draftNickname.value = originalNickname.value = account.value.nickname ?? "";
  } catch {
    if (!controller.signal.aborted) nameUnavailable.value = "暂时无法读取昵称，请重新打开个人资料。";
  } finally {
    if (profileRequest === controller) nameBusy.value = false;
  }
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
  if (dialog.value !== "profile") profileRequest?.abort();
  password.value = confirmation.value = draft.value = "";
  imageRevision += 1;
  choosingImage.value = false;
});
watch(() => account.value?.id, () => {
  if (dialog.value === "profile") dialog.value = null;
}, { flush: "sync" });

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
  const saveNickname = nicknameDirty.value;
  const uploadAvatar = Boolean(draft.value);
  if (!saveNickname && !uploadAvatar) return;
  request?.abort();
  busy.value = true;
  try {
    if (saveNickname) {
      const response = await fetch(`${accountPath}/profile`, {
        method: "POST",
        signal: AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: current.id, nickname: draftNickname.value })
      });
      const data = await response.json().catch(() => null);
      if (response.status === 404) {
        nameUnavailable.value = unavailableNickname(data?.code);
        throw new Error(nameUnavailable.value);
      }
      if (!response.ok) {
        if (response.status === 400) {
          nameError.value = data?.message || "请检查昵称后重试。";
          return;
        }
        throw new Error(data?.message || "昵称保存失败，请重试。");
      }
      if (!applyProfile(data, current.id)) throw new Error("无法确认昵称已保存，请重新打开个人资料。");
      draftNickname.value = originalNickname.value = data.nickname ?? "";
    }
    if (uploadAvatar) {
      const response = await fetch(`${accountPath}/avatar`, {
        method: "POST",
        signal: AbortSignal.timeout(getTimeoutMs("webgui.rabilink.account.submit", 30000)),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: current.id, avatar: draft.value.split(",")[1] })
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
  profileRequest?.abort();
  events?.close();
  window.removeEventListener("focus", refreshAccount);
  imageRevision += 1;
});
</script>

<template>
  <div class="rabi-account-dock">
    <v-menu v-if="account" v-model="menu" location="top start" :offset="8" content-class="rabi-account-popover" :close-on-content-click="false">
      <template #activator="{ props }">
        <v-btn v-bind="props" block variant="text" class="sidebar-footer-btn rabi-account-trigger" :class="{ 'is-open': menu }">
          <v-avatar size="28" color="secondary" variant="tonal">
            <img v-if="avatar" :src="avatar" alt="">
            <template v-else>{{ initial }}</template>
          </v-avatar>
          <bdi class="rabi-account-name" data-no-i18n>{{ displayName }}</bdi>
          <v-icon icon="mdi-chevron-up" size="16" class="rabi-account-chevron" />
        </v-btn>
      </template>
      <v-list density="compact" class="rabi-account-menu">
        <div class="rabi-account-summary">
          <v-avatar size="36" color="secondary" variant="tonal">
            <img v-if="avatar" :src="avatar" alt="">
            <template v-else>{{ initial }}</template>
          </v-avatar>
          <div class="rabi-account-summary-copy">
            <bdi class="rabi-account-menu-name" data-no-i18n>{{ displayName }}</bdi>
            <bdi v-if="account.nickname" class="rabi-account-caption" :title="account.username" data-no-i18n>{{ account.username }}</bdi>
            <div v-else class="rabi-account-caption">Rabi 账号</div>
          </div>
        </div>
        <v-list-item class="rabi-account-action" prepend-icon="mdi-account-edit-outline" title="个人资料" @click="open('profile')" />
        <v-list-item class="rabi-account-action" prepend-icon="mdi-logout" title="退出登录" :disabled="busy" @click="submit('logout')" />
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
      <v-card class="rabi-profile-card">
        <div class="rabi-profile-head">
          <div class="rabi-profile-heading">
            <h2>个人资料</h2>
            <div class="rabi-profile-account">
              <span>登录账号</span>
              <bdi data-no-i18n>{{ account?.username }}</bdi>
            </div>
          </div>
          <v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭" :disabled="busy" @click="dialog = null" />
        </div>
        <v-card-text class="rabi-profile-fields">
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
              <div class="text-body-2 font-weight-medium mb-2">头像</div>
              <div class="d-flex flex-wrap ga-2">
                <v-btn size="small" variant="outlined" prepend-icon="mdi-image-outline"
                  :disabled="busy || choosingImage || Boolean(avatarUnavailable)" @click="pickImage">选择图片</v-btn>
                <v-btn v-if="draft" size="small" variant="text" :disabled="busy" @click="clearDraft">撤销更换</v-btn>
              </div>
              <p class="rabi-profile-note">{{ avatarUnavailable || "支持拖放图片，最大 8 MB。" }}</p>
            </div>
          </div>
          <input ref="fileInput" class="rabi-profile-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
            tabindex="-1" aria-hidden="true" @change="selectImage">
          <v-text-field v-model="draftNickname" label="昵称" variant="outlined" autocomplete="nickname"
            :disabled="busy || nameBusy || Boolean(nameUnavailable)" :loading="nameBusy"
            :hint="nameUnavailable || '留空时显示登录账号。'" persistent-hint
            :error-messages="nameError ? [nameError] : []" @update:model-value="nameError = ''" />
          <p v-if="error" role="alert" class="text-error text-body-2">{{ error }}</p>
        </v-card-text>
        <v-card-actions class="rabi-profile-actions">
          <v-spacer />
          <v-btn :disabled="busy" @click="dialog = null">取消</v-btn>
          <v-btn class="rabi-profile-save" variant="flat" :loading="busy" :disabled="!profileDirty || choosingImage" @click="saveProfile">保存</v-btn>
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
.rabi-account-trigger.v-btn {
  height: 40px;
  padding-inline: 8px;
  border-radius: 10px;
}
.rabi-account-trigger.is-open { background: var(--rr-accent-surface); }
.rabi-account-trigger :deep(.v-btn__content) { flex: 1; min-width: 0; gap: 9px; }
.rabi-account-name,
.rabi-account-menu-name,
.rabi-account-caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rabi-account-name { font-size: 13px; font-weight: 600; }
.rabi-account-chevron { margin-inline-start: auto; color: var(--rr-muted); transition: transform 160ms ease; }
.rabi-account-trigger.is-open .rabi-account-chevron { transform: rotate(180deg); }
:global(.rabi-account-popover.v-overlay__content > .rabi-account-menu.v-list) {
  width: min(232px, calc(100vw - 32px));
  padding: 5px;
  border: 1px solid var(--rr-border-soft);
  border-radius: 14px;
  box-shadow: 0 12px 28px rgb(0 0 0 / 24%);
}
.rabi-account-summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 8px 11px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--rr-border-soft);
}
.rabi-account-summary .v-avatar { flex: none; }
.rabi-account-summary-copy { min-width: 0; }
.rabi-account-menu-name { display: block; font-size: 14px; font-weight: 650; }
.rabi-account-caption { display: block; color: var(--rr-muted); font-size: 12px; }
.rabi-account-action.v-list-item {
  min-height: 36px;
  padding-inline: 8px;
  border-radius: 8px;
}
.rabi-account-action :deep(.v-list-item__prepend .v-icon) {
  --v-icon-size-multiplier: 0.8;
}
.rabi-account-action :deep(.v-list-item__prepend .v-list-item__spacer) { width: 10px; }
.rabi-account-action :deep(.v-list-item-title) { font-size: 13px; }
.v-avatar img { width: 100%; height: 100%; object-fit: cover; }

.rabi-profile-card.v-card { border-radius: 16px; border: 1px solid var(--rr-border-soft); }
.rabi-profile-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 20px 16px 16px 24px;
}
.rabi-profile-heading { min-width: 0; }
.rabi-profile-heading h2 { font-size: 18px; font-weight: 650; line-height: 1.4; }
.rabi-profile-account { display: flex; flex-wrap: wrap; gap: 2px 8px; margin-top: 5px; color: var(--rr-muted); font-size: 12px; }
.rabi-profile-account bdi { color: var(--rr-text); overflow-wrap: anywhere; min-width: 0; }
.rabi-profile-fields.v-card-text { display: grid; gap: 18px; padding: 0 24px 12px; }
.rabi-profile-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
  border-radius: 12px;
  background: var(--rr-accent-surface);
}
.rabi-profile-note { color: var(--rr-muted); font-size: 12px; margin-top: 5px; }
.rabi-profile-actions.v-card-actions { justify-content: flex-end; padding: 4px 24px 18px; }
.rabi-profile-save.v-btn:not(:disabled) {
  background: var(--rr-accent-strong);
  color: var(--rr-on-accent-strong);
}
.rabi-profile-avatar {
  position: relative;
  flex: 0 0 auto;
  width: 64px;
  height: 64px;
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
.rabi-profile-initial { font-size: 23px; font-weight: 600; line-height: 1; }
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
@media (prefers-reduced-motion: reduce) {
  .rabi-account-chevron, .rabi-profile-avatar, .rabi-profile-mask { transition: none; }
}
</style>
