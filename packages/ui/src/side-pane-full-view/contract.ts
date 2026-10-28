export type SidePaneFullViewSurface = "conversation" | "side-pane";
export type SidePaneFullViewFloating = "collapsed" | "expanded" | "minimized";
export type SidePaneFullViewHostMode = "normal" | "conversation" | "floating";

export interface SidePaneFullViewState {
  readonly surface: SidePaneFullViewSurface;
  readonly floating: SidePaneFullViewFloating;
}

export interface SidePaneFullViewController {
  readonly fullView: SidePaneFullViewState | null;
  enter(): void;
  exit(): void;
  toggle(): void;
  setSurface(surface: SidePaneFullViewSurface): void;
  setFloating(floating: SidePaneFullViewFloating): void;
}

export type FloatingAnchor =
  | "top-left"
  | "top-right"
  | "left-center"
  | "right-center"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface FloatingAnswer {
  readonly rowId: number;
  readonly text: string;
}

export interface ConversationPaneFloatingStatus {
  readonly running: boolean;
  readonly blockingInteractionId: string | null;
  readonly ownerKey: string;
  readonly latestTurn: {
    readonly turnKey: string | null;
    readonly running: boolean;
    readonly answer: FloatingAnswer | null;
  } | null;
}

export interface FloatingAnswerBubbleState {
  readonly seenTurnKey: string | null | undefined;
  readonly answer: FloatingAnswer | null;
}

export interface ConversationPanePresentationValue {
  readonly presentation: "docked" | "floating";
  readonly reportFloatingStatus: (status: ConversationPaneFloatingStatus) => void;
  readonly reportComposerDockHeight: (heightPx: number) => void;
}

export interface FloatingRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatingPosition {
  readonly left: number;
  readonly top: number;
}
