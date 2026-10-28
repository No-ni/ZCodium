import { runProjectBrowserFixture } from "./project-browser-fixture.mjs";

await runProjectBrowserFixture({
  label: "collapsible-browser",
  entry: "packages/ui/test/adoption-collapsible.html",
  tailwind: false,
});
