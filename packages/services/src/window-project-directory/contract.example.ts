import type { WindowProjectDirectoryServices } from "./contract.js";

export async function readWindowDirectory(directory: WindowProjectDirectoryServices) {
  const capability = await directory.changesService.getCapabilities();
  if (capability.version !== 1) throw new Error("Unsupported Window directory");
  return directory.projectService.readDirectory();
}
