import type { Ref, RefCallback } from "react";

function attachRef<T>(ref: Ref<T> | undefined, node: T | null): (() => void) | undefined {
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return typeof cleanup === "function"
      ? cleanup
      : () => {
          ref(null);
        };
  }
  if (ref) {
    ref.current = node;
    return () => {
      ref.current = null;
    };
  }
}

/** 组合两个 ref；调用方用 useMemo 保持 callback 身份稳定。 */
export function composeRefs<T>(
  first: Ref<T> | undefined,
  second: Ref<T> | undefined,
): RefCallback<T> {
  return (node) => {
    const cleanupFirst = attachRef(first, node);
    const cleanupSecond = attachRef(second, node);
    // 原因：只转发 ref(node) 会丢掉 React 19 返回的资源清理；detach 必须执行
    // 对应 cleanup，旧 callback/object ref 才回填 null，且不能漏掉另一方的释放。
    return () => {
      try {
        cleanupFirst?.();
      } finally {
        cleanupSecond?.();
      }
    };
  };
}
