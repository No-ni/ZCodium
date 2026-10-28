import assert from "node:assert/strict";
import { test } from "node:test";
import { loadComponentCallback } from "./fixtures/component-callback.mjs";

const source = "packages/ui/src/prompt-editor/useComposerToolbarFit.ts";
test("toolbar probe keeps editor and attachment subtrees out of measurement clones", async () => {
  const copies = [];
  const projection = { dataset: {}, className: "flex toolbar" };
  const fakeRoot = {
    dataset: { composerLayout: "inline" },
    cloneNode(deep) {
      assert.equal(deep, false, "The whole editor shell must not be cloned");
      return {
        ...projection,
        dataset: { composerLayout: this.dataset.composerLayout },
        append: (...elements) => copies.push(...elements),
        setAttribute() {},
      };
    },
    querySelectorAll: (selector) => {
      assert.equal(selector, "[data-composer-action-menu], [data-composer-controls]");
      return [
        { cloneNode: () => ({ kind: "action-menu" }) },
        { cloneNode: () => ({ kind: "controls" }) },
      ];
    },
  };
  const create = await loadComponentCallback(source, "createComposerToolbarProbe", {});
  const probe = create(fakeRoot);
  assert.deepEqual(copies, [{ kind: "action-menu" }, { kind: "controls" }]);
  assert.equal(probe.dataset.composerLayout, "inline");
  assert.equal(probe.className, "flex toolbar");
});
