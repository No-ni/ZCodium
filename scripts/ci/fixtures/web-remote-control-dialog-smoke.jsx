import React from "react";
import { createRoot } from "react-dom/client";
import enMessages from "../../../packages/ui/src/i18n/locales/en-US.ts";
import zhMessages from "../../../packages/ui/src/i18n/locales/zh-CN.ts";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.tsx";
import { WebRemoteControlDialog } from "../../../packages/ui/src/WebRemoteControlDialog.tsx";
import "../../../packages/ui/src/styles.css";

const DICTIONARIES = { "en-US": enMessages, "zh-CN": zhMessages };

function App() {
  const [open, setOpen] = React.useState(true);
  const [locale, setLocale] = React.useState("en-US");
  React.useEffect(() => {
    window.fixtureEvents = [];
    window.fixtureDictionaries = DICTIONARIES;
    window.setDialogOpen = setOpen;
    window.setFixtureLocale = setLocale;
    window.setFixtureBusy = (busy) => {
      window.fixtureBusy = busy;
      window.dispatchEvent(new Event("fixture-state"));
    };
    window.setFixtureState = (state) => {
      window.fixtureRemoteState = state;
      window.dispatchEvent(new Event("fixture-state"));
    };
  }, []);
  return (
    <>
      <div className="flex gap-3 p-4">
        <button onClick={() => setOpen(true)}>Open remote control</button>
        <button onClick={() => setLocale(locale === "en-US" ? "zh-CN" : "en-US")}>
          Change language
        </button>
        <button
          onClick={() => {
            const root = document.documentElement;
            root.className =
              root.className === "theme-zai-dark" ? "theme-zai-light" : "theme-zai-dark";
          }}
        >
          Change theme
        </button>
      </div>
      {/* 语言由真实 Provider 持有，夹具只通过重挂载设置初始语言。 */}
      <ZCodeIntlProvider key={locale} initialLocale={locale}>
        <WebRemoteControlDialog
          open={open}
          onOpenChange={(next) => {
            window.fixtureEvents.push(["dialog-open", next]);
            setOpen(next);
          }}
          workspacePath="/fixture/workspace"
          workspaceIdentity="fixture-identity"
          remoteSessionId="fixture-session"
        />
        <output data-testid="fixture-events">{JSON.stringify(window.fixtureEvents)}</output>
      </ZCodeIntlProvider>
    </>
  );
}

document.documentElement.className = "theme-zai-light";
createRoot(document.getElementById("root")).render(<App />);
