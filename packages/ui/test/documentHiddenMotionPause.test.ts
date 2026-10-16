import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCUMENT_HIDDEN_ATTRIBUTE,
  installDocumentHiddenMotionPause,
} from "../src/lib/documentHiddenMotionPause.js";

class TestDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  attributes = new Set<string>();
  documentElement = {
    toggleAttribute: (name: string, force: boolean) => {
      if (force) this.attributes.add(name);
      else this.attributes.delete(name);
    },
    removeAttribute: (name: string) => this.attributes.delete(name),
  };

  setVisibility(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function install(doc: TestDocument) {
  return installDocumentHiddenMotionPause(doc as unknown as Document);
}

test("initial visibility is applied before rendering and follows repeated visibility events", (t) => {
  for (const initial of ["visible", "hidden"] as const) {
    const doc = new TestDocument();
    doc.visibilityState = initial;
    const dispose = install(doc);
    t.after(dispose);
    assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), initial === "hidden");
    doc.setVisibility("hidden");
    doc.setVisibility("hidden");
    assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), true);
    doc.setVisibility("visible");
    assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);
  }
});

test("dispose removes its listener and marker, and reinstall owns future updates", (t) => {
  const doc = new TestDocument();
  const dispose = install(doc);
  doc.setVisibility("hidden");
  dispose();
  dispose();
  assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);
  doc.setVisibility("hidden");
  assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);

  const disposeNext = install(doc);
  t.after(disposeNext);
  assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), true);
  doc.setVisibility("visible");
  assert.equal(doc.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);
});

test("each document reads and writes only its own visibility", (t) => {
  const desktop = new TestDocument();
  const mobile = new TestDocument();
  t.after(install(desktop));
  t.after(install(mobile));
  desktop.setVisibility("hidden");
  assert.equal(desktop.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), true);
  assert.equal(mobile.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);
  mobile.setVisibility("hidden");
  desktop.setVisibility("visible");
  assert.equal(desktop.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), false);
  assert.equal(mobile.attributes.has(DOCUMENT_HIDDEN_ATTRIBUTE), true);
});
