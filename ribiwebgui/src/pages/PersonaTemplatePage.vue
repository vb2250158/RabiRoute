<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGatewayStore } from "../stores/gatewayStore";
import type { NotificationRule } from "../types";
import {
  configNameFor,
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
const rules = computed(() => gateway.value ? notificationRulesForGateway(gateway.value) : []);
const activeRule = computed(() => rules.value[activeRuleIndex.value] || null);
const variableEntries = computed(() => Object.entries(gateway.value?.routeVariables || {}));
const roleDirLabel = computed(() => runtime.value.roleInfo?.rolesDir || "./data/roles");
const routeKindQuery = ref("");
const routeKindDefinitions = computed(() => routeKindDefinitionsForGateway(gateway.value || undefined));
const selectedRouteKindCount = computed(() => activeRule.value?.routeKinds?.length || 0);
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
  ruleTemplateOpen.value = true;
  ruleDialog.value = true;
}

function patchRule(patch: Partial<NotificationRule>): void {
  store.updateRule(activeRuleIndex.value, patch);
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

function setRole(value: string): void {
  if (!gateway.value) return;
  gateway.value.agentRoleId = value;
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
        <div class="page-subtitle">选择路由人格，维护变量和 Agent 消息包装模板。</div>
      </div>
      <div class="page-actions" v-if="gateway">
        <v-btn prepend-icon="mdi-account-edit-outline" variant="tonal" @click="store.openConfigFile('role', gateway.id, gateway.agentRoleId || '')">打开人格配置</v-btn>
        <v-btn prepend-icon="mdi-file-code-outline" variant="tonal" @click="store.openConfigFile('role-message-config', gateway.id, gateway.agentRoleId || '')">打开消息模板配置</v-btn>
        <v-btn prepend-icon="mdi-plus" color="secondary" variant="tonal" @click="store.addRule">新增消息模板规则</v-btn>
      </div>
    </div>

    <v-alert v-if="!gateway" type="info" variant="tonal">暂无路由配置，请先新增或完成快速配置。</v-alert>

    <template v-if="gateway">
      <div class="summary-grid">
        <div class="summary-tile">
          <span>当前人格</span>
          <b>{{ gateway.agentRoleId || "不注入人格" }}</b>
        </div>
        <div class="summary-tile">
          <span>消息模板</span>
          <b>{{ rules.length }} 条规则</b>
        </div>
        <div class="summary-tile">
          <span>角色目录</span>
          <b>{{ roleDirLabel }}</b>
        </div>
      </div>

      <div class="two-column">
        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">人格配置</div>
              <div class="section-note">当前路由指向 {{ gateway.agentRoleId || "无人格" }}。</div>
            </div>
          </div>
          <div class="form-grid">
            <v-select
              :model-value="gateway.agentRoleId || ''"
              :items="roleOptions"
              label="指向人格"
              @update:model-value="value => setRole(String(value || ''))"
            />
            <v-text-field v-model="gateway.agentRoleFile" label="人格文件名" placeholder="persona.md" @update:model-value="store.touch" />
          </div>
          <div class="status-row mt-3"><span>角色目录</span><b>{{ roleDirLabel }}</b></div>
          <div class="status-row"><span>人格路径</span><b>{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "-" }}</b></div>
        </v-card>

        <v-card class="app-card glass-card section-card">
          <div class="section-title-row">
            <div>
              <div class="section-title">persona.md 预览</div>
              <div class="section-note">{{ selectedRole?.rolePath || runtime.roleInfo?.selectedRolePath || "未读取到人格文件" }}</div>
            </div>
          </div>
          <v-alert v-if="selectedRole?.roleError || runtime.roleInfo?.selectedRoleError" type="error" variant="tonal">
            {{ selectedRole?.roleError || runtime.roleInfo?.selectedRoleError }}
          </v-alert>
          <pre v-else class="mono-box">{{ selectedRole?.roleContent || runtime.roleInfo?.selectedRoleContent || "角色文件为空或尚未刷新。" }}</pre>
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

      <v-card class="app-card glass-card section-card">
        <div class="section-title-row">
          <div>
            <div class="section-title">消息模板规则</div>
            <div class="section-note">命中消息后，按这些模板包装再发送给 Agent。</div>
          </div>
          <v-chip color="secondary" variant="tonal">{{ rules.length }} 条模板</v-chip>
        </div>
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
                <div class="font-weight-bold text-primary">{{ rule.name }}</div>
                <div class="section-note">{{ routeKindSummary(rule) }} · {{ rule.regex ? `匹配：${rule.regex}` : "不限关键词" }}</div>
                <div class="section-note mt-1">{{ ruleTemplateSnippet(rule) }}</div>
              </div>
              <div class="rule-card-actions">
                <v-switch
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
          <v-btn color="error" variant="text" @click="store.removeRule(activeRuleIndex); ruleDialog = false">删除规则</v-btn>
          <v-spacer />
          <v-btn color="primary" @click="ruleDialog = false">完成</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
