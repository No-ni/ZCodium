import { lazy, Suspense, type ComponentProps } from "react";
import { Spinner } from "@/components/ui/spinner.js";

const Content = lazy(() =>
  import("@/SettingsPage.js").then((module) => ({ default: module.SettingsPage })),
);

export function SettingsPage(props: ComponentProps<typeof Content>) {
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
