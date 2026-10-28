import { runProjectBrowserFixture } from "./project-browser-fixture.mjs";

await runProjectBrowserFixture({
  label: "model-menu-browser",
  entry: "packages/ui/test/adoption-model-menu.html",
});
