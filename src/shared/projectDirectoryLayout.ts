import path from "node:path";

export type ProjectDirectoryLayout = {
  projectRoot: string;
  privateDataRoot: string;
  routeDataRoot: string;
  personaDataRoot: string;
  runtimeStateRoot: string;
  runtimeImportRoot: string;
  performanceLogRoot: string;
  logRoot: string;
  managerLogRoot: string;
  publicExampleDataRoot: string;
};

export function projectDirectoryLayout(rootDir: string): ProjectDirectoryLayout {
  const projectRoot = path.resolve(rootDir);
  const privateDataRoot = path.join(projectRoot, "data");
  const runtimeStateRoot = path.join(privateDataRoot, ".runtime");
  const logRoot = path.join(projectRoot, "logs");
  return {
    projectRoot,
    privateDataRoot,
    routeDataRoot: path.join(privateDataRoot, "route"),
    personaDataRoot: path.join(privateDataRoot, "roles"),
    runtimeStateRoot,
    runtimeImportRoot: path.join(runtimeStateRoot, "imports"),
    performanceLogRoot: path.join(runtimeStateRoot, "performance"),
    logRoot,
    managerLogRoot: path.join(logRoot, "manager"),
    publicExampleDataRoot: path.join(projectRoot, "examples", "data")
  };
}
