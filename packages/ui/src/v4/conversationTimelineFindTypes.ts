import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnitsPartition } from "@/v4/conversationTurnRenderUnits.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";

export interface UseConversationTimelineFindOptions {
  rootRef: React.RefObject<HTMLElement | null>;
  /** 按「历史 + 尾轮」分区的 render unit；历史段引用在流式帧之间不变。 */
  renderUnits: ConversationTurnRenderUnitsPartition;
  rows: readonly ConversationRow[];
  mountedRowsKey: string;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder?: () => Promise<void> | void;
  sessionPhase?: SessionPhase;
  conversationFindQuery: string;
  conversationFindActiveIndex: number;
  conversationFindNavigationRequestId: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
  isMountedLayoutMeasured: () => boolean;
}
