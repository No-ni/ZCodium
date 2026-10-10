import { readFile, writeFile } from "node:fs/promises";
import { SSHHostKeyStore } from "../sshKnownHosts.js";

const [filePath, targetsFile, resultFile] = process.argv.slice(2);
if (!filePath || !targetsFile || !resultFile) throw new Error("Missing worker paths");
const targets = JSON.parse(await readFile(targetsFile, "utf8"));
const store = new SSHHostKeyStore({ filePath });
const verdicts = [];
for (const { target, fingerprint } of targets)
  verdicts.push(await store.verify(target, fingerprint));
await writeFile(resultFile, JSON.stringify(verdicts));
