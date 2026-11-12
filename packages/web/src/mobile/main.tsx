/// <reference types="vite/client" />
import { createRoot } from "react-dom/client";
import { installDocumentHiddenMotionPause } from "@zcode/ui/document-hidden-motion-pause";
import { MobileApp } from "./MobileApp.js";
import "./mobile.css";

const disposeDocumentHiddenMotionPause = installDocumentHiddenMotionPause();
import.meta.hot?.dispose(disposeDocumentHiddenMotionPause);

const container = document.getElementById("mobile-root");
if (!container) {
  throw new Error("mobile-root container is missing");
}

// 原因：共享会话 Provider 按桌面的单次挂载契约持有数据层；StrictMode 重放 cleanup 会提前释放仍在使用的实例。
createRoot(container).render(<MobileApp />);
