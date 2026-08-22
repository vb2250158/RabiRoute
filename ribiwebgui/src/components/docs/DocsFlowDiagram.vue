<script setup lang="ts">
import type { DocFlowDiagram } from "../../docs/rabilinkAiuiDocs";

defineProps<{
  diagram: DocFlowDiagram;
}>();
</script>

<template>
  <figure class="flow-diagram" :aria-label="diagram.title">
    <figcaption class="flow-diagram-caption">
      <strong>{{ diagram.title }}</strong>
      <span>{{ diagram.caption }}</span>
    </figcaption>

    <div class="flow-diagram-lanes">
      <section v-for="lane in diagram.lanes" :key="lane.label" class="flow-diagram-lane">
        <div class="flow-diagram-lane-label">{{ lane.label }}</div>
        <ol class="flow-diagram-steps">
          <li v-for="(step, index) in lane.steps" :key="`${lane.label}-${step.title}`" class="flow-diagram-step">
            <div class="flow-diagram-node" :class="`is-${step.kind}`">
              <v-icon class="flow-diagram-node-icon" size="18" aria-hidden="true">{{ step.icon }}</v-icon>
              <div>
                <strong>{{ step.title }}</strong>
                <span>{{ step.detail }}</span>
              </div>
            </div>
            <v-icon
              v-if="index < lane.steps.length - 1"
              class="flow-diagram-arrow"
              size="18"
              aria-hidden="true"
            >mdi-arrow-right</v-icon>
          </li>
        </ol>
      </section>
    </div>
  </figure>
</template>

<style scoped>
.flow-diagram {
  margin: 0;
  color: var(--rr-text);
}

.flow-diagram-caption {
  display: grid;
  gap: 5px;
  margin-bottom: 18px;
}

.flow-diagram-caption strong {
  color: var(--rr-heading);
  font-size: 16px;
  font-weight: 800;
}

.flow-diagram-caption span {
  color: var(--rr-muted);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.6;
}

.flow-diagram-lanes {
  display: grid;
  gap: 18px;
}

.flow-diagram-lane {
  min-width: 0;
}

.flow-diagram-lane-label {
  margin-bottom: 8px;
  color: var(--rr-muted-soft);
  font-size: 11px;
  font-weight: 800;
}

.flow-diagram-steps {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(142px, 1fr));
  gap: 22px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.flow-diagram-step {
  position: relative;
  min-width: 0;
}

.flow-diagram-node {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 9px;
  align-items: start;
  min-height: 74px;
  padding: 12px;
  border: 1px solid var(--rr-border);
  border-radius: 6px;
  background: var(--rr-surface);
}

.flow-diagram-node-icon {
  margin-top: 1px;
  color: var(--rr-accent-strong);
}

.flow-diagram-node strong,
.flow-diagram-node span {
  display: block;
  overflow-wrap: anywhere;
}

.flow-diagram-node strong {
  color: var(--rr-heading);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.35;
}

.flow-diagram-node span {
  margin-top: 5px;
  color: var(--rr-muted-soft);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.45;
}

.flow-diagram-node.is-mode,
.flow-diagram-node.is-agent {
  border-color: var(--rr-accent-border);
  background: var(--rr-accent-surface);
}

.flow-diagram-node.is-decision {
  border-color: var(--rr-info-border);
  background: var(--rr-info-surface);
}

.flow-diagram-node.is-warning {
  border-color: var(--rr-warning-border);
  background: var(--rr-warning-surface);
}

.flow-diagram-node.is-result {
  border-color: var(--rr-success-border);
  background: var(--rr-success-surface);
}

.flow-diagram-arrow {
  position: absolute;
  top: 28px;
  right: -20px;
  color: var(--rr-disabled);
}

@media (max-width: 720px) {
  .flow-diagram-steps {
    grid-template-columns: 1fr;
    gap: 28px;
  }

  .flow-diagram-node {
    min-height: 0;
  }

  .flow-diagram-arrow {
    top: auto;
    right: 50%;
    bottom: -23px;
    transform: translateX(50%) rotate(90deg);
  }
}
</style>
