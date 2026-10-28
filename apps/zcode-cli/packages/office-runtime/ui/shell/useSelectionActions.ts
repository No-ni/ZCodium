import { useCallback, useRef, useState, type RefObject } from "react";
import { type Selection } from "#office/contract.ts";
import { formatAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import { getHost } from "#ui/host.ts";
import type { Strings } from "#ui/i18n.ts";
import { clip, type LoadedDoc, type Picked, type Reference } from "#ui/shell/state.ts";
import type { BarMode } from "#ui/shell/parts.tsx";
import type { SelectionDetail, ViewerHandle } from "#ui/viewers/types.ts";

/** 引用与提问复用 App 的 composer/context/message ports；不持有已接受消息或附件队列。 */
export function useSelectionActions(
  t: Strings,
  docRef: RefObject<LoadedDoc | null>,
  viewer: RefObject<ViewerHandle | null>,
  showNotice: (text: string) => void,
) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [barMode, setBarMode] = useState<BarMode>("bar");
  const [copied, setCopied] = useState(false);
  const references = useRef<Reference[]>([]);
  const host = getHost();
  const clearSelection = useCallback(() => {
    viewer.current?.clearSelection();
    setPicked(null);
    setBarMode("bar");
  }, [viewer]);
  const onSelect = useCallback((next: Selection | null, detail?: SelectionDetail) => {
    setBarMode("bar");
    setCopied(false);
    setPicked(next && detail ? { selection: next, detail } : null);
  }, []);
  const addReference = useCallback(async () => {
    const current = docRef.current;
    if (!current || !picked || !host.capabilities?.updateModelContext) return;
    const anchor = formatAnchor(current.info.path, picked.selection.at);
    const text = picked.selection.text;
    const next = [
      ...references.current.filter((item) => item.anchor !== anchor || item.text !== text),
      { anchor, text },
    ].slice(-10);
    const lines = next.map(
      (item) => `- ${item.anchor}${item.text ? `: "${clip(item.text, 600)}"` : ""}`,
    );
    try {
      await host.ready();
      await host.app.updateModelContext({
        content: [
          {
            type: "text",
            text: wellFormed(
              `The user referenced these locations in the ${PROFILE.title.en} viewer (use read_document / show_in_viewer with the anchors):\n${lines.join("\n")}`,
            ),
          },
        ],
        structuredContent: wellFormedDeep({ references: next }),
      });
      references.current = next;
      if (pickedRef.current !== picked) return;
      setBarMode("added");
      setTimeout(() => {
        if (pickedRef.current === picked) clearSelection();
      }, 1500);
    } catch {
      showNotice(t.contextFailed);
    }
  }, [docRef, picked, host, clearSelection, showNotice, t]);
  const ask = useCallback(
    async (question: string) => {
      const current = docRef.current;
      if (!current || !picked || !host.capabilities?.message) return false;
      const anchor = formatAnchor(current.info.path, picked.selection.at);
      const text = picked.selection.text;
      const quote = text ? `\n> ${clip(text, 800).replace(/\n/g, "\n> ")}` : "";
      try {
        const result = await host.app.sendMessage({
          role: "user",
          content: [
            {
              type: "text",
              text: wellFormed(
                `${question}\n\n(About ${anchor} in the ${PROFILE.title.en} viewer${quote ? ":" : "."})${quote}`,
              ),
            },
          ],
        });
        if (result.isError) throw new Error();
        if (pickedRef.current === picked) clearSelection();
        return true;
      } catch {
        showNotice(t.sendFailed);
        return false;
      }
    },
    [docRef, picked, host, clearSelection, showNotice, t],
  );
  const copy = useCallback(async () => {
    const text = picked?.selection.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [picked]);
  return { picked, barMode, setBarMode, copied, onSelect, clearSelection, addReference, ask, copy };
}
