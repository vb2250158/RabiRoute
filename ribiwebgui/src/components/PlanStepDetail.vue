<script setup lang="ts">
import { computed } from "vue";
import { parsePlanStepDetail } from "../planStepDetail";

const props = defineProps<{ text: string }>();
const parsed = computed(() => parsePlanStepDetail(props.text));
const plainText = computed(() => {
  const first = parsed.value.blocks[0];
  return first?.type === "paragraph" ? first.text : "";
});
</script>

<template>
  <div v-if="parsed.structured" class="plan-step-detail" data-no-i18n>
    <template v-for="(block, index) in parsed.blocks" :key="`${block.type}-${index}`">
      <div v-if="block.type === 'heading'" class="plan-step-detail__heading">{{ block.text }}</div>
      <div v-else-if="block.type === 'paragraph'" class="plan-step-detail__paragraph">{{ block.text }}</div>
      <ul v-else-if="block.type === 'unordered-list'" class="plan-step-detail__list">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
      </ul>
      <ol v-else class="plan-step-detail__list plan-step-detail__list--ordered">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex">{{ item }}</li>
      </ol>
    </template>
  </div>
  <div v-else class="plan-step-detail plan-step-detail--plain" data-no-i18n>{{ plainText }}</div>
</template>

<style scoped>
.plan-step-detail {
  display: grid;
  min-width: 0;
  gap: 5px;
  color: var(--rr-text);
  font-size: 11px;
  line-height: 1.55;
}

.plan-step-detail__heading {
  margin-top: 3px;
  color: var(--rr-heading);
  font-weight: 900;
}

.plan-step-detail__heading:first-child {
  margin-top: 0;
}

.plan-step-detail__paragraph,
.plan-step-detail__list,
.plan-step-detail--plain {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.plan-step-detail__paragraph,
.plan-step-detail--plain {
  color: var(--rr-muted);
}

.plan-step-detail__list {
  display: grid;
  gap: 4px;
  padding-left: 19px;
}

.plan-step-detail__list li {
  min-width: 0;
  padding-left: 2px;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.plan-step-detail__list--ordered li::marker {
  color: var(--rr-accent-text);
  font-weight: 900;
}
</style>
