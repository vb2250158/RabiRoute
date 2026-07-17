<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { NotificationRule, NotificationScheduleDefinition } from "../types";
import {
  configNameFor,
  defaultHeartbeatSchedule,
  isBuiltinRolePanelRule,
  notificationRulesForGateway,
  routeKindDefinitionsForGateway,
  routeKindLabels,
  routeKindSummary,
  ruleHasGroupRoute,
  ruleTemplateSnippet,
  templateVars
} from "../utils/gatewayHelpers";

const store = useGatewayStore();
const route = useRoute();
const router = useRouter();
const ruleDialog = ref(false);
const activeRuleIndex = ref(0);
const ruleMatchParamsOpen = ref(true);
const ruleRouteKindsOpen = ref(true);
const ruleSchedulesOpen = ref(true);
const ruleTemplateOpen = ref(true);

const gateway = computed(() => store.selectedGateway);
const runtime = computed(() => store.selectedRuntime);
const roleOptions = computed(() => [
  { title: "不注入人格", value: "" },
  ...((runtime.value.roleInfo?.options || []).map(role => ({ title: role.label || role.value, value: role.value })))
]);
const selectedRole = computed(() => {
  const roleId = gateway.value?.agentRoleId || "";
  return (runtime.value.roleInfo?.options || []).find(role => role.value === roleId);
});
const hasPersona = computed(() => Boolean(gateway.value?.agentRoleId));
const rules = computed(() => gateway.value ? notificationRulesForGateway(gateway.value) : []);
const activeRule = computed(() => rules.value[activeRuleIndex.value] || null);
const variableEntries = computed(() => Object.entries(gateway.value?.routeVariables || {}));
const roleDirLabel = computed(() => runtime.value.roleInfo?.rolesDir || "./data/roles");
const routeKindQuery = ref("");
const routeKindDefinitions = computed(() => routeKindDefinitionsForGateway(gateway.value || undefined));
const selectedRouteKindCount = computed(() => activeRule.value?.routeKinds?.length || 0);
const activeRuleDiagnostics = computed(() => activeRule.value ? ruleDiagnostics(activeRule.value) : []);
const activeRuleNotes = computed(() => activeRule.value ? ruleNotes(activeRule.value) : []);
const ruleDiagnosticsCount = computed(() => rules.value.reduce((count, rule) => count + ruleDiagnostics(rule).length, 0));
const scheduleTypeOptions = [
  { title: "每隔一段时间", value: "interval" },
  { title: "每天指定时间", value: "daily_time" },
  { title: "某一天指定时间", value: "once_at" }
];
const activeRuleHasHeartbeat = computed(() => activeRule.value?.routeKinds?.includes("heartbeat") === true);
const visibleRouteKindDefinitions = computed(() => {
  const query = routeKindQuery.value.trim().toLowerCase();
  if (!query) return routeKindDefinitions.value;
  return routeKindDefinitions.value
    .map(definition => ({
      ...definition,
      groups: definition.groups
        .map(group => ({
          ...group,
          routeKinds: group.routeKinds.filter(kind => {
            return [
              definition.title,
              definition.note,
              group.title,
              kind,
              routeKindLabels[kind] || ""
            ].join(" ").toLowerCase().includes(query);
          })
        }))
        .filter(group => group.routeKinds.length > 0)
    }))
    .filter(definition => definition.groups.length > 0);
});

function openRule(index: number): void {
  activeRuleIndex.value = index;
  ruleMatchParamsOpen.value = true;
  ruleRouteKindsOpen.value = true;
  ruleSchedulesOpen.value = true;
  ruleTemplateOpen.value = true;
  ruleDialog.value = true;
}

function patchRule(patch: Partial<NotificationRule>): void {
  store.updateRule(activeRuleIndex.value, patch);
}

function ruleDiagnostics(rule: NotificationRule): string[] {
  const issues: string[] = [];
  if (!Array.isArray(rule.routeKinds) || rule.routeKinds.length === 0) {
    issues.push("未选择路由类型时会匹配全部入口；建议明确选择要接收的消息来源。");
  }
  if (rule.regex && !/\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    try {
      new RegExp(rule.regex);
    } catch {
      issues.push("消息匹配正则无法解析，保存后可能导致匹配失败。");
    }
  }
  if (rule.routeKinds?.includes("heartbeat") && (!Array.isArray(rule.schedules) || rule.schedules.length === 0)) {
    issues.push("包含 heartbeat 但没有定时计划，只能通过手动触发验证。");
  }
  return issues;
}

function ruleNotes(rule: NotificationRule): string[] {
  const notes: string[] = [];
  if (!String(rule.template || "").trim()) {
    notes.push("模板为空时仍会发送基础 AgentPacket，只是不追加自定义模板正文。");
  }
  if (rule.regex && /\{[a-zA-Z0-9_]+\}/.test(rule.regex)) {
    notes.push("正则包含路由变量，保存后会按运行时变量展开再匹配。");
  }
  return notes;
}

function toggleRouteKind(kind: string, checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  if (checked) next.add(kind);
  else next.delete(kind);
  patchRule({ routeKinds: [...next] });
}

function setRouteKinds(kinds: string[], checked: boolean): void {
  if (!activeRule.value) return;
  const next = new Set(activeRule.value.routeKinds || []);
  kinds.forEach(kind => {
    if (checked) next.add(kind);
    else next.delete(kind);
  });
  patchRule({ routeKinds: [...next] });
}

function addSchedule(): void {
  if (!activeRule.value || !gateway.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const schedule = defaultHeartbeatSchedule(gateway.value, `计划 ${schedules.length + 1}`);
  patchRule({ schedules: [...schedules, schedule] });
}

function updateSchedule(index: number, patch: Partial<NotificationScheduleDefinition>): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  const current = schedules[index];
  if (!current) return;
  schedules[index] = { ...current, ...patch };
  patchRule({ schedules });
}

function setScheduleType(index: number, type: string): void {
  if (type !== "interval" && type !== "daily_time" && type !== "once_at") return;
  updateSchedule(index, { type });
}

function removeSchedule(index: number): void {
  if (!activeRule.value) return;
  const schedules = Array.isArray(activeRule.value.schedules) ? [...activeRule.value.schedules] : [];
  schedules.splice(index, 1);
  patchRule({ schedules });
}

function setRole(value: string): void {
  if (!gateway.value) return;
  gateway.value.agentRoleId = value;
  if (!value) gateway.value.notificationRules = [];
  store.touch();
}

function updateVariableKey(oldKey: string, value: string, event: Event): void {
  const target = event.target as HTMLInputElement | null;
  store.updateRouteVariable(oldKey, target?.value || oldKey, value);
}

// URL ↔ gateway 双向同步（放最后避免 TDZ）
watch([() => route.params.id as string, () => store.gateways], ([id]) => {
  if (!id || !store.gateways.length) return;
  const found = store.gateways.find(g => configNameFor(g) === id || g.id === id);
  if (found && found.id !== store.selectedGatewayId) store.selectGateway(found.id);
}, { immediate: true });

watch(() => store.selectedGatewayId, (id) => {
  const gw = store.gateways.find(g => g.id === id);
  const name = gw ? configNameFor(gw) : id;
  if (name && route.params.id !== name) router.replace(`/persona/${name}`);
});
</script>

<template>
  <div class="page-shell">
    <div class="page-header">
      <div>
        <h1 class="page-title">人格配置</h1>
        <div class="page-subtitle">人格可以留空；留空时只使用消息入口默认包装和回传 API。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-btn v-if="hasPersona" prepend-icon="mdi-account-edit-outline" variant="tonal" @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')">打开人格配置</v-btn>
        <v-btn v-if="hasPersona" prepend-icon="mdi-file-code-outline" variant="tonal" @click="store.openConfigFile('role-message-config', gateway.id, gateway.agentRoleId || '')">打开消息模板配置</v-btn>
        <v-btn v-if="hasPersona" prepend-icon="mdi-plus" color="secondary" variant="tonal" @click="store.addRule">新增消息模板规则</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="summary-grid">
        <div class="summary-tile">
          <span>当前人格</span>
          <b data-no-i18n>{{ gateway.agentRoleId || "不注入人格" }}</b>
        </div>
        <div class="summary-tile">
          <span>消息模板</span>
          <b>{{ hasPersona ? `${rules.length} 条规则` : "入口默认" }}</b>
        </div>
        <div class="summary-tile">
          <span>{{ hasPersona ? "角色目录" : "运行模式" }}</span>
          <b :data-no-i18n="hasPersona ? '' : undefined">{{ hasPersona ? roleDirLabel : "无人格直通" }}</b>
        </div>
      </div>

      <div class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格配置</div>
              <div class="section-note">当前路由指向 {{ gateway.agentRoleId || "无人格直通模式" }}。</div>
            </div>
          </div>
          <div class="form-grid">
            <v-select
              :model-value="gateway.agentRoleId || ''"
              :items="roleOptions"
              label="指向人格"
              @update:model-value="value => setRole(String(value || ''))"
            />
            <v-text-field v-if="hasPersona" v-model="gateway.agentRoleFile" label="人格文件名" placeholder="persona.md" @update:model-value="store.touch" />
          </div>
          <template v-if="hasPersona">
            <div class="status-row mt-3"><span>角色目录</span><b data-no-i18n>{{ roleDirLabel }}</b></div>
            <div class="status-row"><span>人格路径</span><b data-no-i18n>{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "-" }}</b></div>
          </template>
          <v-alert v-else class="mt-3" type="info" variant="tonal">
            这条路由不会注入人格、计划或记忆；RabiRoute 只把消息来源、原文和回复 API 包装后投递给 Agent。
          </v-alert>
        </v-card>

        <v-card v-if="hasPersona" class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">persona.md 预览</div>
              <div class="section-note" :data-no-i18n="selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath ? '' : undefined">{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "未读取到人格文件" }}</div>
            </div>
          </div>
          <v-alert v-if="selectedRole?.roleError || runtime.roleInfo?.selectedRoleError" type="error" variant="tonal">
            {{ selectedRole?.roleError || runtime.roleInfo?.selectedRoleError }}
          </v-alert>
          <pre v-else class="mono-box">{{ selectedRole?.roleContent || runtime.roleInfo?.selectedRoleContent || "角色文件为空或尚未刷新。" }}</pre>
        </v-card>
        <v-card v-else class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">默认消息包装</div>
              <div class="section-note">消息命中后会直接进入 Agent，不读取角色文件。</div>
            </div>
          </div>
          <div class="empty-state compact-empty">
            <div>
              <strong>回复必须走 RabiRoute 回传 API</strong>
              <span>Agent 会看到来源、发送者、消息目标和 `/api/agent/replies`，需要发回消息端的文本都应通过该 API 投递。</span>
            </div>
          </div>
        </v-card>
      </div>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">路由变量</div>
            <div class="section-note">变量会在规则匹配前按字面量替换，用于昵称、关键词或项目别名。</div>
          </div>
          <v-btn color="secondary" variant="tonal" prepend-icon="mdi-plus" @click="store.addRouteVariable">新增变量</v-btn>
        </div>
        <div v-if="variableEntries.length === 0" class="empty-state">
          <div>
            <strong>暂无自定义路由变量</strong>
            <span>需要给群名、项目名或关键词做别名时，再新增变量。</span>
          </div>
        </div>
        <div v-else class="form-grid">
          <template v-for="[key, value] in variableEntries" :key="key">
            <v-text-field :model-value="key" label="变量名" @change="updateVariableKey(key, value, $event)" />
            <div class="d-flex ga-2 variable-value-row">
              <v-text-field class="flex-grow-1" :model-value="value" label="变量值" @update:model-value="next => store.updateRouteVariable(key, key, String(next || ''))" />
              <v-btn icon="mdi-delete" color="error" variant="text" @click="store.removeRouteVariable(key)" />
            </div>
          </template>
        </div>
      </v-card>

      <v-card v-if="!hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">默认消息规则</div>
            <div class="section-note">无人格模式按已启用消息入口生成默认命中规则。</div>
          </div>
          <v-chip color="secondary" variant="tonal">入口默认</v-chip>
        </div>
        <div class="rule-list">
          <div v-for="rule in rules" :key="rule.id" class="rule-card">
            <div class="font-weight-bold text-primary" data-no-i18n>{{ rule.name }}</div>
            <div class="section-note">{{ routeKindSummary(rule) }}</div>
          </div>
        </div>
      </v-card>

      <v-card v-if="hasPersona" class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息模板规则</div>
            <div class="section-note">命中消息后，按这些模板包装再发送给 Agent。</div>
          </div>
          <div class="d-flex ga-2 flex-wrap">
            <v-chip v-if="ruleDiagnosticsCount" color="warning" variant="tonal">{{ ruleDiagnosticsCount }} 个待检查项</v-chip>
            <v-chip color="secondary" variant="tonal">{{ rules.length }} 条模板</v-chip>
          </div>
        </div>
        <v-alert v-if="ruleDiagnosticsCount" type="warning" variant="tonal" density="compact" class="mb-3">
          有规则可能无法按预期命中。展开对应规则后可查看具体提示，修正后再保存。
        </v-alert>
        <div v-if="rules.length === 0" class="empty-state">
          <div>
            <strong>暂无消息模板规则</strong>
            <span>新增消息模板规则后，RabiRoute 才知道命中的消息要怎样包装给 Agent。</span>
          </div>
        </div>
        <div v-else class="rule-list">
          <div v-for="(rule, index) in rules" :key="rule.id" class="rule-card">
            <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
              <div class="min-w-0">
                <div class="font-weight-bold text-primary" data-no-i18n>{{ rule.name }}</div>
                <div class="section-note">{{ routeKindSummary(rule) }} · {{ rule.regex ? `匹配：${rule.regex}` : "不限关键词" }}</div>
                <div class="section-note mt-1" :data-no-i18n="rule.template ? '' : undefined">{{ ruleTemplateSnippet(rule) }}</div>
                <div v-if="ruleDiagnostics(rule).length" class="mt-2 d-flex ga-2 flex-wrap">
                  <v-chip
                    v-for="issue in ruleDiagnostics(rule)"
                    :key="issue"
                    size="small"
                    color="warning"
                    variant="tonal"
                  >
                    {{ issue }}
                  </v-chip>
                </div>
                <div v-if="ruleNotes(rule).length" class="mt-2 d-flex ga-2 flex-wrap">
                  <v-chip
                    v-for="note in ruleNotes(rule)"
                    :key="note"
                    size="small"
                    color="secondary"
                    variant="tonal"
                  >
                    {{ note }}
                  </v-chip>
                </div>
              </div>
              <div class="rule-card-actions">
                <v-switch
                  v-if="!isBuiltinRolePanelRule(rule)"
                  :model-value="rule.enabled !== false"
                  :label="rule.enabled !== false ? '启用规则' : '停用规则'"
                  color="success"
                  density="compact"
                  inset
                  hide-details
                  @click.stop
                  @update:model-value="value => store.updateRule(index, { enabled: Boolean(value) })"
                />
                <v-btn size="small" variant="tonal" @click="openRule(index)">编辑</v-btn>
              </div>
            </div>
          </div>
        </div>
      </v-card>

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">可用模板变量</div>
            <div class="section-note">模板中用 `{变量名}` 引用。</div>
          </div>
        </div>
        <div class="template-vars">
          <div v-for="item in templateVars" :key="item.name" class="template-var">
            <code>{ {{ item.name }} }</code>
            <span>{{ item.description }}</span>
          </div>
        </div>
      </v-card>
    </template>

    <v-dialog v-model="ruleDialog" max-width="1080" class="editor-dialog">
      <v-card v-if="activeRule && gateway" class="app-card editor-dialog-card">
        <v-card-title class="d-flex justify-space-between align-center ga-3">
          <div>
            <div class="section-title">规则设置</div>
            <div class="section-note">{{ gateway.agentRoleId || "未指向人格" }} · {{ activeRule.id }}</div>
          </div>
          <div class="rule-dialog-actions">
            <v-switch
              v-if="!isBuiltinRolePanelRule(activeRule)"
              :model-value="activeRule.enabled !== false"
              label="启用规则"
              color="success"
              inset
              hide-details
              @update:model-value="value => patchRule({ enabled: Boolean(value) })"
            />
            <v-btn icon="mdi-close" variant="text" @click="ruleDialog = false" />
          </div>
        </v-card-title>
        <v-card-text>
          <v-alert v-if="activeRuleDiagnostics.length" type="warning" variant="tonal" density="compact" class="mb-3">
            <div v-for="issue in activeRuleDiagnostics" :key="issue">{{ issue }}</div>
          </v-alert>
          <v-alert v-if="activeRuleNotes.length" type="info" variant="tonal" density="compact" class="mb-3">
            <div v-for="note in activeRuleNotes" :key="note">{{ note }}</div>
          </v-alert>
          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleMatchParamsOpen = !ruleMatchParamsOpen">
              <span>
                <strong>规则参数</strong>
                <small>名称、匹配正则和目标群号</small>
              </span>
              <v-icon>{{ ruleMatchParamsOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleMatchParamsOpen" class="fold-section-body">
                <div class="form-grid">
                  <v-text-field :model-value="activeRule.name" label="规则名称" @update:model-value="value => patchRule({ name: String(value || '') })" />
                  <v-text-field :model-value="activeRule.regex" label="消息匹配正则" placeholder="例如：需求|报错|构建失败" @update:model-value="value => patchRule({ regex: String(value || '') })" />
                  <v-text-field
                    v-if="ruleHasGroupRoute(activeRule)"
                    class="full-span"
                    :model-value="activeRule.targetGroupId"
                    label="目标群号"
                    placeholder="留空=不限群"
                    @update:model-value="value => patchRule({ targetGroupId: String(value || '') })"
                  />
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleRouteKindsOpen = !ruleRouteKindsOpen">
              <span>
                <strong>路由类型</strong>
                <small>一条规则可以同时作用于多个管道</small>
              </span>
              <v-icon>{{ ruleRouteKindsOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleRouteKindsOpen" class="fold-section-body">
                <div class="config-toolbar">
                  <v-text-field
                    v-model="routeKindQuery"
                    density="compact"
                    prepend-inner-icon="mdi-magnify"
                    label="搜索路由类型"
                    hide-details
                    clearable
                  />
                  <div class="selected-pill-row">
                    <v-chip size="small" color="secondary" variant="tonal">已选 {{ selectedRouteKindCount }}</v-chip>
                    <v-btn size="small" variant="text" @click="setRouteKinds(activeRule.routeKinds || [], false)">清空</v-btn>
                  </div>
                </div>
                <div class="route-kind-catalog">
                  <section v-for="definition in visibleRouteKindDefinitions" :key="definition.adapter" class="catalog-section">
                    <div class="catalog-section-head">
                      <div>
                        <div class="catalog-section-title">{{ definition.title }}</div>
                        <div class="section-note">{{ definition.note }}</div>
                      </div>
                    </div>
                    <div v-for="group in definition.groups" :key="group.title" class="route-kind-group">
                      <div class="route-kind-group-head">
                        <span>{{ group.title }}</span>
                        <div class="d-flex ga-1">
                          <v-btn size="x-small" variant="text" @click="setRouteKinds(group.routeKinds, true)">全选</v-btn>
                          <v-btn size="x-small" variant="text" @click="setRouteKinds(group.routeKinds, false)">清空</v-btn>
                        </div>
                      </div>
                      <div class="route-kind-chip-grid">
                        <button
                          v-for="kind in group.routeKinds"
                          :key="kind"
                          class="route-kind-chip"
                          :class="{ active: activeRule.routeKinds?.includes(kind) }"
                          type="button"
                          @click="toggleRouteKind(kind, !activeRule.routeKinds?.includes(kind))"
                        >
                          <v-icon size="18">{{ activeRule.routeKinds?.includes(kind) ? "mdi-check-circle" : "mdi-circle-outline" }}</v-icon>
                          <span>{{ routeKindLabels[kind] || kind }}</span>
                          <code>{{ kind }}</code>
                        </button>
                      </div>
                    </div>
                  </section>
                  <div v-if="visibleRouteKindDefinitions.length === 0" class="empty-state compact-empty">
                    <div>
                      <strong>没有匹配的路由类型</strong>
                      <span>清空搜索后可以看到全部类型。</span>
                    </div>
                  </div>
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section v-if="activeRuleHasHeartbeat" class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleSchedulesOpen = !ruleSchedulesOpen">
              <span>
                <strong>定时计划</strong>
                <small>一条 heartbeat 模板规则可以有多个触发计划</small>
              </span>
              <v-icon>{{ ruleSchedulesOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleSchedulesOpen" class="fold-section-body">
                <div class="section-title-row compact-row">
                  <div>
                    <div class="section-title small-title">触发计划</div>
                    <div class="section-note">消息端只负责启用内部定时来源；这里决定什么时候触发这条模板。</div>
                  </div>
                  <v-btn size="small" color="secondary" variant="tonal" prepend-icon="mdi-plus" @click="addSchedule">新增计划</v-btn>
                </div>
                <div v-if="!activeRule.schedules?.length" class="empty-state compact-empty">
                  <div>
                    <strong>暂无定时计划</strong>
                    <span>新增后，这条 heartbeat 模板才会被定时触发。</span>
                  </div>
                </div>
                <div v-else class="rule-list">
                  <div v-for="(schedule, scheduleIndex) in activeRule.schedules" :key="schedule.id" class="rule-card">
                    <div class="d-flex justify-space-between ga-3 align-start flex-wrap">
                      <div class="min-w-0 flex-grow-1">
                        <div class="form-grid">
                          <v-text-field
                            :model-value="schedule.name"
                            label="计划名称"
                            @update:model-value="value => updateSchedule(scheduleIndex, { name: String(value || '') })"
                          />
                          <v-select
                            :model-value="schedule.type"
                            :items="scheduleTypeOptions"
                            label="定时类型"
                            @update:model-value="value => setScheduleType(scheduleIndex, String(value || 'interval'))"
                          />
                          <template v-if="schedule.type === 'interval'">
                            <v-text-field
                              :model-value="schedule.intervalSeconds"
                              type="number"
                              min="1"
                              step="1"
                              label="间隔秒数"
                              @update:model-value="value => updateSchedule(scheduleIndex, { intervalSeconds: Number(value || 900) })"
                            />
                            <v-text-field
                              :model-value="schedule.windowStartTime"
                              label="时间段开始"
                              placeholder="09:30"
                              @update:model-value="value => updateSchedule(scheduleIndex, { windowStartTime: String(value || '') })"
                            />
                            <v-text-field
                              :model-value="schedule.windowEndTime"
                              label="时间段结束"
                              placeholder="19:00"
                              @update:model-value="value => updateSchedule(scheduleIndex, { windowEndTime: String(value || '') })"
                            />
                          </template>
                          <v-text-field
                            v-else-if="schedule.type === 'daily_time'"
                            :model-value="schedule.timeOfDay"
                            label="每天时间"
                            placeholder="09:30"
                            @update:model-value="value => updateSchedule(scheduleIndex, { timeOfDay: String(value || '') })"
                          />
                          <v-text-field
                            v-else
                            :model-value="schedule.onceAt"
                            type="datetime-local"
                            label="指定日期时间"
                            @update:model-value="value => updateSchedule(scheduleIndex, { onceAt: String(value || '') })"
                          />
                        </div>
                      </div>
                      <div class="rule-card-actions">
                        <v-switch
                          :model-value="schedule.enabled !== false"
                          :label="schedule.enabled !== false ? '启用计划' : '停用计划'"
                          color="success"
                          density="compact"
                          inset
                          hide-details
                          @update:model-value="value => updateSchedule(scheduleIndex, { enabled: Boolean(value) })"
                        />
                        <v-btn size="small" color="error" variant="text" @click="removeSchedule(scheduleIndex)">删除</v-btn>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </v-expand-transition>
          </section>

          <section class="fold-section">
            <button class="fold-section-head" type="button" @click="ruleTemplateOpen = !ruleTemplateOpen">
              <span>
                <strong>Agent 消息包装模板</strong>
                <small>命中后发送给 Agent 的正文</small>
              </span>
              <v-icon>{{ ruleTemplateOpen ? "mdi-chevron-up" : "mdi-chevron-down" }}</v-icon>
            </button>
            <v-expand-transition>
              <div v-if="ruleTemplateOpen" class="fold-section-body">
                <v-textarea
                  :model-value="activeRule.template"
                  label="Agent 消息包装模板"
                  rows="14"
                  auto-grow
                  spellcheck="false"
                  @update:model-value="value => patchRule({ template: String(value || '') })"
                />
              </div>
            </v-expand-transition>
          </section>
        </v-card-text>
        <v-card-actions class="px-6 pb-5">
          <v-btn v-if="!isBuiltinRolePanelRule(activeRule)" color="error" variant="text" @click="store.removeRule(activeRuleIndex); ruleDialog = false">删除规则</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="ruleDialog = false">完成</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
