import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  WorkspaceHookPendingIndicator,
  WorkspaceMcpPendingIndicator,
} from "@/v4/WorkspaceHookPendingBanner.js";
import "@/styles.css";
const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.className = dark ? "dark theme-zai-dark" : "light theme-zai-light";
function Fixture() {
  const [digest, setDigest] = useState("bundle-a");
  const hook = { pendingCount: 2, bundleDigest: digest, workspaceIdentity: "identity-a" };
  return (
    <main className="flex min-h-screen flex-col gap-6 bg-background p-4 text-foreground">
      <button onClick={() => setDigest("bundle-new")}>Change digest</button>
      <section data-testid="pane-a">
        <WorkspaceHookPendingIndicator
          sessionId="same-session"
          workspacePath="same-path"
          workspaceIdentity="identity-a"
          admission={hook}
        />
      </section>
      <section data-testid="pane-a-copy">
        <WorkspaceHookPendingIndicator
          sessionId="same-session"
          workspacePath="same-path"
          workspaceIdentity="identity-a"
          admission={hook}
        />
      </section>
      <section data-testid="pane-b">
        <WorkspaceHookPendingIndicator
          sessionId="same-session"
          workspacePath="same-path"
          workspaceIdentity="identity-b"
          admission={{ ...hook, workspaceIdentity: "identity-b" }}
        />
      </section>
      <section data-testid="pane-stale">
        <WorkspaceHookPendingIndicator
          sessionId="same-session"
          workspacePath="same-path"
          workspaceIdentity="identity-c"
          admission={hook}
        />
      </section>
      <section data-testid="mcp">
        <WorkspaceMcpPendingIndicator
          sessionId="same-session"
          workspacePath="same-path"
          workspaceIdentity="identity-a"
          admission={{ ...hook }}
        />
      </section>
      <textarea aria-label="Composer" className="h-24 rounded-lg border border-border bg-input" />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <Fixture />
  </ZCodeIntlProvider>,
);
