import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppSettings, Locale } from "@zcode/shared";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { AgentBehaviorSectionContent } from "../../../packages/ui/src/settingsPageHelpers.js";
import "../../../packages/ui/src/styles.css";
const { useProductionGrouping } = await import(
  /* @vite-ignore */ new URLSearchParams(location.search).get("projection")!
);
const rows = ["Read", "Read", "Bash", "Bash", "Write", "Write"].map((toolName, i) => ({
  rowId: i + 1,
  turnId: "fixture",
  productTurnId: "fixture",
  createdAt: i + 1,
  createdAtSeq: i + 1,
  kind: "toolCall",
  toolCallId: `fixture-${i}`,
  toolName,
  status: "success",
  inputText: "{}",
  input:
    toolName === "Read"
      ? { file_path: `example-${i}.txt` }
      : toolName === "Bash"
        ? { command: `mkdir example-${i}` }
        : { file_path: `example-${i}.txt`, content: "fixture" },
  output: { text: "fixture" },
}));

function Fixture() {
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState("");
  const { context, items } = useProductionGrouping(settings, rows);
  useEffect(() => {
    void fetch("/fixture/settings")
      .then((r) => r.json())
      .then(setSettings)
      .catch(() => setError("read failed"));
  }, []);
  async function change(handler: string, value: boolean) {
    try {
      const response = await fetch("/fixture/settings", {
        method: "POST",
        body: JSON.stringify({ handler, value }),
      });
      if (!response.ok) throw new Error("save failed");
      setSettings(await response.json());
    } catch {
      setError("save failed");
    }
  }
  if (!settings) return <p>Loading</p>;
  const unused = async () => {};
  return (
    <main className="mx-auto max-w-3xl p-4">
      {error && <p role="alert">{error}</p>}
      <output data-testid="grouping-projection">
        {JSON.stringify({
          flags: [
            context.toolGroupingExploreEnabled,
            context.toolGroupingTerminalEnabled,
            context.toolGroupingChangesEnabled,
          ],
          kinds: items.map((item: { kind: string }) => item.kind),
        })}
      </output>
      <AgentBehaviorSectionContent
        toolSearchMode={settings.toolSearchMode}
        onToolSearchModeChange={unused}
        nativeSearchEnhancementsEnabled={settings.nativeSearchEnhancementsEnabled !== false}
        messageStreamShowReasoning={settings.messageStreamShowReasoning !== false}
        messageStreamShowTodos={settings.messageStreamShowTodos === true}
        toolGroupingExploreEnabled={settings.toolGroupingExploreEnabled !== false}
        toolGroupingTerminalEnabled={settings.toolGroupingTerminalEnabled !== false}
        toolGroupingChangesEnabled={settings.toolGroupingChangesEnabled !== false}
        onToolGroupingExploreEnabledChange={(v) =>
          change("handleToolGroupingExploreEnabledChange", v)
        }
        onToolGroupingTerminalEnabledChange={(v) =>
          change("handleToolGroupingTerminalEnabledChange", v)
        }
        onToolGroupingChangesEnabledChange={(v) =>
          change("handleToolGroupingChangesEnabledChange", v)
        }
        zcodeInteractionBehavior={settings.zcodeInteractionBehavior ?? "queue"}
        onNativeSearchEnhancementsEnabledChange={unused}
        onMessageStreamShowReasoningChange={unused}
        onMessageStreamShowTodosChange={unused}
        onZCodeInteractionBehaviorChange={unused}
      />
    </main>
  );
}
const locale = new URLSearchParams(location.search).get("locale") as Locale | null;
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale ?? "en-US"}>
    <Fixture />
  </ZCodeIntlProvider>,
);
