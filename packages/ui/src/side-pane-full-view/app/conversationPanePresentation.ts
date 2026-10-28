import { createContext, useContext } from "react";
import type { ConversationPanePresentationValue } from "../contract.js";

const noop = () => {};
const DOCKED: ConversationPanePresentationValue = {
  presentation: "docked",
  reportFloatingStatus: noop,
  reportComposerDockHeight: noop,
};
export const ConversationPanePresentationContext = createContext(DOCKED);
export function useConversationPanePresentation(): ConversationPanePresentationValue {
  return useContext(ConversationPanePresentationContext);
}
