<script setup lang="ts">
import type { RabiLinkQuickStartGuide } from "../../docs/rabilinkAiuiDocs";

defineProps<{
  guide: RabiLinkQuickStartGuide;
}>();
</script>

<template>
  <div class="quick-start-guide">
    <section v-for="(phase, phaseIndex) in guide.phases" :key="phase.title" class="quick-start-phase">
      <header class="quick-start-phase-header">
        <span>{{ phaseIndex + 1 }}</span>
        <div>
          <h4>{{ phase.title }}</h4>
          <p>{{ phase.note }}</p>
        </div>
      </header>

      <ol class="quick-start-steps">
        <li v-for="(step, stepIndex) in phase.steps" :key="step.title" class="quick-start-step">
          <div class="quick-start-step-index">{{ stepIndex + 1 }}</div>
          <div class="quick-start-step-body">
            <div class="quick-start-step-title">
              <v-icon size="19" aria-hidden="true">{{ step.icon }}</v-icon>
              <strong>{{ step.title }}</strong>
            </div>
            <p>{{ step.instruction }}</p>
            <div class="quick-start-complete">
              <v-icon size="16" aria-hidden="true">mdi-check-circle-outline</v-icon>
              <span><b>完成标志：</b>{{ step.completeWhen }}</span>
            </div>
            <v-btn
              v-if="step.action"
              class="quick-start-action"
              color="secondary"
              variant="tonal"
              size="small"
              :href="step.action.href"
              :target="step.action.external ? '_blank' : undefined"
              :rel="step.action.external ? 'noopener noreferrer' : undefined"
              :prepend-icon="step.action.external ? 'mdi-open-in-new' : 'mdi-arrow-right'"
            >
              {{ step.action.label }}
            </v-btn>
          </div>
        </li>
      </ol>
    </section>

    <section class="quick-start-reference">
      <div>
        <h4>可以直接说</h4>
        <div class="quick-start-commands">
          <code v-for="command in guide.voiceCommands" :key="command">{{ command }}</code>
        </div>
      </div>
      <div class="quick-start-security">
        <h4><v-icon size="18" aria-hidden="true">mdi-shield-key-outline</v-icon> Token 安全</h4>
        <ul>
          <li v-for="note in guide.securityNotes" :key="note">{{ note }}</li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.quick-start-guide {
  display: grid;
  gap: 30px;
}

.quick-start-phase {
  min-width: 0;
}

.quick-start-phase-header {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  margin-bottom: 16px;
}

.quick-start-phase-header > span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 6px;
  background: #0f8b8d;
  color: #ffffff;
  font-size: 14px;
  font-weight: 800;
}

.quick-start-phase h4,
.quick-start-reference h4 {
  margin: 0;
  color: #0c2a4a;
  font-size: 16px;
  font-weight: 800;
}

.quick-start-phase-header p,
.quick-start-step p {
  margin: 5px 0 0;
  color: #52677a;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.65;
}

.quick-start-steps {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.quick-start-step {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(17, 32, 51, .11);
  border-radius: 6px;
  background: rgba(248, 251, 253, .84);
}

.quick-start-step-index {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(15, 139, 141, .32);
  border-radius: 50%;
  color: #0f8b8d;
  font-size: 12px;
  font-weight: 800;
}

.quick-start-step-body {
  min-width: 0;
}

.quick-start-step-title {
  display: flex;
  gap: 8px;
  align-items: center;
  color: #0f8b8d;
}

.quick-start-step-title strong {
  color: #0c2a4a;
  font-size: 14px;
  font-weight: 800;
}

.quick-start-complete {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  margin-top: 10px;
  color: #2b7e4d;
}

.quick-start-complete span {
  color: #52677a;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
}

.quick-start-complete b {
  color: #2b7e4d;
  font-weight: 800;
}

.quick-start-action {
  margin-top: 12px;
}

.quick-start-reference {
  display: grid;
  grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr);
  gap: 22px;
  padding-top: 24px;
  border-top: 1px solid rgba(17, 32, 51, .1);
}

.quick-start-commands {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 12px;
}

.quick-start-commands code {
  padding: 6px 8px;
  border-radius: 5px;
  background: #071827;
  color: #d7f8ff;
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
}

.quick-start-security h4 {
  display: flex;
  gap: 7px;
  align-items: center;
  color: #9a6515;
}

.quick-start-security ul {
  display: grid;
  gap: 7px;
  margin: 12px 0 0;
  padding-left: 18px;
  color: #52677a;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.55;
}

@media (max-width: 720px) {
  .quick-start-reference {
    grid-template-columns: 1fr;
  }

  .quick-start-step {
    grid-template-columns: 26px minmax(0, 1fr);
    padding: 12px;
  }

  .quick-start-step-index {
    width: 26px;
    height: 26px;
  }
}
</style>
