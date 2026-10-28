# Side pane full view

Desktop-only presentation over the existing conversation workbench. The full-view controller is the only command owner and stores per-workspace/per-session records in `taskSidePaneMemory`; shell, host and pane components consume projections. Existing split layout, runtime leases, composer drafts and accepted input are unchanged.

Public entrypoints: `contract.ts`, `index.ts`. Domain provides pure geometry and complete-answer reducers; app admits memory commands; adapters observe DOM and local anchor preference; components render one permanently mounted conversation host. Geometry never becomes business state. Other panes remain mounted while a floating presentation shows the focused pane.

Closing the current owner's side panel removes only that owner's record. Owner switching does not imply closing. Unsupported Web/mobile surfaces have no handler or UI entry. Explicit entering while the panel is closed may store a record before the existing panel command opens it; the record is not effective until open.

See `.agents/specs/official-3.16.2-side-pane-full-view.md` for source pin, invariants and verification boundaries.
