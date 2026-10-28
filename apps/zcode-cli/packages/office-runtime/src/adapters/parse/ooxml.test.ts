import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import JSZip from "jszip";
import { MAX_UNZIPPED_BYTES } from "#office/contract.ts";
import { openPackage } from "#office/adapters/parse/ooxml.ts";

it("rejects declared zip-bomb sizes before expanding an Office part", async () => {
  const archive = new JSZip();
  archive.file("word/document.xml", "synthetic document", { createFolders: false });
  const bytes = await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const buffer = Buffer.from(bytes);
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(MAX_UNZIPPED_BYTES + 1, central + 24);
  await expect(openPackage(buffer, "synthetic.docx")).rejects.toMatchObject({
    code: "file_too_large",
  });
});
it("still reads real synthetic Office packages without IO side effects", async () => {
  const path = new URL("../../../fixtures/report.docx", import.meta.url);
  const archive = await openPackage(new Uint8Array(await readFile(path)), "report.docx");
  expect(await archive.text("word/document.xml")).toContain("Quarterly Report");
});
