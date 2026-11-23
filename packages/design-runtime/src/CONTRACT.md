# Design runtime

Injected page runtime for the embedded browser's design tools (docs/browser-use/2026-11-03-browser-design-mode-spec.md).

- Page-side functions (`createElementInspector`, `installDesignRuntime`, `readDesignPageSignals`) are serialized with `.toString()` and run inside the guest page. Their bodies must stay self-contained: they may use only their parameters and page globals.
- Page → host traffic is `window.postMessage({ [bridgeKey]: 1, events })`; the embedded browser's fixed guest preload checks source, shape and size and forwards it with `sendToHost`. Host → page traffic is the fixed `DesignRuntimeCommand` set over `executeJavaScript`. Page scripts can forge events, so every host-side parser (`parseDesignRuntimeEvents`, `parseDesignPageInfo`, `parseDesignPageSignals`) caps strings and arrays (`DESIGN_PAGE_LIMITS`); the result only ever becomes a user-visible, removable element reference, and a forged source path can only fail to match.
- The runtime owns only a projection (selection boxes, style previews). The page reports the selection; the host mirrors it and owns CSS variable previews and the active variant, and re-sends them after every reinjection.
- `sourceEdit.ts` (parse5, host-side only, never serialized into the page) maps a selected element back to the local HTML source by its path of tag / index / sibling count plus id and class, and rewrites only that element's `style` attribute or text, or one `:root` variable value. Any mismatch returns null and nothing is written; the host writes with an expected-content check (`IFileService.writeDesignSourceFile`).

The page runtime follows the official self-contained function structure. Overlay, backdrop and element description stay inside `installDesignRuntime`; its original inspector and signal-reader arguments remain the only injected helpers. This removes the former helper-only split without changing page projection ownership, host admission or persistence.
