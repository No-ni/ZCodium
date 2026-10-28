import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Collapsible } from "radix-ui";
const native = HTMLElement.prototype.getBoundingClientRect;
window.collapsibleMeasurement = { hiddenReads: 0, visibleReads: 0 };
HTMLElement.prototype.getBoundingClientRect = function () {
  if (this.dataset.fixtureContent !== undefined) {
    if (this.hidden) window.collapsibleMeasurement.hiddenReads++;
    else window.collapsibleMeasurement.visibleReads++;
  }
  return native.call(this);
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Collapsible measurement</h1>
      <p>Closed details do not need geometry measurements.</p>
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.Trigger>Toggle details</Collapsible.Trigger>
        <Collapsible.Content data-fixture-content>Visible details</Collapsible.Content>
      </Collapsible.Root>
      {Array.from({ length: 100 }, (_, key) => (
        <Collapsible.Root key={key} open={false}>
          <Collapsible.Content data-fixture-content>Hidden details</Collapsible.Content>
        </Collapsible.Root>
      ))}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
