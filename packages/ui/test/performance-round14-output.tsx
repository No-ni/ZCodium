import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, IZCodeAgentService } from "@zcode/services";
import type { BackgroundBashOutput, BackgroundBashOutputResult } from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION, type ClientHello } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useBackgroundBashOutput } from "@/hooks/useBackgroundBashOutput.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const helloGate = deferred<void>();
const initGate = deferred<void>();
const mobile = new URLSearchParams(location.search).get("mode") === "mobile";
const target = {
  workspacePath: "C:/synthetic/workspace",
  workspaceIdentity: "synthetic-identity",
  remoteSessionId: "synthetic-attachment",
  sessionId: "synthetic-session",
  workId: "work-a",
};
type OutputParams = Parameters<IZCodeAgentService["backgroundBashOutputV4"]>[0];
const calls: OutputParams[] = [];
const pending: { params: OutputParams; resolve: (result: BackgroundBashOutputResult) => void }[] =
  [];
const clientHellos: ClientHello[] = [];
let helloCalls = 0;
const service = {
  async helloConversationV4() {
    helloCalls++;
    await helloGate.promise;
    return {
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "synthetic-connection",
      clientMode: mobile ? "web-remote-replayable" : "desktop-continuous",
      deliveryProfile: mobile ? "replayable" : "continuous",
      serverTime: 1,
      capabilities: {
        nativeDialogs: !mobile,
        localTerminal: !mobile,
        binaryFrames: true,
        compression: "none",
      },
      auth: {},
    };
  },
  async initializeConversationV4(hello: ClientHello) {
    clientHellos.push(hello);
    await initGate.promise;
  },
  backgroundBashOutputV4(params: OutputParams) {
    calls.push({ ...params });
    return new Promise<BackgroundBashOutputResult>((resolve) => pending.push({ params, resolve }));
  },
};
const services = { zcodeAgentService: service } as unknown as IServiceAccessor;

const api = {
  snapshot: () => ({ calls, helloCalls, clientHellos, pending: pending.length }),
  resolveHello: () => helloGate.resolve(),
  resolveInit: () => initGate.resolve(),
  resolveOutput(status: BackgroundBashOutput["status"] = "completed", text = "synthetic output") {
    const request = pending.shift();
    request?.resolve({
      kind: "output",
      workId: request.params.workId,
      status,
      output: text,
      outputPath: "C:/synthetic/output.txt",
      truncated: false,
    });
  },
};
declare global {
  interface Window {
    performanceRound14Output: typeof api;
  }
}
window.performanceRound14Output = api;

function OutputHarness({ visible, workId }: { visible: boolean; workId: string }) {
  const preview = useBackgroundBashOutput({ ...target, workId }, visible);
  return (
    <section id="output-panel" data-visible={String(visible)}>
      <button onClick={preview.refresh}>Refresh output</button>
      <button onClick={preview.pause}>Pause display</button>
      <button onClick={preview.resume}>Resume display</button>
      <output id="output" data-status={preview.latest?.status ?? "loading"}>
        {preview.display?.output ?? ""}
      </output>
    </section>
  );
}

function App() {
  const [mounted, setMounted] = useState(true);
  const [visible, setVisible] = useState(true);
  const [workId, setWorkId] = useState("work-a");
  return (
    <ServiceProvider services={services}>
      <button onClick={() => setVisible(false)}>Hide output</button>
      <button
        onClick={() => {
          setVisible(true);
          setMounted(true);
        }}
      >
        Open output
      </button>
      <button onClick={() => setMounted(false)}>Unmount output</button>
      <button onClick={() => setWorkId("work-b")}>Switch target</button>
      {mounted ? <OutputHarness visible={visible} workId={workId} /> : null}
    </ServiceProvider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
