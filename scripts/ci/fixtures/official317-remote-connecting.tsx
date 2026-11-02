import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { RemoteConnectionConnectingStep } from "../../../packages/ui/src/remote-connection/RemoteConnectionConnectingStep.js";
import "../../../packages/ui/src/styles.css";

const calls: string[] = [];
Object.assign(window, { fixtureCalls: calls });
function Fixture() {
  const [mode, setMode] = useState("loading"),
    [value, setValue] = useState("");
  const record = (event: string) => {
    calls.push(event);
  };
  return (
    <div className="h-screen p-3">
      <nav className="flex flex-wrap gap-2 pb-3">
        {["loading", "credential", "ready", "manual"].map((next) => (
          <button key={next} data-testid={"fixture-" + next} onClick={() => setMode(next)}>
            {next}
          </button>
        ))}
      </nav>
      <RemoteConnectionConnectingStep
        logs={[
          {
            id: "fixture",
            level: "info",
            timestamp: "00:00:00",
            message: "[source-server:protocol-handshake] fixture",
          },
        ]}
        loading={mode === "loading"}
        errorMessage={mode === "manual" ? "A compatible version must be deployed manually." : ""}
        errorCode={mode === "manual" ? "source-server-upgrade-required" : undefined}
        recognizedDeviceName="Fixture device"
        connectionReady={mode === "ready"}
        onBack={() => record("back")}
        onRetry={() => record("retry")}
        onCancelConnection={() => record("cancel")}
        onMinimize={() => record("minimize")}
        onContinueToDirectory={() => record("directory")}
        credentials={
          mode === "credential"
            ? {
                passphrase: false,
                value,
                onChange: setValue,
                onSubmit: () => record("credential-submit"),
              }
            : undefined
        }
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={{ openFeedback: async () => {} } as never}>
    <ZCodeIntlProvider initialLocale="en-US">
      <Fixture />
    </ZCodeIntlProvider>
  </PlatformProvider>,
);
