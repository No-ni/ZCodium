import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensureIngressToken(runDir: string): Promise<string> {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const destination = join(runDir, "ingress-token");
  const read = async () => {
    const details = await lstat(destination);
    if (!details.isFile() || details.isSymbolicLink())
      throw new Error("Invalid Source ingress token file");
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0)
      throw new Error("Source ingress token file is not private");
    const token = (await readFile(destination, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid Source ingress token");
    return token;
  };
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const staging = join(runDir, `.ingress-token-${randomBytes(16).toString("hex")}`);
  try {
    await writeFile(staging, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(staging, destination);
    } catch (error) {
      // 直接 wx 写目标会让并发读取看到半个 token；完整私有文件以独占 link 原子发布。
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return await read();
  } finally {
    await unlink(staging);
  }
}
