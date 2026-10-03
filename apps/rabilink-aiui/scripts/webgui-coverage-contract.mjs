// Explicit product boundary, not a Relay permission list.
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const rows = [];
const add = (endpoint, methods, classification, owner, mode, evidence = '') => rows.push({ endpoint, methods, classification, owner, mode, evidence, pathKind: endpoint.includes(':dynamic') ? 'dynamic-prefix-not-complete-endpoint' : 'endpoint-pattern' });
for (const endpoint of ['/gateways','/manager-config','/meta','/network-options','/api/gateways','/api/scan/agents','/api/scan/message-adapters','/api/agent/copilot-status','/api/remote-agent/devices']) add(endpoint, ['GET'], 'required', 'PC', 'legacy-configuration');
for (const endpoint of ['/gateways','/manager-config','/reload','/open-config-file','/gateways/:param/start','/gateways/:param/stop','/gateways/:param/restart','/gateways/:param/delete','/gateways/:param/manual-trigger','/api/message/napcat-health','/api/message/napcat-configure-onebot','/api/message/napcat-repair-all','/api/message/napcat-add','/api/message/napcat-launch','/api/message/napcat-restart','/api/message/napcat-remove','/api/agent/copilot-install','/api/agent/copilot-login','/api/agent/marvis-open','/api/agent/astrbot-login-test','/api/remote-agent/scan','/api/remote-agent/connect','/api/remote-agent/disconnect']) add(endpoint, ['POST'], 'required', 'PC', 'legacy-configuration');
add('/api/rabi/identity', ['PATCH'], 'required', 'PC', 'legacy-configuration');
add('/api/rabi/identity', ['GET', 'PATCH'], 'pc-helper', 'PC', 'authenticated-local-knowledge-settings', 'PC management UI is not an additional generic device grant; existing PATCH permission is independently audited.');
add('/gateways/:param/:param', ['POST'], 'dynamic-prefix', 'PC', 'legacy-configuration', 'Only the individually required gateway actions are allowed; this is not a full endpoint.');
add('/gateways/:param/weixin-login', METHODS, 'unsupported', 'PC', 'pc-only');
add('/gateways/:param/agent-delivery-test', METHODS, 'unsupported', 'PC', 'pc-only');
for (const endpoint of [
'/api/agent/threads','/api/role-panel/messages','/api/roles/:param/plans/:param/feedback','/api/message/napcat-ensure-ready','/api/speech/asr','/api/speech/tts',
'/api/agent-adapters/hooks/update','/api/lan-agent/enrollments','/api/lan-agent/instances','/api/lan-agent/instances/:param/agents','/api/lan-agent/instances/:param/agents/:param/authorization','/api/lan-agent/nodes','/api/lan-agent/nodes/:param/update','/api/message/napcat-login-action','/api/message/napcat-login-panel','/api/scan/agents/dsh',
'/api/agent/xiaomi-home/auth','/api/agent/xiaomi-home/auth/refresh','/api/agent/xiaomi-home/deployment:dynamic','/api/agent/xiaomi-home/resources','/api/agent/xiaomi-home/settings','/api/desktop-pet/roles/:param','/api/desktop-pet/roles/:param/packs','/api/desktop-pet/roles/:param/packs/import','/api/desktop/settings','/api/message-processing/board','/api/performance/batches','/api/performance/config','/api/performance/logs','/api/plugins/catalog','/api/plugins/modules:dynamic','/api/resource-cache/settings','/api/video:dynamic','/api/webgui-access',
'/api/roles/:param/all-day-recording','/api/roles/:param/all-day-recording/settings','/api/roles/:param/chat-history','/api/roles/:param/persona-document']) add(endpoint, METHODS, 'unsupported', 'PC', 'pc-only');
add('/api/roles/:param/plan-marker-statuses', METHODS, 'dedicated', 'PC', 'device-knowledge', 'plan_statuses');
add('/api/rabilink/peer/:dynamic', METHODS, 'dynamic-prefix', 'PC', 'peer-authorization', 'Prefix is not a complete endpoint or generic permission');
for (const endpoint of ['/api/roles/:param/skills','/api/roles/:param/skills/:param']) add(endpoint, ['GET'], 'pc-helper', 'PC', 'role-skill-browser', 'ribiwebgui/tests/roleSkillClient.test.ts');
for (const [endpoint, methods, mode, evidence] of [
['/api/rabilink/device/agent-profile',['GET'],'device-profile','scripts/rabilink-agent-profile-http.test.mjs'],
['/api/rabilink/device/agent-profile/applied',['POST'],'device-profile','scripts/rabilink-agent-profile-http.test.mjs'],
['/api/rabilink/device/knowledge',['POST'],'device-knowledge','scripts/rabilink-knowledge-e2e.test.ts'],
['/manage/api/apps/:param/devices/:param/agent-profile',['GET','PUT'],'owner-profile','scripts/rabilink-agent-profile-http.test.mjs'],
]) add(endpoint, methods, 'dedicated', 'Relay', mode, evidence);
export const contracts = Object.freeze(rows);
