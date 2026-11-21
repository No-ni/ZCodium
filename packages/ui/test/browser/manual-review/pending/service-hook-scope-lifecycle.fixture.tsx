import { Component, StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type {
  IServiceAccessor,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
} from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import "@/styles.css";

declare global {
  interface Window {
    serviceFixtureErrors: string[];
    serviceFixtureCalls: { kind: string; host: string }[];
    serviceFixtureGetterFailures: number;
  }
}
window.serviceFixtureErrors = [];
window.serviceFixtureCalls = [];
window.serviceFixtureGetterFailures = 0;
const query = new URLSearchParams(location.search);
const kind = query.get("kind") ?? "agent";
const noTabs = query.has("no-tabs");
const localPath = "fixture/local",
  remotePath = "fixture/shared";
const identities = { B: "fixture-remote-B:fixture/shared", C: "fixture-remote-C:fixture/shared" };
function services(host: string): IServiceAccessor {
  return {
    zcodeAgentService: {
      async listSessions() {
        window.serviceFixtureCalls.push({ kind: "agent", host });
        return [];
      },
    },
    zcodeSessionService: {
      async listSessions() {
        window.serviceFixtureCalls.push({ kind: "session", host });
        return [];
      },
    },
    zcodeTaskService: {
      async getTaskMeta() {
        window.serviceFixtureCalls.push({ kind: "task", host });
        return null;
      },
    },
    onboardingRecordService: { host },
  } as unknown as IServiceAccessor;
}
const base = services("base"),
  remoteB = services("B"),
  remoteC = services("C");
useRemoteWorkspaceSessionStore.getState().registerBaseServices(base);
function registerC() {
  const registry = useRemoteWorkspaceSessionStore.getState();
  registry.registerSession({
    sessionId: "C",
    workspacePath: remotePath,
    workspaceIdentity: identities.C,
    services: remoteC,
  });
  registry.bindWorkspaceIdentity(identities.C, "C");
}
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerSession({
  sessionId: "B",
  workspacePath: remotePath,
  workspaceIdentity: identities.B,
  services: remoteB,
});
registry.bindWorkspaceIdentity(identities.B, "B");
registerC();

// 保持 Context 服务对象身份：React 开发态 profiler 会遍历变化的 prop 对象并读取
// getter，那是测试输入引发的额外异常。故障只在同一合成端口的读取时注入。
let onboardingMode = "present";
const onboardingServices = Object.defineProperty({}, "onboardingRecordService", {
  get() {
    if (onboardingMode === "throwing") {
      window.serviceFixtureGetterFailures += 1;
      throw new Error("fixture getter failed");
    }
    return onboardingMode === "missing" ? undefined : remoteB.onboardingRecordService;
  },
}) as IServiceAccessor;

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    window.serviceFixtureErrors.push(error.message);
  }
  render() {
    return this.state.failed ? (
      <p data-testid="fixture-error">Fixture render failed</p>
    ) : (
      this.props.children
    );
  }
}

type Scope = "context" | "local" | "B" | "C";
type ProbeProps = { scope: Scope };
function target(scope: Scope) {
  return scope === "context"
    ? { path: undefined, identity: undefined }
    : scope === "local"
      ? { path: localPath, identity: undefined }
      : { path: remotePath, identity: identities[scope] };
}
function ServiceProbe({
  service,
  scope,
  kind,
}: {
  service: IZCodeAgentService | IZCodeSessionService | IZCodeTaskService;
  scope: Scope;
  kind: string;
}) {
  const [result, setResult] = useState("ready");
  const { path, identity } = target(scope);
  return (
    <section data-testid="service-probe" data-scope={scope}>
      <button
        type="button"
        onClick={() => {
          setResult("pending");
          const request =
            kind === "task"
              ? (service as IZCodeTaskService).getTaskMeta({
                  taskId: "fixture-task",
                  workspacePath: path ?? remotePath,
                  workspaceIdentity: identity,
                })
              : (service as IZCodeAgentService | IZCodeSessionService).listSessions({
                  workspacePath: path ?? remotePath,
                  workspaceIdentity: identity,
                });
          void request.then(
            () => setResult("ok"),
            () => setResult("rejected"),
          );
        }}
      >
        Read target
      </button>
      <output data-testid="request-result">{result}</output>
    </section>
  );
}
function AgentProbe({ scope }: ProbeProps) {
  const { path, identity } = target(scope);
  const service = useZCodeAgentService(path, undefined, identity);
  return <ServiceProbe service={service} scope={scope} kind="agent" />;
}
function SessionProbe({ scope }: ProbeProps) {
  const { path, identity } = target(scope);
  const service = useZCodeSessionService(path, undefined, identity);
  return <ServiceProbe service={service} scope={scope} kind="session" />;
}
function TaskProbe({ scope }: ProbeProps) {
  const { path, identity } = target(scope);
  const service = useZCodeTaskService(path, undefined, identity);
  return <ServiceProbe service={service} scope={scope} kind="task" />;
}
function OnboardingProbe() {
  const service = useOnboardingRecordService();
  return (
    <output data-testid="onboarding-value">
      {service === remoteB.onboardingRecordService ? "B" : service === null ? "null" : "other"}
    </output>
  );
}

function Fixture() {
  const [scope, setScope] = useState<Scope>(query.get("initial") === "local" ? "local" : "context");
  const [onboarding, setOnboarding] = useState("present");
  const [connectionRevision, setConnectionRevision] = useState(0);
  const probe =
    kind === "session" ? (
      <SessionProbe scope={scope} />
    ) : kind === "task" ? (
      <TaskProbe scope={scope} />
    ) : kind === "onboarding" ? (
      <OnboardingProbe />
    ) : (
      <AgentProbe scope={scope} />
    );
  const provided = kind === "onboarding" ? onboardingServices : remoteB;
  const content = <Boundary>{probe}</Boundary>;
  return (
    <main
      className="min-h-dvh bg-background p-4 text-foreground text-ui-base"
      data-revision={connectionRevision}
      data-onboarding={onboarding}
    >
      <nav className="mb-4 flex flex-wrap gap-3">
        {(["context", "local", "B", "C"] as const).map((value) => (
          <button key={value} type="button" onClick={() => setScope(value)}>
            Scope {value}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            useRemoteWorkspaceSessionStore.getState().unregisterSession("C");
            setConnectionRevision((value) => value + 1);
          }}
        >
          Disconnect C
        </button>
        <button
          type="button"
          onClick={() => {
            registerC();
            setConnectionRevision((value) => value + 1);
          }}
        >
          Reconnect C
        </button>
        {(["missing", "throwing", "present"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              onboardingMode = value;
              setOnboarding(value);
            }}
          >
            Onboarding {value}
          </button>
        ))}
      </nav>
      {query.has("no-services") ? (
        content
      ) : (
        <ServiceProvider services={provided as IServiceAccessor}>
          {noTabs ? content : <TabStoreProvider>{content}</TabStoreProvider>}
        </ServiceProvider>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
