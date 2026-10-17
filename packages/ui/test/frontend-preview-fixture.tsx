import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PreviewPaneOfficeDocxContent } from "@/previewPaneOfficeDocxContent.js";
import { frontendPreviewRenderer } from "./frontend-preview-renderer.js";

Object.assign(window, { frontendPreviewFixture: frontendPreviewRenderer });

function FrontendPreviewFixture() {
  const [buffer, setBuffer] = useState(() => new Uint8Array([1]).buffer);
  const [path, setPath] = useState("C:/synthetic/first.docx");
  const [callbackVersion, setCallbackVersion] = useState(0);
  const [callbackEnabled, setCallbackEnabled] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [openedLinks, setOpenedLinks] = useState<string[]>([]);
  return (
    <>
      <button onClick={() => setCallbackVersion((value) => value + 1)}>Change callback</button>
      <button onClick={() => setCallbackEnabled((value) => !value)}>Toggle link callback</button>
      <button onClick={() => setBuffer(new Uint8Array([2]).buffer)}>Change buffer</button>
      <button onClick={() => setPath("C:/synthetic/second.docx")}>Change path</button>
      <button onClick={() => setMounted(false)}>Unmount preview</button>
      <output id="docx-callback-version">{callbackVersion}</output>
      <output id="docx-opened-links">{openedLinks.join(",")}</output>
      <div id="docx-container" style={{ width: "400px", height: "350px" }}>
        {mounted ? (
          <PreviewPaneOfficeDocxContent
            buffer={buffer}
            errorMessage="Preview failed"
            sourcePath={path}
            onOpenBrowserUrl={
              callbackEnabled
                ? (url) => setOpenedLinks((links) => [...links, `${callbackVersion}:${url}`])
                : undefined
            }
          />
        ) : null}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<FrontendPreviewFixture />);
