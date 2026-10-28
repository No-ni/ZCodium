import { runProjectBrowserFixture } from "./project-browser-fixture.mjs";

await runProjectBrowserFixture({
  label: "full-view-browser",
  entry: "packages/ui/test/adoption-full-view.html",
});
