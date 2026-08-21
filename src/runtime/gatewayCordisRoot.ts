import {
  createRabiCordisRoot,
  type RabiCordisInitializer,
  type RabiCordisRoot
} from "./cordisRoot.js";

export type GatewayCordisInitializer<T> = RabiCordisInitializer<T>;
export type GatewayCordisRoot = RabiCordisRoot;

export function createGatewayCordisRoot(): GatewayCordisRoot {
  return createRabiCordisRoot("Gateway");
}

let builtinGatewayCordisRoot: GatewayCordisRoot | undefined;

export function getBuiltinGatewayCordisRoot(): GatewayCordisRoot {
  if (!builtinGatewayCordisRoot || builtinGatewayCordisRoot.disposed) {
    builtinGatewayCordisRoot = createGatewayCordisRoot();
  }
  return builtinGatewayCordisRoot;
}
