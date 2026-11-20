/** 只复用原所有者的输入与回调；规则见官方 3.18.2 合并 spec。 */
export type Entry1 = typeof import("./../useBrowserDesignMode.js");
export type Entry2 = typeof import("./../browserDesignModeHelpers.js");
export type Entry3 = typeof import("./../useBrowserDesignChips.js");
export type Entry4 = typeof import("./../useBrowserDesignPlugin.js");
export type Entry5 = typeof import("./../BrowserDesignInspector.js");
export type Entry6 = typeof import("./../BrowserDesignInspectorFields.js");
export type Entry7 = typeof import("./../../EmbeddedBrowserStates.js");
