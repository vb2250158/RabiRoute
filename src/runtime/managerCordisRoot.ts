import {
  createRabiCordisRoot,
  type RabiCordisInitializer,
  type RabiCordisRoot
} from "./cordisRoot.js";

export type ManagerCordisInitializer<T> = RabiCordisInitializer<T>;
export type ManagerCordisRoot = RabiCordisRoot;

export function createManagerCordisRoot(): ManagerCordisRoot {
  return createRabiCordisRoot("Manager");
}

let builtinManagerCordisRoot: ManagerCordisRoot | undefined;

export function getBuiltinManagerCordisRoot(): ManagerCordisRoot {
  if (!builtinManagerCordisRoot || builtinManagerCordisRoot.disposed) {
    builtinManagerCordisRoot = createManagerCordisRoot();
  }
  return builtinManagerCordisRoot;
}
