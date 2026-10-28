import type { SqliteMigration } from "./contract.js";
export const exampleMigration: SqliteMigration = {
  id: "0001_example",
  appVersion: "3.16.2",
  touchedTables: ["example"],
  sql: "CREATE TABLE example(id TEXT PRIMARY KEY)",
};
