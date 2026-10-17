const packed = [
  "file\tsrc/alpha.ts",
  "file\tsrc/beta.ts",
  "file\tsrc/中文\\talpha.ts",
  ...Array.from({ length: 10_000 }, (_, index) => `file\tother/item-${index}.txt`),
].join("\n");
const services = {
  fileService: {
    listWorkspaceFilesLength: async () => packed.length,
    listWorkspaceFilesRange: async ({ offset, length }: { offset: number; length: number }) =>
      packed.slice(offset, offset + length),
  },
};
export function useWorkspaceServices() {
  return services;
}
