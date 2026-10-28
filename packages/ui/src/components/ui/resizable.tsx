// import { GripHorizontal, GripVertical } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type GroupProps,
  type GroupImperativeHandle,
  type Layout,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

/* ------------------------------------------------------------------ */
/*  ResizablePanelGroup                                                */
/* ------------------------------------------------------------------ */

/**
 * 带 localStorage 持久化的 PanelGroup 封装。
 * 传入 layoutId 即可自动保存/恢复布局；不传则不持久化。
 * panelIds 用于支持条件渲染的面板（面板数量会变化时必须传）。
 */
function ResizablePanelGroup({
  className,
  layoutId,
  panelIds,
  suspendLayoutPersistence = false,
  groupRef: groupRefProp,
  ...props
}: Omit<GroupProps, "defaultLayout" | "onLayoutChange" | "onLayoutChanged"> & {
  /** 持久化 key，对应 useDefaultLayout 的 id */
  layoutId: string;
  /** 条件渲染面板时需要传当前可见面板的 id 列表 */
  panelIds?: string[];
  /** 临时完整视图只影响展示，不得保存被缩窄后的比例。 */
  suspendLayoutPersistence?: boolean;
}) {
  const layoutIdentity = JSON.stringify([layoutId, panelIds ?? null]);
  const identityRef = useRef(layoutIdentity);
  const previousSuspendedRef = useRef(suspendLayoutPersistence);
  const suspendedRef = useRef(suspendLayoutPersistence);
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const normalLayoutRef = useRef<Layout | undefined>(undefined);
  if (identityRef.current !== layoutIdentity) {
    identityRef.current = layoutIdentity;
    normalLayoutRef.current = undefined;
    previousSuspendedRef.current = suspendLayoutPersistence;
  }
  // 子 Group 的 layout effect 早于父恢复；退出这一 commit 仍暂停，不能把临时尺寸认作普通布局。
  suspendedRef.current = suspendLayoutPersistence || previousSuspendedRef.current;
  const storage = useMemo(
    () => ({
      getItem: (key: string) => localStorage.getItem(key),
      setItem: (key: string, value: string) => {
        // 库内 debounce 可能已排队；写出口同时校验暂停与布局身份，旧回调不能覆盖新布局。
        if (!suspendedRef.current && identityRef.current === layoutIdentity)
          localStorage.setItem(key, value);
      },
    }),
    [layoutIdentity],
  );
  const { defaultLayout, onLayoutChange } = useDefaultLayout({
    id: layoutId,
    panelIds,
    storage,
  });
  if (!normalLayoutRef.current && defaultLayout) normalLayoutRef.current = defaultLayout;
  const setGroupRef = useCallback(
    (value: GroupImperativeHandle | null) => {
      groupRef.current = value;
      if (typeof groupRefProp === "function") {
        const cleanup = groupRefProp(value);
        if (typeof cleanup === "function")
          return () => {
            groupRef.current = null;
            cleanup();
          };
      } else if (groupRefProp) groupRefProp.current = value;
    },
    [groupRefProp],
  );
  useLayoutEffect(() => {
    const previous = previousSuspendedRef.current;
    previousSuspendedRef.current = suspendLayoutPersistence;
    if (!suspendLayoutPersistence && previous && normalLayoutRef.current)
      groupRef.current?.setLayout(normalLayoutRef.current);
    suspendedRef.current = suspendLayoutPersistence;
  }, [layoutIdentity, suspendLayoutPersistence]);
  const handleLayoutChange = useCallback(
    (layout: Layout) => {
      if (suspendedRef.current || identityRef.current !== layoutIdentity) return;
      normalLayoutRef.current = layout;
      onLayoutChange(layout);
    },
    [layoutIdentity, onLayoutChange],
  );

  return (
    <Group
      groupRef={setGroupRef}
      className={cn("flex h-full w-full", className)}
      defaultLayout={defaultLayout}
      // onLayoutChanged 会在每次布局变化后立刻写 localStorage。
      // 窗口 resize 时 PanelGroup 会连续产生成百上千次 layout 更新，必须走库内置
      // debounce 的 onLayoutChange，避免同步持久化放大主线程压力。
      onLayoutChange={handleLayoutChange}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  ResizablePanel                                                     */
/* ------------------------------------------------------------------ */

const ResizablePanel = Panel;
type ResizablePanelProps = PanelProps;

/* ------------------------------------------------------------------ */
/*  ResizableHandle                                                    */
/* ------------------------------------------------------------------ */

function ResizableHandle({ className, ...props }: SeparatorProps) {
  return (
    <Separator
      // react-resizable-panels 的 Separator 不会暴露 data-orientation，
      // 实际输出的是 aria-orientation，而且方向和 PanelGroup 相反。
      // 之前写的 data-[orientation=...] 一直没有命中，所以 w-px / h-px 看起来“没生效”。

      className={cn(
        "group/handle relative flex shrink-0 items-center justify-center bg-transparent outline-none transition-colors focus:outline-none focus-visible:outline-none focus-visible:bg-border-hover/60 focus-visible:ring-0",
        "hover:bg-border-hover/60 data-[separator=hover]:bg-border-hover/60 data-[separator=active]:bg-border-hover z-10",

        // react-resizable-panels 会在 pointerdown 时主动 focus 当前 Separator，
        // 如果这里不接管 focus 样式，Chromium 会给可聚焦的 role=separator 画默认黄色高亮。
        // 终端/浏览器打开后颜色恢复，本质上只是焦点被转移了，不是布局自己修好了。
        "aria-[orientation=vertical]:translate-x-px",
        "aria-[orientation=vertical]:my-6",
        "aria-[orientation=vertical]:w-px",
        "aria-[orientation=vertical]:h-[calc(100%-48px)]",
        "aria-[orientation=vertical]:[mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=vertical]:[-webkit-mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]",

        "aria-[orientation=horizontal]:translate-y-px",
        "aria-[orientation=horizontal]:mx-6",
        "aria-[orientation=horizontal]:h-px",
        "aria-[orientation=horizontal]:w-[calc(100%-48px)]",
        "aria-[orientation=horizontal]:[mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",
        "aria-[orientation=horizontal]:[-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_18%,black_82%,transparent_100%)]",

        className,
      )}
      {...props}
    >
      {/* <div
        className="z-10 flex items-center justify-center rounded-sm
          text-on-surface-muted/40
          transition-colors
          group-data-[orientation=horizontal]/handle:h-6
          group-data-[orientation=horizontal]/handle:w-3
          group-data-[orientation=vertical]/handle:h-3
          group-data-[orientation=vertical]/handle:w-6"
      >
        <GripVertical
          size={12}
          className="group-data-[orientation=vertical]/handle:hidden"
        />
        <GripHorizontal
          size={12}
          className="hidden group-data-[orientation=vertical]/handle:block"
        /> 
      </div>*/}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle, type ResizablePanelProps };
