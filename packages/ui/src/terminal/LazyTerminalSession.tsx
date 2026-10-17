import { lazy, Suspense, type ComponentProps } from "react";
import { Spinner } from "@/components/ui/spinner.js";

// 两个终端入口共享此边界，避免侧栏的静态导入把 xterm 再拉回首屏。
const Content = lazy(() =>
  import("./TerminalSession.js").then((module) => ({ default: module.TerminalSession })),
);
export function TerminalSession(props: ComponentProps<typeof Content>) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Content {...props} />
    </Suspense>
  );
}
