import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRemotePromptAttachmentTransferService } from "../../../packages/desktop/src/host/promptAttachmentTransferService.ts";

function fixture() {
  const commands = [],
    uploads = [];
  const service = createRemotePromptAttachmentTransferService({
    async exec(command) {
      commands.push(command);
      const stdout = new EventEmitter(),
        stderr = new EventEmitter();
      return {
        stdout,
        stderr,
        onClose(listener) {
          queueMicrotask(() => {
            if (command.includes('printf %s "$HOME"')) stdout.emit("data", "/fixture");
            listener(0);
          });
          return { dispose() {} };
        },
      };
    },
    async upload(source, target) {
      uploads.push({ source, target });
    },
  });
  const stage = (operationId) =>
    service.stage({
      operationId,
      sessionId: "session",
      workspacePath: "/workspace",
      remoteSessionId: "remote",
      localPath: "C:/fixture/image.png",
      fileName: "image.png",
      mime: "image/png",
      sizeBytes: 10,
    });
  return { service, stage, commands, uploads };
}

test("reserved or adopted refs survive cleanup, cancellation and Host disposal", async () => {
  for (const disposition of ["reserved", "adopted"]) {
    const h = fixture();
    await h.stage("operation");
    await h.service.reserveForSubmission("operation");
    if (disposition === "adopted") await h.service.adopt("operation");
    await h.service.cleanup("operation");
    await h.service.cancel("operation");
    await h.service.dispose();
    assert.equal(
      h.commands.some((c) => c.includes("rm -f")),
      false,
    );
    assert.equal(
      h.commands.some((c) => c.includes("-delete")),
      false,
    );
    assert.equal(h.uploads.length, 1);
  }
});

test("definite rejection releases reservation, and only composer-owned refs are reclaimed", async () => {
  const h = fixture();
  await h.stage("rejected");
  await h.service.reserveForSubmission("rejected");
  await h.service.releaseSubmissionReservation("rejected");
  await h.service.cleanup("rejected");
  assert.equal(h.commands.filter((c) => c.includes("rm -f")).length, 1);
  await h.stage("unsent");
  await h.service.dispose();
  assert.equal(h.commands.filter((c) => c.includes("rm -f")).length, 2);
});

test("reserved operation cannot be overwritten, and repeated adoption does not upload again", async () => {
  const h = fixture();
  await h.stage("operation");
  await h.service.reserveForSubmission("operation");
  await assert.rejects(h.stage("operation"), /reserved/i);
  await h.service.adopt("operation");
  await h.service.adopt("operation");
  await h.service.dispose();
  assert.equal(h.uploads.length, 1);
  assert.equal(
    h.commands.some((c) => c.includes("rm -f")),
    false,
  );
});

test("frozen submission can adopt its reserved operation after Host disposal", async () => {
  const h = fixture();
  await h.stage("late");
  await h.service.reserveForSubmission("late");
  await h.service.dispose();
  await h.service.adopt("late");
  await h.service.adopt("late");
  await h.service.cleanup("late");
  assert.equal(h.uploads.length, 1);
  assert.equal(
    h.commands.some((c) => c.includes("rm -f")),
    false,
  );
});
