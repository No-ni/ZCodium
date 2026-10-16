/// <reference types="vite/client" />
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { installDocumentHiddenMotionPause } from "@zcode/ui/document-hidden-motion-pause";
import { MobileApp } from "./MobileApp.js";
import "@zcode/ui/styles.css";

const disposeDocumentHiddenMotionPause = installDocumentHiddenMotionPause();
import.meta.hot?.dispose(disposeDocumentHiddenMotionPause);

const container = document.getElementById("mobile-root");
if (!container) {
  throw new Error("mobile-root container is missing");
}

createRoot(container).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
