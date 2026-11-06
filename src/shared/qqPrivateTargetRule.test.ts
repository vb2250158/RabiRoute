import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeRuleDefinitions, normalizePersonaAutomationRules, personaAutomationRulesFromNotificationRules,
  notificationRulesFromPersonaAutomations } from "./gatewayConfigModel.js";
import { roleConfigurationOf } from "./roleConfiguration.js";

test("QQ private target survives role-owned notification/automation normalization and projections", () => {
  const rules = normalizeRuleDefinitions([{ id: "selected-peer", routeKinds: ["private"], targetUserId: " 20001 ", template: "original" }])!;
  assert.equal(rules[0].targetUserId, "20001");
  const automations = normalizePersonaAutomationRules(personaAutomationRulesFromNotificationRules(rules));
  assert.equal(automations[0].trigger.type === "message" ? automations[0].trigger.targetUserId : undefined, "20001");
  assert.equal(notificationRulesFromPersonaAutomations(automations)[0].targetUserId, "20001");
  const owned = roleConfigurationOf({ automationRules: automations });
  assert.deepEqual(owned.automationRules, automations);
  assert.equal(normalizeRuleDefinitions([{ id: "unrestricted" }])![0].targetUserId, "");
});

test("Gateway environment parser retains the exact private peer in global and Route profile rules", () => {
  const rules = [{ id: "selected-peer", routeKinds: ["private"], targetUserId: " 20001 ", template: "original" }];
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "const {config}=await import('./src/config.ts');console.log(JSON.stringify({target:config.notificationRules[0]?.targetUserId,profileTarget:config.routeProfiles[0]?.notificationRules[0]?.targetUserId}));"
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env: { ...process.env, AUTOMATION_RULES: "[]",
    NOTIFICATION_RULES: JSON.stringify(rules), ROUTE_PROFILES: JSON.stringify([{ id: "main", notificationRules: rules }]) },
    encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(output.trim()), { target: "20001", profileTarget: "20001" });
});

test('extension candidate retains only supplied extensions while known optional normalization stays unchanged',()=>{
 const rule=normalizeRuleDefinitions([{id:'original',privateRule:{retained:true},recentMessageLimit:null,sourceRouteIds:null,triggerIds:null,targetUserId:' 20001 ',schedules:[{id:'clock',type:'interval',intervalSeconds:120,skipWhenAgentBusy:'invalid',privateSchedule:{retained:true}}]}])![0] as any;
 assert.deepEqual(rule.privateRule,{retained:true});assert.equal(rule.targetUserId,'20001');assert.equal(Object.hasOwn(rule,'recentMessageLimit'),false);assert.equal(Object.hasOwn(rule,'sourceRouteIds'),false);assert.equal(Object.hasOwn(rule,'triggerIds'),false);assert.deepEqual(rule.schedules[0].privateSchedule,{retained:true});assert.equal(Object.hasOwn(rule.schedules[0],'skipWhenAgentBusy'),false);assert.equal(rule.schedules[0].intervalSeconds,120);
 const automated=normalizePersonaAutomationRules([{id:' original ',sourceRouteIds:null,privateRule:{retained:true},trigger:{type:'message',triggerIds:'invalid',targetUserId:' 20001 ',privateTrigger:{retained:true}},action:{type:'deliver_agent',target:{kind:'recipient',recipientId:' primary '},recentMessageLimit:null,privateAction:{retained:true}}}])[0] as any;
 assert.equal(automated.id,'original');assert.equal(Object.hasOwn(automated,'sourceRouteIds'),false);assert.equal(Object.hasOwn(automated.trigger,'triggerIds'),false);assert.equal(Object.hasOwn(automated.action,'recentMessageLimit'),false);assert.deepEqual(automated.action.target,{kind:'recipient',recipientId:'primary'});assert.deepEqual(automated.privateRule,{retained:true});assert.deepEqual(automated.trigger.privateTrigger,{retained:true});assert.deepEqual(automated.action.privateAction,{retained:true});
 const original=JSON.parse('{"id":"text","__proto__":{"polluted":true}}');const normalized=normalizeRuleDefinitions([original])![0];assert.equal(Object.getPrototypeOf(normalized),Object.prototype);assert.equal(Object.hasOwn(normalized,'__proto__'),true);assert.equal(({} as any).polluted,undefined);
});


test('known fields from another action/trigger branch are not preserved as extensions or revived by a type-only edit',()=>{
 const run=normalizePersonaAutomationRules([{id:'r',trigger:{type:'message',schedule:{id:'retired-clock',type:'interval',intervalSeconds:60},privateTrigger:{retained:true}},action:{type:'run_script',scriptPath:'current.js',target:{kind:'recipient',recipientId:'retired'},message:'retired',template:'retired',privateAction:{retained:true}}}])[0] as any;
 assert.equal(Object.hasOwn(run.trigger,'schedule'),false);assert.equal(Object.hasOwn(run.action,'target'),false);assert.equal(Object.hasOwn(run.action,'message'),false);assert.equal(Object.hasOwn(run.action,'template'),false);
 const scheduled=normalizePersonaAutomationRules([{...run,trigger:{...run.trigger,type:'schedule',routeKinds:['private'],targetUserId:'20001',regex:'retired'},action:{...run.action,type:'deliver_agent'}}])[0] as any;
 assert.equal(scheduled.action.target,undefined);assert.equal(Object.hasOwn(scheduled.action,'scriptPath'),false);assert.equal(Object.hasOwn(scheduled.action,'arguments'),false);assert.equal(Object.hasOwn(scheduled.action,'timeoutSeconds'),false);assert.equal(Object.hasOwn(scheduled.trigger,'routeKinds'),false);assert.equal(Object.hasOwn(scheduled.trigger,'targetUserId'),false);assert.equal(Object.hasOwn(scheduled.trigger,'regex'),false);assert.equal(scheduled.trigger.schedule.intervalSeconds,900);
 assert.deepEqual(scheduled.action.privateAction,{retained:true});assert.deepEqual(scheduled.trigger.privateTrigger,{retained:true});
 const switchedBack=normalizePersonaAutomationRules([{...scheduled,trigger:{...scheduled.trigger,type:'message'},action:{...scheduled.action,type:'run_script'}}])[0] as any;
 assert.equal(Object.hasOwn(switchedBack.trigger,'schedule'),false);assert.equal(switchedBack.action.scriptPath,'');assert.deepEqual(switchedBack.action.arguments,[]);assert.equal(switchedBack.action.timeoutSeconds,300);
});
