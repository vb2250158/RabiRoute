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
}

.flow-diagram-caption {
  display: grid;
  gap: 5px;
  margin-bottom: 18px;
}

.flow-diagram-caption strong {
  color: #0c2a4a;
  font-size: 16px;
  font-weight: 800;
}

.flow-diagram-caption span {
  color: #52677a;
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
  color: #687b8e;
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
  border: 1px solid rgba(17, 32, 51, .12);
  border-radius: 6px;
  background: rgba(248, 251, 253, .9);
}

.flow-diagram-node-icon {
  margin-top: 1px;
  color: #0f8b8d;
}

.flow-diagram-node strong,
.flow-diagram-node span {
  display: block;
  overflow-wrap: anywhere;
}

.flow-diagram-node strong {
  color: #0c2a4a;
  font-size: 13px;
  font-weight: 800;
  line-height: 1.35;
}

.flow-diagram-node span {
  margin-top: 5px;
  color: #687b8e;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.45;
}

.flow-diagram-node.is-mode,
.flow-diagram-node.is-agent {
  border-color: rgba(15, 139, 141, .34);
  background: rgba(229, 249, 248, .74);
}

.flow-diagram-node.is-decision {
  border-color: rgba(62, 105, 170, .3);
  background: rgba(235, 242, 252, .78);
}

.flow-diagram-node.is-warning {
  border-color: rgba(190, 125, 22, .34);
  background: rgba(255, 248, 230, .82);
}

.flow-diagram-node.is-result {
  border-color: rgba(43, 126, 77, .3);
  background: rgba(235, 249, 239, .82);
}

.flow-diagram-arrow {
  position: absolute;
  top: 28px;
  right: -20px;
  color: #8491a0;
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
