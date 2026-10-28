import { DatabaseSync } from "node:sqlite";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const normalize = (sql: string) => JSON.stringify(sqlTokens(sql));

// CHECK 中的括号/字符串不是 SQL 结构；归一化关键字不能改变字面量大小写。
function sqlTokens(sql: string): string[] {
  return (
    sql.match(
      /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|\d+(?:\.\d+)?|[^\s]/g,
    ) ?? []
  )
    .filter((token) => !token.startsWith("--") && !token.startsWith("/*"))
    .map((token) => (/^[a-zA-Z_]/.test(token) ? token.toLowerCase() : token));
}

export function tableDeclaration(sql: string) {
  const tokens = sqlTokens(sql);
  const start = tokens.indexOf("(");
  if (start < 0) throw new Error("Unsupported SQLite table declaration");
  const segments: string[][] = [];
  let segment: string[] = [];
  let depth = 1;
  let end = start;
  for (let index = start + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "(") depth++;
    if (token === ")") depth--;
    if (!depth) {
      segments.push(segment);
      end = index;
      break;
    }
    if (token === "," && depth === 1) {
      segments.push(segment);
      segment = [];
    } else segment.push(token);
  }
  if (depth) throw new Error("Unsupported SQLite table declaration");
  const columns = new Map<string, string>();
  const constraints: string[] = [];
  for (const part of segments) {
    if (["constraint", "primary", "unique", "check", "foreign"].includes(part[0] ?? ""))
      constraints.push(JSON.stringify(part));
    else {
      const name = part[0] ?? "";
      const unquoted = name.startsWith('"')
        ? name.slice(1, -1).replaceAll('""', '"')
        : name.startsWith("`")
          ? name.slice(1, -1).replaceAll("``", "`")
          : name.startsWith("[")
            ? name.slice(1, -1)
            : name.startsWith("'")
              ? name.slice(1, -1).replaceAll("''", "'")
              : name;
      columns.set(unquoted.toLowerCase(), JSON.stringify(part.slice(1)));
    }
  }
  return {
    columns,
    constraints: constraints.sort(),
    suffix: JSON.stringify(tokens.slice(end + 1)),
  };
}

function checks(sql: string): string[] {
  const tokens = sqlTokens(sql);
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== "check" || tokens[index + 1] !== "(") continue;
    const start = ++index;
    let depth = 0;
    do {
      if (tokens[index] === "(") depth++;
      if (tokens[index] === ")") depth--;
      index++;
    } while (index < tokens.length && depth > 0);
    result.push(JSON.stringify(tokens.slice(start, index)));
    index--;
  }
  return result.sort();
}

function keys(db: DatabaseSync, table: string, origin: "pk" | "u"): string[] {
  return db
    .prepare(`PRAGMA index_list(${quote(table)})`)
    .all()
    .filter((index) => index.origin === origin)
    .map((index) =>
      JSON.stringify(
        db
          .prepare(`PRAGMA index_xinfo(${quote(String(index.name))})`)
          .all()
          .filter((column) => column.key)
          .map(({ name, desc, coll }) => ({ name, desc, coll })),
      ),
    )
    .sort();
}

function foreignKeys(db: DatabaseSync, table: string): string[] {
  const groups = new Map<number, unknown[]>();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()) {
    const id = Number(row.id);
    const group = groups.get(id) ?? [];
    group.push({
      seq: row.seq,
      table: row.table,
      from: row.from,
      to: row.to,
      on_update: row.on_update,
      on_delete: row.on_delete,
      match: row.match,
    });
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => JSON.stringify(group)).sort();
}

export function dumpSqliteSchema(db: DatabaseSync): string {
  return (
    db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,name",
      )
      .all()
      .map((object) => `${object.sql};`)
      .join("\n\n") + "\n"
  );
}

/** 审查只增 schema；冻结历史重建迁移不调用此守卫，恢复另做严格 schema 相等校验。 */
export function assertAdditiveSchema(beforeSql: string, afterSql: string): void {
  const before = new DatabaseSync(":memory:");
  const after = new DatabaseSync(":memory:");
  try {
    before.exec(beforeSql);
    after.exec(afterSql);
    const oldTables = before
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    for (const table of oldTables) {
      const name = String(table.name);
      const nextTable = after
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
        .get(name);
      if (!nextTable) throw new Error(`Removed table: ${name}`);
      const oldSql = String(table.sql);
      const newSql = String(nextTable.sql);
      const oldDeclaration = tableDeclaration(oldSql);
      const newDeclaration = tableDeclaration(newSql);
      const oldOptions = before
        .prepare("PRAGMA table_list")
        .all()
        .find((row) => row.schema === "main" && row.name === name);
      const newOptions = after
        .prepare("PRAGMA table_list")
        .all()
        .find((row) => row.schema === "main" && row.name === name);
      if (
        oldOptions?.wr !== newOptions?.wr ||
        oldOptions?.strict !== newOptions?.strict ||
        oldOptions?.type !== newOptions?.type ||
        oldDeclaration.suffix !== newDeclaration.suffix
      )
        throw new Error(`Changed table options: ${name}`);
      if (
        JSON.stringify(oldDeclaration.constraints) !== JSON.stringify(newDeclaration.constraints) ||
        JSON.stringify(checks(oldSql)) !== JSON.stringify(checks(newSql))
      )
        throw new Error(`Changed table constraints: ${name}`);
      for (const origin of ["pk", "u"] as const)
        if (
          JSON.stringify(keys(before, name, origin)) !== JSON.stringify(keys(after, name, origin))
        )
          throw new Error(`Changed primary/unique key: ${name}`);
      const oldColumns = before.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      const newColumns = after.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
      for (const column of oldColumns) {
        const next = newColumns.find((value) => value.name === column.name);
        if (!next) throw new Error(`Removed column: ${name}.${column.name}`);
        for (const field of ["cid", "type", "notnull", "dflt_value", "pk", "hidden"])
          if (column[field] !== next[field])
            throw new Error(`Changed column contract: ${name}.${column.name}.${field}`);
        const key = String(column.name).toLowerCase();
        if (oldDeclaration.columns.get(key) !== newDeclaration.columns.get(key))
          throw new Error(`Changed column declaration: ${name}.${column.name}`);
      }
      for (const column of newColumns) {
        if (
          !oldColumns.some((value) => value.name === column.name) &&
          column.notnull &&
          (column.dflt_value == null || /^\(*\s*null\s*\)*$/i.test(String(column.dflt_value)))
        )
          throw new Error(`New required column has no non-null default: ${name}.${column.name}`);
      }
      // 逐行匹配无法区分复合 FK 被拆分；必须保留完整分组、seq 和动作契约。
      if (JSON.stringify(foreignKeys(before, name)) !== JSON.stringify(foreignKeys(after, name)))
        throw new Error(`Changed foreign key: ${name}`);
    }
    for (const object of before
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE type IN ('index','trigger','view') AND sql IS NOT NULL",
      )
      .all()) {
      const next = after
        .prepare("SELECT type,sql FROM sqlite_schema WHERE name=?")
        .get(object.name!);
      if (
        !next ||
        next.type !== object.type ||
        normalize(String(next.sql)) !== normalize(String(object.sql))
      )
        throw new Error(`Removed or changed index/trigger/view: ${object.name}`);
    }
  } finally {
    before.close();
    after.close();
  }
}
