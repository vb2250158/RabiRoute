import fs from "node:fs/promises";
import {definePlugin,ownAgentAdapter,parseAgentAdapterPackageDescriptor} from "@rabiroute/plugin-sdk";
import {createImplementation,hostModules} from "./runtime.mjs";
export const activate=definePlugin({async activate(context){
  const descriptor=parseAgentAdapterPackageDescriptor(JSON.parse(await fs.readFile(new URL("./agent-adapter.json",import.meta.url),"utf8")));
  const service=context.services.require("host.agent-adapters@1");
  const host=service.forActivation?.(context.config)??service;
  await host.prepareModules(hostModules);
  const implementation=createImplementation(host);
  const owned=implementation.createAgentOperations();
  let disposal;
  const disposeOnce=()=>disposal??=Promise.resolve().then(()=>owned.dispose?.());
  try {
    ownAgentAdapter(context,{...descriptor,operations:owned.operations,serviceEndpoint:{configuredSession(){
      const fields=descriptor.sessionBinding;
      if(!fields.sessionId||!fields.workspace||!hostModules.includes("config"))return undefined;
      const configuration=host.module("config").config;
      const sessionId=configuration[fields.sessionId],workspace=configuration[fields.workspace];
      const sessionName=configuration[fields.sessionName]||fields.defaultName;
      return sessionId&&sessionName&&workspace?{agentAdapter:descriptor.type,sessionId,sessionName,workspace}:undefined;
    }},dispose:disposeOnce});
  } catch(error) {
    try { await disposeOnce(); } catch(cleanup) { throw new AggregateError([error,cleanup],"Agent activation and cleanup failed."); }
    throw error;
  }
}}).activate;
