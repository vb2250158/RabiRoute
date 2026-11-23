<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from '../../../../../ribiwebgui/src/i18n/index';
import { bindChatHistoryLoadOlder, chatHistoryScroller } from '../../../../../ribiwebgui/src/personaChatHistoryLayout';

const props = defineProps<{ active: boolean; loading: boolean }>();
const emit = defineEmits<{ load: [] }>();
const { t } = useI18n();
const boundary = ref<HTMLElement>();
let dispose: (() => void) | undefined;
function load() {
  if (props.active && !props.loading) emit('load');
}
onMounted(() => {
  const scroller = chatHistoryScroller(boundary.value);
  if (!scroller) return;
  dispose = bindChatHistoryLoadOlder(scroller, load, scroller === document.scrollingElement ? document : scroller);
});
onBeforeUnmount(() => dispose?.());
</script>

<template>
  <div ref="boundary" class="mb-3">
    <v-btn variant="text" :loading="loading" :disabled="!active || loading" @click="load">{{ t('加载更早的消息') }}</v-btn>
  </div>
</template>
