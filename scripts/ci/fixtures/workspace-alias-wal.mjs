import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

export const byteHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function fixtureRead(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    // 仅fixture使用Windows文件映射读取被SQLite锁住的SHM；生产Node adapter不能假称readFile可读全介质。
    const escaped = path.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $stream=[System.IO.FileStream]::new('${escaped}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete); $map=[System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream,[System.Management.Automation.Language.NullString]::Value,0,[System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read,[System.IO.HandleInheritability]::None,$true); $view=$map.CreateViewAccessor(0,0,[System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read); try { $data=[byte[]]::new([int]$stream.Length); [void]$view.ReadArray(0,$data,0,$data.Length); [Console]::Out.Write([Convert]::ToBase64String($data)) } finally { $view.Dispose(); $map.Dispose(); $stream.Dispose() }`;
    const child = spawn(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data.toString();
    });
    child.stderr.on("data", (data) => {
      errors += data.toString();
    });
    const [code] = await once(child, "exit");
    if (code !== 0) throw new Error(`fixture mmap read failed ${code}: ${errors}`);
    return Buffer.from(output, "base64");
  }
}
export async function fileManifest(root) {
  const result = [];
  async function visit(path) {
    const stat = await lstat(path, { bigint: true });
    result.push({
      path,
      identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
      size: String(stat.size),
      mtime: String(stat.mtimeNs),
      ctime: String(stat.ctimeNs),
      hash: stat.isFile() ? byteHash(await fixtureRead(path)) : "directory",
    });
    if (stat.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return result;
}
export async function walFixture(t) {
  const temp = await mkdtemp(join(tmpdir(), "zcodium-alias-wal-"));
  const root = join(temp, ".zcodium");
  await mkdir(root);
  const path = join(root, "fixture.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("CREATE TABLE wal_rows(id INTEGER PRIMARY KEY,value BLOB)");
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  writer.prepare("INSERT INTO wal_rows VALUES(1,?)").run("committed-in-wal");
  t.after(async () => {
    if (writer.isOpen) {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
    await rm(temp, { recursive: true, force: true });
  });
  return {
    temp,
    root,
    path,
    writer,
    commit(id = 2) {
      writer.prepare("INSERT INTO wal_rows VALUES(?,?)").run(id, `committed-${id}`);
    },
    spill() {
      writer.exec("PRAGMA cache_size=4; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
      for (let id = 2; id < 180; id++)
        writer.prepare("INSERT INTO wal_rows VALUES(?,?)").run(id, Buffer.alloc(4096, id));
    },
  };
}
export async function cloneRows(f, includeWal = true) {
  const scratch = join(f.temp, `clone-${randomUUID()}`);
  await mkdir(scratch);
  const target = join(scratch, "fixture.sqlite");
  let db;
  try {
    await copyFile(f.path, target);
    if (includeWal)
      for (const suffix of ["-wal", "-shm"])
        await writeFile(`${target}${suffix}`, await fixtureRead(`${f.path}${suffix}`));
    // 仅测试自己的OS-temp隔离副本可以让SQLite生成SHM/恢复；从不打开原库读连接。
    db = new DatabaseSync(target);
    db.exec("BEGIN");
    return db
      .prepare("SELECT id FROM wal_rows ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    if (db?.isTransaction) db.exec("ROLLBACK");
    db?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
export async function mmapRoundTrip(f, changed) {
  const path = `${f.path}-shm`.replaceAll("'", "''");
  const script = `
$ErrorActionPreference='Stop'
$stream=[System.IO.FileStream]::new('${path}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
$map=[System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($stream,[System.Management.Automation.Language.NullString]::Value,0,[System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite,[System.IO.HandleInheritability]::None,$true)
$view=$map.CreateViewAccessor(0,0,[System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::ReadWrite)
$original=$view.ReadUInt32(116)
try {
  $view.Write([long]116,[uint32]($original -bxor 1)); $view.Flush()
  [Console]::Out.WriteLine('changed'); [Console]::Out.Flush()
  [void][Console]::ReadLine()
} finally {
  $view.Write([long]116,[uint32]$original); $view.Flush()
  $view.Dispose(); $map.Dispose(); $stream.Dispose()
  [Console]::Out.WriteLine('restored'); [Console]::Out.Flush()
}
`;
  const child = spawn(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", (data) => {
    errors += data.toString();
  });
  child.stdin.on("error", () => {});
  const failures = [];
  try {
    const first = await lines.next();
    if (first.value !== "changed") throw new Error(`OS-temp mmap fixture failed: ${errors}`);
    await changed();
  } catch (error) {
    failures.push(error);
  }
  if (!child.stdin.destroyed) child.stdin.end("restore\n");
  try {
    const [code] = await exit;
    if (code !== 0) throw new Error(`OS-temp mmap fixture exited ${code}: ${errors}`);
  } catch (error) {
    failures.push(error);
  }
  try {
    await lines.return();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "OS-temp mmap fixture failed to restore");
}
