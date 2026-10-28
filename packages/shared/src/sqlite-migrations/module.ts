export const sqliteMigrationsModule = {
  id: "sqlite-migrations",
  requires: [],
  provides: ["sqlite-migrations"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
