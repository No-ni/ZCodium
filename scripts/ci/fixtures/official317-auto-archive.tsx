import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TaskAutoArchiveSettings } from "../../../packages/ui/src/settingsPageHelpers.js";
import "../../../packages/ui/src/styles.css";

const calls: Record<string, boolean | number>[] = [];
Object.assign(window, { fixtureCalls: calls });
function Fixture() {
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState(7);
  return (
    <main className="mx-auto max-w-3xl p-4">
      <TaskAutoArchiveSettings
        taskAutoArchiveEnabled={enabled}
        taskAutoArchiveOlderThanDays={days}
        onTaskAutoArchiveEnabledChange={async (value) => {
          calls.push({ taskAutoArchiveEnabled: value });
          setEnabled(value);
        }}
        onTaskAutoArchiveOlderThanDaysChange={async (value) => {
          calls.push({ taskAutoArchiveOlderThanDays: value });
          setDays(value);
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <Fixture />
  </ZCodeIntlProvider>,
);
