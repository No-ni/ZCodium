const requests: { rootPath: string; offset: number; release: (value: string) => void }[] = [];
const lengths: string[] = [];
const service = {
  listWorkspaceFilesLength: async ({ rootPath }: { rootPath: string }) => {
    lengths.push(rootPath);
    return 12_000_000;
  },
  listWorkspaceFilesRange: ({ rootPath, offset }: { rootPath: string; offset: number }) =>
    new Promise<string>((release) => {
      requests.push({ rootPath, offset, release });
    }),
};
Object.assign(window, {
  fileFetchFixture: {
    pending: () => requests.map(({ rootPath, offset }) => ({ rootPath, offset })),
    lengths: () => [...lengths],
    complete(index: number, value: string) {
      requests[index]?.release(value);
    },
  },
});
export function useWorkspaceServices() {
  return { fileService: service };
}
