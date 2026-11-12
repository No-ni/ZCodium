// 固定源码的纯内核依赖；只写本工作树，不执行第三方构建脚本。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, inflateRawSync } from "node:zlib";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT = "dc041dd1ab1a014efa352ba47a6f31fc47f55284";
const VERSION = "0.0.195";
const CACHE = join(ROOT, ".tmp", "native-context-kernel", COMMIT);
const SOURCE = join(CACHE, "source");
const PACKAGE = join(CACHE, "kernel-entry-package");
const OUTPUT = join(ROOT, "vendor", "acp-kernel-" + VERSION + ".tgz");
const ZIP = join(CACHE, "upstream.zip");
const ZIP_URL = "https://codeload.github.com/ranxianglei/billion-context/zip/" + COMMIT;
const LICENSE_URL =
  "https://github.com/ranxianglei/billion-context/blob/" + COMMIT + "/kernel/LICENSE";
const SOURCE_URL = "https://github.com/ranxianglei/billion-context/tree/" + COMMIT + "/kernel";

async function checkPath(path) {
  const rel = relative(ROOT, resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("VENDOR_PATH_OUTSIDE_WORKTREE");
  let cursor = ROOT;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("VENDOR_REPARSE_PATH");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function write(path, data) {
  await checkPath(path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const processHandle = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: "inherit",
      env: { ...process.env, TMPDIR: CACHE, TMP: CACHE, TEMP: CACHE },
    });
    processHandle.on("error", reject);
    processHandle.on("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error("VENDOR_COMMAND_FAILED_" + code)),
    );
  });
}

function zipFiles(bytes) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("VENDOR_INVALID_ZIP");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("VENDOR_INVALID_ZIP_ENTRY");
    const length = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + length).toString("utf8");
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const rawSize = bytes.readUInt32LE(cursor + 24);
    const method = bytes.readUInt16LE(cursor + 10);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    cursor += 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const marker = name.indexOf("/kernel/");
    if (marker < 0 || name.endsWith("/")) continue;
    const path = name.slice(marker + "/kernel/".length);
    if (
      !path ||
      path.includes("\\") ||
      path.split("/").includes("..") ||
      isAbsolute(path) ||
      win32.isAbsolute(path) ||
      ((externalAttributes >>> 16) & 0o170000) === 0o120000
    )
      throw new Error("VENDOR_UNSAFE_ARCHIVE_PATH");
    if (
      !(path.startsWith("src/") && path.endsWith(".ts")) &&
      !["package.json", "LICENSE", "README.md", "PROVENANCE.md"].includes(path)
    )
      continue;
    if (rawSize > 5 * 1024 * 1024 || bytes.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("VENDOR_INVALID_ARCHIVE_SIZE");
    const start =
      localOffset +
      30 +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(start, start + compressedSize);
    const content =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: rawSize + 1 })
          : null;
    if (!content || content.length !== rawSize) throw new Error("VENDOR_INVALID_ARCHIVE_CONTENT");
    files.push({ path, content });
  }
  return files;
}

function tarEntry(path, data) {
  const header = Buffer.alloc(512);
  const name = "package/" + path;
  if (Buffer.byteLength(name) > 100) throw new Error("VENDOR_TAR_NAME_TOO_LONG");
  header.write(name);
  const octal = (offset, length, value) =>
    header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, data.length);
  octal(136, 12, 0);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}

async function collect(directory, prefix = "") {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    await checkPath(path);
    if (item.isDirectory()) files.push(...(await collect(path, prefix + item.name + "/")));
    else if (item.isFile()) files.push({ path: prefix + item.name, content: await readFile(path) });
    else throw new Error("VENDOR_NON_REGULAR_FILE");
  }
  return files;
}

await checkPath(CACHE);
await mkdir(CACHE, { recursive: true });
try {
  await lstat(ZIP);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await run(process.platform === "win32" ? "curl.exe" : "curl", [
    "-fsSL",
    "--max-time",
    "300",
    "--output",
    ZIP,
    ZIP_URL,
  ]);
}
let extracted;
try {
  extracted = zipFiles(await readFile(ZIP));
} catch {
  await run(process.platform === "win32" ? "curl.exe" : "curl", [
    "-fsSL",
    "--max-time",
    "300",
    "--output",
    ZIP,
    ZIP_URL,
  ]);
  extracted = zipFiles(await readFile(ZIP));
}
for (const file of extracted) await write(join(SOURCE, file.path), file.content);
const upstreamPackage = JSON.parse(await readFile(join(SOURCE, "package.json"), "utf8"));
if (
  upstreamPackage.name !== "acp-kernel" ||
  upstreamPackage.version !== VERSION ||
  upstreamPackage.dependencies
)
  throw new Error("VENDOR_UPSTREAM_CONTRACT_CHANGED");
const tokenizerPath = join(SOURCE, "src", "tokenize.ts");
const tokenizer = await readFile(tokenizerPath, "utf8");
const originalRequire = "const require = createRequire(import.meta.url);";
if (tokenizer.split(originalRequire).length !== 2)
  throw new Error("VENDOR_TOKENIZER_COMPATIBILITY_PATCH_CHANGED");
// 桌面 CLI 编译为 CJS 后 import.meta.url 为空，会在 storage 握手前崩溃；
// 只修模块加载锚点，ESM 仍用原 URL，计量公式与可选 BPE fallback 不变。
await write(
  tokenizerPath,
  tokenizer.replace(
    originalRequire,
    'const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);',
  ),
);
await write(
  join(PACKAGE, "package.json"),
  JSON.stringify(
    {
      name: "acp-kernel",
      version: VERSION,
      type: "module",
      license: "MIT",
      author: upstreamPackage.author,
      repository: upstreamPackage.repository,
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      sideEffects: false,
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    },
    null,
    2,
  ) + "\n",
);
await write(join(PACKAGE, "LICENSE"), await readFile(join(SOURCE, "LICENSE")));
await write(join(PACKAGE, "README.md"), await readFile(join(SOURCE, "README.md")));
await write(
  join(PACKAGE, "PROVENANCE.md"),
  "Source: " +
    SOURCE_URL +
    "\nCommit: " +
    COMMIT +
    "\nLicense: " +
    LICENSE_URL +
    "\n" +
    "ZCodium bundles the kernel library entry with one compatibility patch: tokenizer createRequire uses __filename in CommonJS and import.meta.url in ESM. Token estimates and optional BPE fallback are unchanged. The integration uses candidate primitives; no host, proxy, panel or external storage service is bundled.\n" +
    "Rebuild: node scripts/vendor-native-context-kernel.mjs (root locked TypeScript/esbuild).\n",
);
await build({
  entryPoints: [join(SOURCE, "src", "index.ts")],
  outfile: join(PACKAGE, "dist", "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: false,
  legalComments: "inline",
  logLevel: "warning",
});
await write(
  join(CACHE, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2023", "DOM"],
        declaration: true,
        emitDeclarationOnly: true,
        skipLibCheck: true,
        strict: true,
        types: ["node"],
        rootDir: join(SOURCE, "src"),
        outDir: join(PACKAGE, "dist"),
      },
      // 仅生成库入口可达声明；wire/persist 不属于本次内核依赖。
      files: [join(SOURCE, "src", "index.ts")],
    },
    null,
    2,
  ),
);
await run(process.execPath, [
  join(ROOT, "node_modules", "typescript", "bin", "tsc"),
  "--project",
  join(CACHE, "tsconfig.json"),
]);
const files = (await collect(PACKAGE)).sort((a, b) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
);
const archive = gzipSync(
  Buffer.concat([
    ...files.flatMap((file) => tarEntry(file.path, file.content)),
    Buffer.alloc(1024),
  ]),
  { level: 9 },
);
await write(OUTPUT, archive);
const digest = createHash("sha512").update(archive).digest("base64");
await write(OUTPUT + ".integrity", "sha512-" + digest + "\n");
console.log(
  "acp-kernel " +
    VERSION +
    ", " +
    files.length +
    " files, " +
    archive.length +
    " bytes; sha512-" +
    digest,
);
